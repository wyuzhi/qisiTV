import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createBrowserModelConfigStorage } from "../src/services/browser-model-config-storage";
import { createModelChannel, defaultConfig } from "../src/stores/use-config-store";

// Exercise the real Zustand queue/revision implementation against a deterministic
// async storage contract; every attempted backend call fails this fixture.
const dir = mkdtempSync(join(import.meta.dir, ".browser-workspace-"));
const storagePath = join(dir, "storage.ts");
const storePath = join(dir, "store.ts");
const historyPath = join(dir, "history.ts");
const requestPath = join(dir, "request.ts");
const modePath = join(dir, "mode.ts");
const folderPath = join(dir, "folder.ts");
const url = (path: string) => JSON.stringify(pathToFileURL(path).href);

writeFileSync(storagePath, `
export const records = new Map<string, string>();
let failWrites = false;
export const rejectWrites = (value: boolean) => { failWrites = value; };
export const storage = {
 getItem: async (key: string) => records.get(key) ?? null,
 setItem: async (key: string, value: string) => { if (failWrites) throw new Error("quota exceeded"); records.set(key, value); },
 removeItem: async (key: string) => { records.delete(key); },
};
export const localForageStorageForScope = () => storage;
`);
writeFileSync(requestPath, `
export let requests = 0;
const forbidden = async () => { requests++; throw new Error("Go backend must not be called"); };
export const http = { get: forbidden, put: forbidden, delete: forbidden };
`);
writeFileSync(modePath, "export const isBrowserWorkspace = () => true;\n");
writeFileSync(folderPath, `
const projects = new Map();
let failWrites = false;
export const rejectWrites = (value: boolean) => { failWrites = value; };
export const ensureFolderReady = async () => undefined;
export const initializeProjectFolder = async () => ({ ready: true });
export const getProjectFolderState = () => ({ projectDirectories: Object.fromEntries([...projects.keys()].map(id => [id, id])) });
export const restoreFolderProjects = async () => [...projects.values()].filter(item => !item.deleted).map(item => structuredClone(item.project));
export const pickProjectRoot = restoreFolderProjects;
export const persistProjectToFolder = async (project: any, options: any = {}) => {
 if (failWrites) throw new Error("disk full");
 const revision = (projects.get(project.id)?.project.revision || 0) + 1;
 projects.set(project.id, { project: structuredClone({ ...project, revision }), deleted: options.deleted });
 return { revision, directoryName: project.id };
};
`);
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
writeFileSync(storePath, source("../src/stores/canvas/use-canvas-store.ts").replaceAll('"@/lib/localforage-storage"', url(storagePath)));
writeFileSync(historyPath, source("../src/stores/canvas/use-canvas-history-store.ts").replaceAll('"@/lib/localforage-storage"', url(storagePath)));
writeFileSync(join(dir, "repository.ts"), source("../src/services/local-workspace-repository.ts")
    .replaceAll('"@/stores/canvas/use-canvas-store"', url(storePath))
    .replaceAll('"@/stores/canvas/use-canvas-history-store"', url(historyPath))
    .replaceAll('"@/services/api/request"', url(requestPath))
    .replaceAll('"@/services/browser-workspace"', url(modePath))
    .replaceAll('"@/services/browser-project-folder"', url(folderPath))
    .replaceAll('"@/lib/localforage-storage"', url(storagePath)));
for (const name of ["workspace", "appearance"]) {
    writeFileSync(join(dir, `${name}.ts`), source(`../src/services/api/${name}.ts`)
        .replaceAll('"@/services/api/request"', url(requestPath))
        .replaceAll('"@/services/browser-workspace"', url(modePath)));
}

const repository: typeof import("../src/services/local-workspace-repository") = await import(join(dir, "repository.ts"));
const store: typeof import("../src/stores/canvas/use-canvas-store") = await import(storePath);
const history: typeof import("../src/stores/canvas/use-canvas-history-store") = await import(historyPath);
const storage = await import(storagePath);
const request = await import(requestPath);
const folder = await import(folderPath);
const workspace: typeof import("../src/services/api/workspace") = await import(join(dir, "workspace.ts"));
const appearance: typeof import("../src/services/api/appearance") = await import(join(dir, "appearance.ts"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("browser startup resolves local workspace and branding without an API server", async () => {
    const bootstrap = await workspace.getWorkspaceBootstrap();
    expect(bootstrap.workspace.storage).toBe("indexeddb");
    expect(bootstrap.user.id).toBe("local");
    expect(bootstrap.features?.pluginCenterEnabled).toBe(false);
    const brand = await appearance.getPublicAppearance();
    expect(brand.brandName).toBe("qisiTV");
    expect(brand.authVideoUrl).toBe("");
    expect(request.requests).toBe(0);
});

test("browser canvas create, edit, restore from project folder and soft delete need no Go request", async () => {
    await store.useCanvasStore.persist.rehydrate();
    const { id } = await repository.createLocalCanvasProject("网页画布");
    expect(repository.openLocalCanvasProject(id)?.revision).toBe(1);
    const nodes = [{ id: "text-1", type: "text", x: 12, y: 24, width: 300, height: 100, metadata: { content: "保存在本机" } }] as any;
    await repository.persistCanvasDocument(id, { nodes });
    expect(repository.openLocalCanvasProject(id)?.revision).toBe(2);
    await store.flushCanvasStorePersistence();
    store.withCanvasStorePersistenceSuppressed(() => store.useCanvasStore.setState({ projects: [] }));
    storage.records.clear();
    await repository.hydrateLocalCanvasProjectsFromBackend();
    expect((await repository.openLocalCanvasProjectFromBackend(id))?.nodes).toEqual(nodes);
    expect(await repository.hydrateLocalCanvasProjectsFromBackend()).toBe(true);
    expect(await repository.refreshLocalCanvasProjectIfChanged(id)).toBe(false);
    await repository.deleteLocalCanvasProjects([id]);
    store.withCanvasStorePersistenceSuppressed(() => store.useCanvasStore.setState({ projects: [] }));
    await store.useCanvasStore.persist.rehydrate();
    await history.useCanvasHistoryStore.persist.rehydrate();
    expect(repository.openLocalCanvasProject(id)).toBeNull();
    expect(history.useCanvasHistoryStore.getState().deletedProjects.find((item) => item.id === id)?.project?.nodes).toEqual(nodes);
    expect(request.requests).toBe(0);
});

test("folder write failure is surfaced while pending canvas edits remain retryable", async () => {
    const { id } = await repository.createLocalCanvasProject("保存失败测试");
    folder.rejectWrites(true);
    await expect(repository.persistCanvasDocument(id, { nodes: [{ id: "failed-node", type: "text", metadata: { content: "待保存" } }] as any })).rejects.toThrow("disk full");
    expect(repository.openLocalCanvasProject(id)?.revision).toBe(1);
    expect(repository.openLocalCanvasProject(id)?.nodes[0].metadata?.content).toBe("待保存");
    folder.rejectWrites(false);
    await repository.syncLocalCanvasProjectToBackend(id);
    await store.flushCanvasStorePersistence();
    expect(request.requests).toBe(0);
});

test("browser model configuration round-trips locally and enforces optimistic revisions", async () => {
    const records = new Map<string, string>();
    const data = {
        getItem: async (key: string) => records.get(key) ?? null,
        setItem: async (key: string, value: string) => { records.set(key, value); },
        removeItem: async (key: string) => { records.delete(key); },
    };
    const first = createBrowserModelConfigStorage(data);
    const config = { ...defaultConfig, channels: [createModelChannel({ id: "likeai", apiFormat: "likeai", apiKey: "test-only-local-key", models: ["doubao_seedance_2_5"] })] };
    expect((await first.read()).revision).toBe(0);
    expect(await first.write(config, 0)).toEqual({ saved: true, revision: 1 });
    const reloaded = createBrowserModelConfigStorage(data);
    expect((await reloaded.read()).config.channels[0].apiKey).toBe("test-only-local-key");
    expect((await reloaded.read()).config.channels[0].models).toEqual(["doubao_seedance_2_5"]);
    await expect(reloaded.write(config, 0)).rejects.toMatchObject({ status: 409 });
    expect((await reloaded.read()).revision).toBe(1);
});
