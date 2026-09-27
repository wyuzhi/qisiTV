import { applyAgentCanvasPatch, type AgentCanvasPatch } from "@/lib/canvas/agent-canvas-patch";
import { rebindInconsistentCanvasAssets, type CanvasAssetRebindResult } from "@/services/canvas-asset-repair";
import { createLocalCanvasProject, deleteLocalCanvasProjects, openLocalCanvasProject, openLocalCanvasProjectFromBackend, refreshLocalCanvasProjectIfChanged, syncLocalCanvasProjectToBackend } from "@/services/local-workspace-repository";
import { flushAssetStorePersistence, useAssetStore, type Asset } from "@/stores/use-asset-store";
import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { publishCanvasRefresh } from "@/services/canvas-workspace-events";
export { subscribeAgentCanvasRefresh } from "@/services/canvas-workspace-events";

export { isLocalWorkspaceMode } from "@/services/workspace-mode";

let operationTail: Promise<void> = Promise.resolve();

/**
 * Backward-compatible local persistence facade.
 *
 * Call sites keep their historical function names while the implementation
 * contains no account, cloud snapshot, upload queue, conflict baseline or
 * retry machinery. New code should use the workspace repositories directly.
 */
export function hasRemoteUserDataSyncSession() {
    return false;
}

export function withRemoteUserDataSyncExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = operationTail.then(operation, operation);
    operationTail = next.then(() => undefined, () => undefined);
    return next;
}

export async function loadCanvasProjectForEditing(
    id: string,
    options: { latest?: boolean; historyRestore?: { snapshotId: string; revision: number }; onLoad?: (project: CanvasProject) => void } = {},
) {
    const project = await openLocalCanvasProjectFromBackend(id);
    if (project) options.onLoad?.(project);
    return project || undefined;
}

export async function refreshCanvasAfterAgent(id: string) {
    await refreshLocalCanvasProjectIfChanged(id);
    const project = openLocalCanvasProject(id);
    if (!project) throw new Error("本地画布不存在");
    return project;
}

/** Ensure the local canvas snapshot is visible to the co-packaged Go Agent.
 * Local editing intentionally avoids the hosted sync queue, but Agent tools
 * execute against the Go repository and still need the current snapshot. */
export async function syncLocalCanvasForAgent(id: string) {
    const project = openLocalCanvasProject(id);
    if (!project) throw new Error("本地画布不存在");
    await syncLocalCanvasProjectToBackend(id);
    return openLocalCanvasProject(id)!;
}

/**
 * Persist an editor snapshot to the co-packaged Go repository.  Local edits
 * normally stay in IndexedDB for instant UI feedback, but the Go repository
 * is also read by MCP/SSE.  Callers that mutate the canvas outside the normal
 * save flow (for example node deletion) must use this bridge or the next
 * remote refresh can resurrect the stale server snapshot.
 */
export async function syncLocalCanvasSnapshotForAgent(id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "appearance" | "backgroundMode" | "showImageInfo" | "viewport">>) {
    const current = openLocalCanvasProject(id);
    if (!current) throw new Error("本地画布不存在");
    useCanvasStore.getState().updateProject(id, patch);
    await syncLocalCanvasProjectToBackend(id);
    return openLocalCanvasProject(id)!;
}

export async function applyAgentCanvasPatches(id: string, patches: AgentCanvasPatch[]) {
    return withRemoteUserDataSyncExclusive(async () => {
        const current = openLocalCanvasProject(id);
        if (!current) throw new Error("本地画布不存在");
        let projected = current;
        for (const patch of patches) projected = applyAgentCanvasPatch(projected, patch);
        if (projected === current) return current;
        publishCanvasRefresh(projected, current);
        useCanvasStore.setState((state) => ({ projects: state.projects.map((project) => project.id === id ? projected : project) }));
        await flushCanvasStorePersistence();
        return projected;
    });
}

type LocalAssetPageOptions = {
    page: number;
    pageSize: number;
    kind?: string;
    category?: string;
    folderId?: string;
    uncategorized?: boolean;
    status?: string;
    query?: string;
    signal?: AbortSignal;
};

export async function loadAssetLibraryPage(options: LocalAssetPageOptions) {
    if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const query = options.query?.trim().toLowerCase() || "";
    const filtered = useAssetStore.getState().assets.filter((asset) => {
        if (options.kind && asset.kind !== options.kind) return false;
        if (options.category && asset.category !== options.category) return false;
        if (options.status && asset.status !== options.status) return false;
        if (options.folderId && asset.folderId !== options.folderId) return false;
        if (options.uncategorized && asset.folderId) return false;
        if (!query) return true;
        return [asset.title, asset.source, ...(asset.tags || [])].join(" ").toLowerCase().includes(query);
    });
    const start = Math.max(0, options.page - 1) * options.pageSize;
    const countBy = (key: (asset: Asset) => string | undefined) => filtered.reduce<Record<string, number>>((counts, asset) => {
        const value = key(asset) || "";
        counts[value] = (counts[value] || 0) + 1;
        return counts;
    }, {});
    return {
        assets: filtered.slice(start, start + options.pageSize),
        kindCounts: countBy((asset) => asset.kind),
        categoryCounts: countBy((asset) => asset.category),
        folderCounts: countBy((asset) => asset.folderId),
        page: options.page,
        pageSize: options.pageSize,
        total: filtered.length,
        hasMore: start + options.pageSize < filtered.length,
    };
}

export async function loadAssetsForUse(ids: Iterable<string>) {
    const available = new Set(useAssetStore.getState().assets.map((asset) => asset.id));
    if ([...new Set(ids)].some((id) => !available.has(id))) throw new Error("部分本地素材不存在，请重新选择素材");
}

export function localSavedRemotePendingMessage(localAction: string, error: unknown) {
    const detail = error instanceof Error && error.message.trim() ? error.message.trim() : "未知错误";
    return `${localAction}失败：${detail}`;
}

export async function createCanvasProjectWithRemoteSync(
    title: string,
    projectId?: string,
    initialContent?: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId">>,
): Promise<{ id: string; syncError?: unknown }> {
    return { ...await createLocalCanvasProject(title, projectId, initialContent), syncError: undefined };
}

export async function deleteAssetWithRemoteSync(id: string) {
    const assetId = id.trim();
    if (!assetId) throw new Error("素材 ID 不能为空");
    await useAssetStore.getState().removeAsset(assetId);
    await flushAssetStorePersistence();
}

export function deleteCanvasProjectsWithRemoteSync(ids: string[]) {
    return deleteLocalCanvasProjects(ids);
}

/** Legacy save name retained while callers migrate to workspace repositories. */
export async function saveRemoteUserDataNow(_input?: string | readonly string[] | { force?: boolean }) {
    await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence()]);
}

export function scheduleRemoteUserDataSync() {
    void saveRemoteUserDataNow().catch((error) => console.error("本地工作区保存失败", error));
}

export async function forceOverwriteRemoteCanvasSync(): Promise<CanvasAssetRebindResult> {
    const result = rebindInconsistentCanvasAssets(useAssetStore.getState().assets);
    await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence()]);
    return result;
}
