import { sameCanvasContent } from "@/lib/canvas/canvas-content";
import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { getProjectFolderState, persistProjectToFolder, pickProjectRoot } from "@/services/browser-project-folder";
import { assertBrowserManifestWritable } from "@/services/browser-engine-migration";
import { isBrowserWorkspace } from "@/services/browser-workspace";

/** Compatibility for the old browser-only workspace. Never writes engine data
 * or changes authority when a local engine is disconnected. */
export async function mergeBrowserFolderProjects(projects: CanvasProject[], migrateCached = true) {
    if (!isBrowserWorkspace()) throw new Error("项目已使用本机引擎，请在引擎中管理项目文件夹。");
    projects.forEach(assertBrowserManifestWritable);
    const cached = [...useCanvasStore.getState().projects];
    cached.forEach(assertBrowserManifestWritable);
    const comparable = (project: CanvasProject) => JSON.parse(JSON.stringify(project, (_key, value) => typeof value === "string" && value.startsWith("blob:") ? "local-media-preview" : value)) as CanvasProject;
    for (const project of projects) {
        const current = cached.find((item) => item.id === project.id);
        if (current && !sameCanvasContent(comparable(current), comparable(project))) {
            const { preserveCanvasSyncDraft } = await import("@/services/canvas-sync-drafts");
            await preserveCanvasSyncDraft(current);
        }
    }
    const fromDisk = new Map(projects.map((project) => [project.id, project]));
    const deleted = new Set(getProjectFolderState().deletedProjectIds);
    const next = cached.filter((project) => !deleted.has(project.id)).map((project) => fromDisk.get(project.id) || project);
    projects.forEach((project) => { if (!cached.some((item) => item.id === project.id)) next.push(project); });
    useCanvasStore.setState({ projects: next });
    await flushCanvasStorePersistence();
    if (migrateCached) {
        const bound = getProjectFolderState().projectDirectories;
        for (const project of cached) if (!bound[project.id] && !deleted.has(project.id)) {
            const saved = await persistProjectToFolder(project);
            useCanvasStore.setState((state) => ({ projects: state.projects.map((current) => current.id === project.id ? { ...current, revision: saved.revision } : current) }));
        }
        await flushCanvasStorePersistence();
    }
    return projects;
}

export async function selectBrowserProjectRoot() {
    if (!isBrowserWorkspace()) throw new Error("请在本机引擎中选择项目根目录。");
    return mergeBrowserFolderProjects(await pickProjectRoot());
}
