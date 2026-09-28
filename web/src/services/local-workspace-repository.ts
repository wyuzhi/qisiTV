import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import { http } from "@/services/api/request";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { mergeAgentCanvasDocument } from "@/lib/canvas/agent-canvas-patch";
import { sameCanvasContent } from "@/lib/canvas/canvas-content";
import { publishCanvasRefresh } from "@/services/canvas-workspace-events";
import { useSyncProgressStore } from "@/stores/use-sync-progress-store";
import { isBrowserWorkspace } from "@/services/browser-workspace";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { CANVAS_HISTORY_STORE_KEY } from "@/stores/canvas/use-canvas-history-store";

type LocalCanvasContent = Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId">>;
type CanvasSaveSummary = Pick<CanvasProject, "id" | "title" | "createdAt" | "updatedAt" | "revision">;

const backendSaveTails = new Map<string, Promise<void>>();
const backendSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const backendBaselines = new Map<string, CanvasProject>();

function serializeCanvasOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (backendSaveTails.get(id) || Promise.resolve()).catch(() => undefined).then(operation);
    const tail = next.then(() => undefined, () => undefined);
    backendSaveTails.set(id, tail);
    void tail.then(() => { if (backendSaveTails.get(id) === tail) backendSaveTails.delete(id); });
    return next;
}

function rememberBackendProject(project: CanvasProject) {
    backendBaselines.set(project.id, structuredClone(project));
}

async function applyBackendProject(remote: CanvasProject) {
    const current = openLocalCanvasProject(remote.id);
    const baseline = backendBaselines.get(remote.id);
    if (baseline && (remote.revision ?? 0) < (baseline.revision ?? 0)) return current;
    let merged: CanvasProject;
    if (current && baseline && baseline.revision === current.revision) {
        merged = mergeAgentCanvasDocument(baseline, remote, current);
    } else {
        merged = selectPreferredCanvasProject(current, remote);
        // After a browser restart there is no common in-memory baseline. An
        // updatedAt comparison cannot prove that the cached version is clean.
        // Preserve it durably before accepting a different backend document.
        if (current && !sameCanvasContent(current, remote) && merged === remote) {
            const { preserveCanvasSyncDraft } = await import("@/services/canvas-sync-drafts");
            const draftCount = await preserveCanvasSyncDraft(current);
            // Do not overwrite edits made while IndexedDB was writing the copy.
            if (!sameCanvasContent(current, openLocalCanvasProject(remote.id) || undefined)) {
                throw new Error("保存副本期间画布又有编辑，本地内容已保留，请重试同步");
            }
            useSyncProgressStore.getState().setProjectProgress(remote.id, { phase: "done", draftCount, message: "已载入较新画布，之前的本地内容保留在版本记录中。" });
        }
        if (current && merged === current && (current.revision ?? 0) < (remote.revision ?? 0) && !sameCanvasContent(current, remote)) {
            throw new Error("画布存在离线编辑和更新的服务端版本；本地内容已保留，请在版本记录中检查后再同步");
        }
    }
    if (!current || !sameCanvasContent(current, merged) || JSON.stringify(current.viewport) !== JSON.stringify(merged.viewport)) {
        // Notify the live editor before committing; a same-field conflict must
        // leave both its in-flight edits and the last common baseline intact.
        publishCanvasRefresh(merged, current || undefined);
    }
    useCanvasStore.setState((state) => ({ projects: current
        ? state.projects.map((project) => project.id === remote.id ? merged : project)
        : [...state.projects, merged] }));
    rememberBackendProject(remote);
    return merged;
}

async function reportCanvasSaveError(id: string, error: unknown) {
    const detail = error instanceof Error ? error.message : "画布保存失败";
    const conflict = /冲突|离线编辑/.test(detail) || (error as { status?: number })?.status === 409;
    useSyncProgressStore.getState().setProjectProgress(id, { phase: conflict ? "conflict" : "error", message: detail });
    const current = openLocalCanvasProject(id);
    if (conflict && current) {
        const { preserveCanvasSyncDraft } = await import("@/services/canvas-sync-drafts");
        const draftCount = await preserveCanvasSyncDraft(current);
        useSyncProgressStore.getState().setProjectProgress(id, { draftCount });
    }
}

function resourceIdFromLocator(value?: string) {
    const storageID = resourceIdFromStorageKey(value);
    if (storageID) return storageID;
    return value?.match(/\/api\/resources\/([^/?#]+)\/file(?:[?#]|$)/)?.[1] || "";
}

function assetResourceId(asset: Asset) {
    if (!("storageKey" in asset.data)) return "";
    return resourceIdFromLocator(asset.data.storageKey);
}

export function canvasGenerationCommitAssets(project: CanvasProject, assets: Asset[]) {
    const resourceIDs = new Set<string>();
    for (const node of project.nodes) {
        if (node.type !== "image" && node.type !== "video" && node.type !== "audio") continue;
        const resourceID = resourceIdFromLocator(node.metadata?.storageKey) || resourceIdFromLocator(node.metadata?.content);
        if (resourceID) resourceIDs.add(resourceID);
    }
    return assets.filter((asset) => resourceIDs.has(assetResourceId(asset)));
}

export function bindCanvasGenerationCommitAssets(project: CanvasProject, assets: Asset[]): CanvasProject {
    const assetByResource = new Map<string, string>();
    for (const asset of assets) {
        const resourceID = assetResourceId(asset);
        if (resourceID) assetByResource.set(resourceID, asset.id);
    }
    return {
        ...project,
        nodes: project.nodes.map((node) => {
            if (node.type !== "image" && node.type !== "video" && node.type !== "audio") return node;
            const resourceID = resourceIdFromLocator(node.metadata?.storageKey) || resourceIdFromLocator(node.metadata?.content);
            const assetId = assetByResource.get(resourceID);
            return assetId ? { ...node, metadata: { ...node.metadata, assetId } } : node;
        }),
    };
}

function projectUpdatedAt(project: CanvasProject) {
    const timestamp = Date.parse(project.updatedAt);
    return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Resolve the browser/desktop dual-store snapshot without allowing an older
 * backend response to erase edits that have already been persisted locally.
 * Unknown/equal versions intentionally keep the local copy: data preservation
 * is safer than treating a backend read as authoritative without evidence that
 * it is newer.
 */
export function selectPreferredCanvasProject(local: CanvasProject | null | undefined, backend: CanvasProject) {
    if (!local) return backend;
    const localUpdatedAt = projectUpdatedAt(local);
    const backendUpdatedAt = projectUpdatedAt(backend);
    if (backendUpdatedAt !== localUpdatedAt) return backendUpdatedAt > localUpdatedAt ? backend : local;
    const localRevision = local.revision ?? 0;
    const backendRevision = backend.revision ?? 0;
    if (backendRevision !== localRevision) return backendRevision > localRevision ? backend : local;
    return local;
}

/**
 * Local workspace persistence boundary.
 *
 * The local Go runtime owns durable state. IndexedDB retains unsaved edits
 * when that runtime is unavailable; no hosted account or cloud sync is used.
 */
export async function createLocalCanvasProject(title: string, projectId?: string, initialContent?: LocalCanvasContent, workspaceProjectId?: string) {
    const id = useCanvasStore.getState().createProject(title, projectId, workspaceProjectId);
    if (initialContent) useCanvasStore.getState().updateProject(id, initialContent);
    if (isBrowserWorkspace()) {
        await syncLocalCanvasProjectToBackend(id);
        return { id };
    }
    // The in-memory project is already usable. Do not make navigation depend
    // on an IndexedDB/localForage flush completing successfully; the store
    // keeps its pending write queue and will retry it on the next flush.
    // Desktop restarts hydrate from the co-packaged Go repository. Creating a
    // project only in IndexedDB leaves the runtime returning 404 and allows its
    // detached-resource cleanup to delete media that the canvas still uses.
    await syncLocalCanvasProjectToBackend(id);
    // IndexedDB is an offline cache, not the desktop source of truth. A stuck
    // WebKit storage transaction must never block navigation after the Go
    // repository has durably accepted the project.
    void flushCanvasStorePersistence().catch((error) => {
        console.error("画布本地缓存写入失败，已保存到桌面数据库", { id, error });
    });
    return { id };
}

/** Serialize writes per canvas so optimistic revisions cannot race each other. */
function syncLocalCanvasProject(id: string, includeGeneratedAssets: boolean): Promise<void> {
    return serializeCanvasOperation(id, async () => {
      try {
        let project = openLocalCanvasProject(id);
        if (!project) return;
        if (isBrowserWorkspace()) {
            const previousRevision = project.revision ?? 0;
            const revision = previousRevision + 1;
            useCanvasStore.setState((state) => ({ projects: state.projects.map((current) => current.id === id ? { ...current, revision } : current) }));
            try {
                await flushCanvasStorePersistence();
            } catch (error) {
                useCanvasStore.setState((state) => ({ projects: state.projects.map((current) => current.id === id && current.revision === revision ? { ...current, revision: previousRevision } : current) }));
                throw error;
            }
            useSyncProgressStore.getState().setProjectProgress(id, null);
            return;
        }
        const assets = includeGeneratedAssets ? canvasGenerationCommitAssets(project, useAssetStore.getState().assets) : [];
        let projectForSave = includeGeneratedAssets ? bindCanvasGenerationCommitAssets(project, assets) : project;
        const endpoint = includeGeneratedAssets ? `/canvas-projects/${encodeURIComponent(id)}/generated-assets` : `/canvas-projects/${encodeURIComponent(id)}`;
        const save = () => http.put<{ project: CanvasSaveSummary }>(endpoint, includeGeneratedAssets ? { project: projectForSave, assets } : { project: projectForSave });
        let response: { project: CanvasSaveSummary };
        try { response = await save(); }
        catch (error) {
            if ((error as { status?: number })?.status !== 409 || !backendBaselines.has(id)) throw error;
            const latest = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
            const rebased = await applyBackendProject(latest.project);
            if (!rebased) throw error;
            project = rebased;
            projectForSave = includeGeneratedAssets ? bindCanvasGenerationCommitAssets(project, assets) : project;
            // One bounded retry for disjoint edits. Another conflict is surfaced.
            response = await save();
        }
        const saved = response.project;
        if (!saved) return;
        rememberBackendProject({ ...projectForSave, ...saved });
        useCanvasStore.setState((state) => ({
            projects: state.projects.map((current) => current.id === id
                // Preserve edits made while the request was in flight; only the
                // server-owned optimistic revision must advance.
                ? {
                    ...(includeGeneratedAssets ? bindCanvasGenerationCommitAssets(current, assets) : current),
                    revision: saved.revision,
                    ...(current.updatedAt === project.updatedAt ? { updatedAt: saved.updatedAt } : {}),
                }
                : current),
        }));
        void flushCanvasStorePersistence().catch((error) => {
            console.error("画布本地缓存写入失败，已保存到桌面数据库", { id, error });
        });
        useSyncProgressStore.getState().setProjectProgress(id, null);
      } catch (error) {
        await reportCanvasSaveError(id, error).catch(() => undefined);
        throw error;
      }
    });
}

export function syncLocalCanvasProjectToBackend(id: string): Promise<void> {
    return syncLocalCanvasProject(id, false);
}

type CanvasDocumentPersistPatch = Partial<Pick<CanvasProject, "nodes" | "connections" | "timeline">>;

function sameDocumentValue(left: unknown, right: unknown) {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function revertUnchangedCanvasNodes(
    previous: CanvasProject["nodes"],
    attempted: CanvasProject["nodes"],
    live: CanvasProject["nodes"],
): CanvasProject["nodes"] {
    if (sameDocumentValue(live, attempted)) return previous;
    const previousById = new Map(previous.map((node) => [node.id, node]));
    const attemptedById = new Map(attempted.map((node) => [node.id, node]));
    const reverted: CanvasProject["nodes"] = [];
    for (const node of live) {
        const before = previousById.get(node.id);
        const optimistic = attemptedById.get(node.id);
        if (!before && optimistic) {
            if (sameDocumentValue(node, optimistic)) continue;
            reverted.push(node);
            continue;
        }
        if (before && optimistic) {
            reverted.push(sameDocumentValue(node, optimistic) ? before : node);
            continue;
        }
        reverted.push(node);
    }
    return reverted;
}

function revertUnchangedCanvasDocumentPatch(current: CanvasProject, previous: CanvasProject, patch: CanvasDocumentPersistPatch): CanvasProject {
    const next: CanvasProject = { ...current };
    (Object.keys(patch) as Array<keyof CanvasDocumentPersistPatch>).forEach((key) => {
        if (key === "nodes") {
            if (!patch.nodes) return;
            next.nodes = revertUnchangedCanvasNodes(previous.nodes, patch.nodes, current.nodes);
            return;
        }
        const attempted = patch[key];
        if (attempted === undefined) return;
        if (sameDocumentValue(current[key], attempted)) {
            (next as Record<string, unknown>)[key] = previous[key];
        }
    });
    return next;
}

/**
 * Persist a canvas document patch before the caller reports success.
 * Local desktop hydrates from SQLite, so that profile PUTs the Go repository
 * without waiting on IndexedDB. Hosted keeps update plus an awaited flush.
 * A failed write only reverts patch fields that nobody else changed.
 */
export async function persistCanvasDocument(id: string, patch: CanvasDocumentPersistPatch) {
    const previous = useCanvasStore.getState().openProject(id);
    useCanvasStore.getState().updateProject(id, patch);
    const attempted = useCanvasStore.getState().openProject(id);
    try {
        if (isLocalWorkspaceMode()) {
            await syncLocalCanvasProjectToBackend(id);
            return;
        }
        await flushCanvasStorePersistence();
    } catch (error) {
        if (previous) {
            useCanvasStore.setState((state) => ({
                projects: state.projects.map((item) => {
                    if (item.id !== id) return item;
                    const reverted = revertUnchangedCanvasDocumentPatch(item, previous, patch);
                    if (attempted && item.updatedAt === attempted.updatedAt) reverted.updatedAt = previous.updatedAt;
                    return reverted;
                }),
            }));
        }
        throw error;
    }
}

/** Timeline edits live on the canvas document. */
export async function persistCanvasTimeline(id: string, timeline: NonNullable<CanvasProject["timeline"]>) {
    await persistCanvasDocument(id, { timeline });
}

export function syncLocalCanvasGenerationProjectToBackend(id: string): Promise<void> {
    return syncLocalCanvasProject(id, true);
}

export function scheduleLocalCanvasBackendSync(id: string) {
    const existing = backendSaveTimers.get(id);
    if (existing) clearTimeout(existing);
    backendSaveTimers.set(id, setTimeout(() => {
        backendSaveTimers.delete(id);
        void syncLocalCanvasProjectToBackend(id).catch((error) => console.error("画布后端持久化失败，等待下次编辑重试", { id, error }));
    }, 500));
}

export function openLocalCanvasProject(id: string) {
    return useCanvasStore.getState().openProject(id);
}

/**
 * Best-effort bridge for the browser preview. The Go local runtime is the
 * canonical store when it is available; IndexedDB remains the offline
 * fallback so a stopped backend never prevents the UI from opening.
 */
export async function hydrateLocalCanvasProjectsFromBackend() {
    if (isBrowserWorkspace()) return useCanvasStore.getState().projects.length > 0;
    try {
        const response = await http.get<{ projects: Array<Pick<CanvasProject, "id">> }>("/canvas-projects", {
            params: { page: 1, pageSize: 500, sort: "updated" },
        });
        const summaries = Array.isArray(response.projects) ? response.projects : [];
        if (summaries.length === 0) return false;
        const projects = (await Promise.all(summaries.map(async (summary) => {
            try {
                const detail = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(summary.id)}`);
                return detail.project;
            } catch {
                return undefined;
            }
        }))).filter((project): project is CanvasProject => Boolean(project));
        if (projects.length === 0) return false;
        for (const project of projects) {
            try { await applyBackendProject(project); }
            catch (error) { await reportCanvasSaveError(project.id, error).catch(() => undefined); }
        }
        await flushCanvasStorePersistence();
        return true;
    } catch {
        return false;
    }
}

export async function openLocalCanvasProjectFromBackend(id: string) {
    if (isBrowserWorkspace()) return openLocalCanvasProject(id);
    try {
        const response = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
        const backendProject = response.project;
        if (!backendProject) return openLocalCanvasProject(id);
        const project = await applyBackendProject(backendProject);
        await flushCanvasStorePersistence();
        return project;
    } catch (error) {
        await reportCanvasSaveError(id, error).catch(() => undefined);
        return openLocalCanvasProject(id);
    }
}

export async function refreshLocalCanvasProjectIfChanged(id: string) {
    if (isBrowserWorkspace()) return false;
    return serializeCanvasOperation(id, async () => {
      try {
        const response = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
        const remote = response.project;
        if (!remote || remote.revision === backendBaselines.get(id)?.revision) return false;
        const project = await applyBackendProject(remote);
        void flushCanvasStorePersistence().catch(() => undefined);
        if (project && !sameCanvasContent(project, remote)) scheduleLocalCanvasBackendSync(id);
        return project;
      } catch (error) {
        await reportCanvasSaveError(id, error).catch(() => undefined);
        throw error;
      }
    });
}

export async function flushLocalWorkspace() {
    await flushCanvasStorePersistence();
}

/** Explicit user resolution: durably keep both versions before reloading. */
export function keepLocalCanvasCopyAndLoadLatest(id: string) {
    if (isBrowserWorkspace()) return Promise.reject(new Error("当前使用浏览器本地画布，没有需要覆盖的服务器版本"));
    const timer = backendSaveTimers.get(id);
    if (timer) clearTimeout(timer);
    backendSaveTimers.delete(id);
    return serializeCanvasOperation(id, async () => {
        const current = openLocalCanvasProject(id);
        if (!current) throw new Error("本地画布不存在");
        const remote = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
        const copyId = crypto.randomUUID();
        const copy: CanvasProject = {
            ...current, id: copyId, revision: 0, workspaceProjectId: copyId,
            title: `${current.title}（本地副本）`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        const saved = await http.put<{ project: CanvasSaveSummary }>(`/canvas-projects/${copyId}`, { project: copy });
        const durableCopy = { ...copy, ...saved.project };
        if (!sameCanvasContent(current, openLocalCanvasProject(id) || undefined)) {
            useCanvasStore.setState((state) => ({ projects: [...state.projects, durableCopy] }));
            await flushCanvasStorePersistence();
            throw new Error("副本已保存，但期间又有新的本地编辑；请停止编辑后重试，新增内容已保留");
        }
        useCanvasStore.setState((state) => ({ projects: [
            ...state.projects.map((project) => project.id === id ? remote.project : project), durableCopy,
        ] }));
        rememberBackendProject(remote.project);
        rememberBackendProject(durableCopy);
        await flushCanvasStorePersistence();
        useSyncProgressStore.getState().setProjectProgress(id, null);
        return copyId;
    });
}

export async function deleteLocalCanvasProjects(ids: readonly string[]) {
    const selected = new Set(ids);
    const snapshots = useCanvasStore.getState().projects.filter((project) => selected.has(project.id));
    useCanvasStore.getState().deleteProjects([...ids]);
    if (snapshots.length) useCanvasHistoryStore.getState().recordDeletedProjects(snapshots);
    if (isBrowserWorkspace()) {
        // Preserve the recovery snapshot before acknowledging permanent removal
        // from the active canvas collection.
        await localForageStorageForScope().setItem(CANVAS_HISTORY_STORE_KEY, JSON.stringify({ state: { deletedProjects: useCanvasHistoryStore.getState().deletedProjects }, version: 0 }));
        await flushCanvasStorePersistence();
        return snapshots;
    }
    await flushCanvasStorePersistence();
    await Promise.all(ids.map(async (id) => {
        try {
            await http.delete(`/canvas-projects/${encodeURIComponent(id)}`);
        } catch (error) {
            console.error("画布后端删除失败", { id, error });
            throw error;
        }
    }));
    return snapshots;
}
