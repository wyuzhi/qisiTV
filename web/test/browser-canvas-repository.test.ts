import { beforeEach, expect, mock, test } from "bun:test";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import type { ProjectFolderState } from "../src/services/browser-project-folder";

let scope = "browser-test";
let browser = true;
let projects: CanvasProject[] = [];
let flushes = 0;
let flush = async () => {};
let history: CanvasProject[] = [];
let folder: ProjectFolderState;
let initialize = async () => folder;
let write = async (_project: CanvasProject, _options?: { deleted?: boolean }) => ({ revision: 7, directoryName: "qisitv-test" });
const writes: Array<{ project: CanvasProject; deleted?: boolean }> = [];
const progress = new Map<string, Record<string, unknown>>();
const state = () => ({
    projects,
    openProject: (id: string) => projects.find(project => project.id === id),
    deleteProjects: (ids: string[]) => { projects = projects.filter(project => !ids.includes(project.id)); },
});
mock.module("@/lib/user-scope", () => ({ getActiveUserScope: () => scope }));
mock.module("@/services/browser-workspace", () => ({ isBrowserWorkspace: () => browser }));
mock.module("@/services/browser-project-folder", () => ({
    getProjectFolderState: () => folder,
    initializeProjectFolder: () => initialize(),
    persistProjectToFolder: async (project: CanvasProject, options?: { deleted?: boolean }) => { writes.push({ project, deleted: options?.deleted }); return write(project, options); },
    restoreFolderProjects: async () => [],
}));
mock.module("@/stores/canvas/use-canvas-store", () => ({
    useCanvasStore: { getState: state, setState: (updater: (current: ReturnType<typeof state>) => { projects: CanvasProject[] }) => { projects = updater(state()).projects; } },
    flushCanvasStorePersistence: async () => { flushes++; await flush(); },
}));
mock.module("@/stores/canvas/use-canvas-history-store", () => ({ useCanvasHistoryStore: { getState: () => ({ recordDeletedProjects: (items: CanvasProject[]) => { history.push(...items); } }) } }));
mock.module("@/stores/use-sync-progress-store", () => ({
    projectSyncProgress: (id: string) => progress.get(`${scope}\0${id}`),
    useSyncProgressStore: { getState: () => ({ setProjectProgress: (id: string, value: Record<string, unknown> | null, owner: string) => { const key = `${owner}\0${id}`; if (value) progress.set(key, { ...progress.get(key), ...value }); else progress.delete(key); } }) },
}));
const { persistBrowserCanvas, deleteBrowserCanvases, hydrateBrowserCanvases, readBrowserCanvas } = await import("../src/services/browser-canvas-repository");
const project = (id: string) => ({ id, title: "网页草稿", nodes: [], connections: [], revision: 0, createdAt: 1, updatedAt: 1 }) as unknown as CanvasProject;

beforeEach(() => {
    scope = "browser-test"; browser = true; projects = []; flushes = 0; history = []; writes.length = 0; progress.clear();
    flush = async () => {};
    folder = { supported: false, ready: false, status: "unsupported", rootName: "", projectDirectories: {}, deletedProjectIds: [] };
    initialize = async () => folder;
    write = async () => ({ revision: 7, directoryName: "qisitv-test" });
});

test("a canvas is usable without directory support and reports only browser persistence", async () => {
    projects = [project("draft")];
    await persistBrowserCanvas("draft");
    expect(flushes).toBe(1);
    expect(writes).toHaveLength(0);
    expect(readBrowserCanvas("draft")?.title).toBe("网页草稿");
    expect(progress.get("browser-test\0draft")).toMatchObject({ phase: "done", storageTarget: "browser-cache" });
    expect(await hydrateBrowserCanvases()).toBe(false);
});

test("a real directory acknowledgement advances revision without overwriting newer live edits", async () => {
    projects = [project("folder")];
    folder = { ...folder, supported: true, ready: true, status: "ready", rootName: "Projects" };
    write = async () => { projects = [{ ...projects[0], title: "保存时继续编辑" }]; return { revision: 7, directoryName: "qisitv-folder" }; };
    await persistBrowserCanvas("folder");
    expect(projects[0]).toMatchObject({ title: "保存时继续编辑", revision: 7 });
    expect(writes).toHaveLength(1);
    expect(flushes).toBe(2);
    expect(progress.get("browser-test\0folder")).toMatchObject({ phase: "done", storageTarget: "project-folder" });
});

test("reload confirms restored browser drafts and restores their browser-only save status", async () => {
    projects = [project("restored")];
    expect(progress.size).toBe(0);
    expect(await hydrateBrowserCanvases()).toBe(false);
    expect(flushes).toBe(1);
    expect(writes).toHaveLength(0);
    expect(progress.get("browser-test\0restored")).toMatchObject({ phase: "done", storageTarget: "browser-cache" });
});

test("reload never reports cache success when a selected directory needs reauthorization", async () => {
    projects = [project("restored-revoked")];
    folder = { ...folder, supported: true, status: "permission-required", rootName: "Projects" };
    await expect(hydrateBrowserCanvases()).rejects.toThrow("权限已失效");
    expect(flushes).toBe(1);
    expect(writes).toHaveLength(0);
    expect(progress.get("browser-test\0restored-revoked")).toMatchObject({ phase: "error", storageTarget: undefined });
});

test("revoked directory permission preserves the browser draft but does not report a successful save", async () => {
    projects = [project("revoked")];
    folder = { ...folder, supported: true, status: "permission-required", rootName: "Projects" };
    await expect(persistBrowserCanvas("revoked")).rejects.toThrow("权限已失效");
    expect(flushes).toBe(1);
    expect(writes).toHaveLength(0);
    expect(progress.get("browser-test\0revoked")).toMatchObject({ phase: "error", storageTarget: undefined });
});

test("directory write errors never become cache-only success", async () => {
    projects = [project("failed")];
    folder = { ...folder, supported: true, ready: true, status: "ready", rootName: "Projects" };
    write = async () => { throw new Error("disk full"); };
    await expect(persistBrowserCanvas("failed")).rejects.toThrow("disk full");
    expect(projects).toHaveLength(1);
    expect(progress.get("browser-test\0failed")).toMatchObject({ phase: "error", storageTarget: undefined });
});

test("engine-owned documents cannot enter browser writes or deletion", async () => {
    projects = [{ ...project("owned"), engineAuthority: { kind: "local-engine", workspaceId: "native" } } as CanvasProject];
    await expect(persistBrowserCanvas("owned")).rejects.toThrow("本机引擎接管");
    await expect(deleteBrowserCanvases(["owned"])).rejects.toThrow("本机引擎接管");
    expect(flushes).toBe(0);
    expect(writes).toHaveLength(0);
    expect(projects).toHaveLength(1);
});

test("changing the workspace during folder initialization prevents writes to the new owner", async () => {
    projects = [project("switched")];
    initialize = async () => { scope = "different"; return folder; };
    await expect(persistBrowserCanvas("switched")).rejects.toThrow("工作区已改变");
    expect(flushes).toBe(0);
    expect(writes).toHaveLength(0);
    expect(progress.has("different\0switched")).toBe(false);
});

test("browser draft deletion records local history without contacting a native repository", async () => {
    projects = [project("delete")];
    expect(await deleteBrowserCanvases(["delete"])).toHaveLength(1);
    expect(projects).toHaveLength(0);
    expect(history).toHaveLength(1);
    expect(writes).toHaveLength(0);
    expect(flushes).toBe(1);
});

test("failed directory tombstones leave the live canvas intact", async () => {
    projects = [project("delete-failed")];
    folder = { ...folder, supported: true, ready: true, status: "ready", rootName: "Projects" };
    write = async () => { throw new Error("cannot delete"); };
    await expect(deleteBrowserCanvases(["delete-failed"])).rejects.toThrow("cannot delete");
    expect(writes[0].deleted).toBe(true);
    expect(projects).toHaveLength(1);
    expect(history).toHaveLength(0);
});

test("failed browser-cache deletion keeps the editable document and no false recovery receipt", async () => {
    projects = [project("quota")];
    flush = async () => { throw new Error("IndexedDB unavailable"); };
    await expect(deleteBrowserCanvases(["quota"])).rejects.toThrow("IndexedDB unavailable");
    expect(projects.map(item => item.id)).toEqual(["quota"]);
    expect(history).toHaveLength(0);
});

test("switching owner during a deletion flush cannot record or restore data in the next workspace", async () => {
    projects = [project("previous-owner")];
    flush = async () => { scope = "next-owner"; projects = [project("new-owner")]; throw new Error("old write failed"); };
    await expect(deleteBrowserCanvases(["previous-owner"])).rejects.toThrow("old write failed");
    expect(projects.map(item => item.id)).toEqual(["new-owner"]);
    expect(history).toHaveLength(0);
});
