import { getActiveUserScope } from "@/lib/user-scope";
import { isBrowserWorkspace } from "@/services/browser-workspace";
import { assertBrowserManifestWritable } from "@/services/browser-engine-migration";
import { getProjectFolderState, initializeProjectFolder, persistProjectToFolder, restoreFolderProjects } from "@/services/browser-project-folder";
import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import { projectSyncProgress, useSyncProgressStore } from "@/stores/use-sync-progress-store";

const saves = new Map<string, Promise<void>>();
const deleting = new Set<string>();

function assertOwner(scope: string) {
    if (!isBrowserWorkspace() || getActiveUserScope() !== scope) throw new DOMException("网页工作区已改变，请重新操作", "AbortError");
}

export function readBrowserCanvas(id: string) {
    const project = useCanvasStore.getState().openProject(id);
    if (project) assertBrowserManifestWritable(project);
    return project;
}

export function browserCanvasSavePending(id: string) {
    const progress = projectSyncProgress(id);
    return saves.has(`${getActiveUserScope()}\0${id}`) || Boolean(progress && progress.phase !== "done");
}

/** An unbound canvas is a browser draft. A chosen folder remains authoritative:
 * lost permission or a failed write never becomes a successful cache-only save. */
export function persistBrowserCanvas(id: string): Promise<void> {
    const scope = getActiveUserScope();
    const key = `${scope}\0${id}`;
    const run = (saves.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        assertOwner(scope);
        if (deleting.has(key)) throw new Error("网页画布正在删除");
        const project = readBrowserCanvas(id);
        if (!project) throw new Error("网页画布不存在");
        useSyncProgressStore.getState().setProjectProgress(id, { phase: "saving", storageTarget: undefined, message: "正在保存网页画布" }, scope);
        await initializeProjectFolder();
        assertOwner(scope);
        // Preserve an editable draft even when its selected directory is offline.
        await flushCanvasStorePersistence();
        assertOwner(scope);
        const folder = getProjectFolderState();
        if (folder.rootName && !folder.ready) throw new Error("项目文件夹权限已失效；修改仅暂存在浏览器，请重新授权后保存。");
        if (folder.ready) {
            const saved = await persistProjectToFolder(project);
            assertOwner(scope);
            useCanvasStore.setState((state) => ({ projects: state.projects.map((current) => current.id === id ? { ...current, revision: Math.max(current.revision ?? 0, saved.revision) } : current) }));
            await flushCanvasStorePersistence();
            assertOwner(scope);
            useSyncProgressStore.getState().setProjectProgress(id, { phase: "done", storageTarget: "project-folder", message: "已写入项目文件夹" }, scope);
        } else {
            useSyncProgressStore.getState().setProjectProgress(id, { phase: "done", storageTarget: "browser-cache", message: "已暂存在此浏览器，尚未写入项目文件夹" }, scope);
        }
    });
    const tail = run.catch((error: unknown) => {
        useSyncProgressStore.getState().setProjectProgress(id, { phase: "error", storageTarget: undefined, message: error instanceof Error ? error.message : "网页画布保存失败" }, scope);
        throw error;
    }).finally(() => { if (saves.get(key) === tail) saves.delete(key); });
    saves.set(key, tail);
    return tail;
}

export async function hydrateBrowserCanvases() {
    const scope = getActiveUserScope();
    await initializeProjectFolder();
    assertOwner(scope);
    if (!getProjectFolderState().ready) {
        // Progress is intentionally session-only. Reconfirm restored drafts
        // through the same awaited cache boundary after a reload; a remembered
        // directory with revoked permission still fails this save explicitly.
        for (const project of useCanvasStore.getState().projects) await persistBrowserCanvas(project.id);
        return false;
    }
    const projects = await restoreFolderProjects();
    assertOwner(scope);
    const { mergeBrowserFolderProjects } = await import("@/services/browser-folder-workspace");
    await mergeBrowserFolderProjects(projects, false);
    assertOwner(scope);
    for (const project of projects) useSyncProgressStore.getState().setProjectProgress(project.id, { phase: "done", storageTarget: "project-folder", message: "已写入项目文件夹" }, scope);
    return true;
}

export async function deleteBrowserCanvases(ids: readonly string[]) {
    const scope = getActiveUserScope();
    const removed: CanvasProject[] = [];
    for (const id of new Set(ids)) {
        const key = `${scope}\0${id}`;
        if (deleting.has(key)) throw new Error("网页画布正在删除");
        deleting.add(key);
        try {
            assertOwner(scope);
            await saves.get(key)?.catch(() => undefined);
            assertOwner(scope);
            const project = readBrowserCanvas(id);
            if (!project) continue;
            await initializeProjectFolder();
            assertOwner(scope);
            const folder = getProjectFolderState();
            if (folder.rootName) {
                if (!folder.ready) throw new Error("请先恢复项目文件夹权限，再删除项目。");
                await persistProjectToFolder(project, { deleted: true });
                assertOwner(scope);
            }
            useCanvasStore.getState().deleteProjects([id]);
            try { await flushCanvasStorePersistence(); }
            catch (error) {
                if (isBrowserWorkspace() && getActiveUserScope() === scope && !folder.rootName && !useCanvasStore.getState().openProject(id)) useCanvasStore.setState((state) => ({ projects: [...state.projects, project] }));
                throw error;
            }
            assertOwner(scope);
            useCanvasHistoryStore.getState().recordDeletedProjects([project]);
            useSyncProgressStore.getState().setProjectProgress(id, null, scope);
            removed.push(project);
        } finally { deleting.delete(key); }
    }
    return removed;
}
