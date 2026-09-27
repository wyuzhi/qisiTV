import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { CanvasNodeType } from "../src/types/canvas";
import { applyAgentCanvasPatch, mergeAgentCanvasDocument, mergeAgentCanvasEditor } from "../src/lib/canvas/agent-canvas-patch";

// Execute the real repository with isolated I/O. This avoids globally mocking
// Zustand or fetch, which would affect unrelated tests in Bun's shared process.
const dir = mkdtempSync(join(import.meta.dir, ".local-agent-sync-"));
const ioPath = join(dir, "io.ts");
writeFileSync(ioPath, `
export type CanvasProject = any;
export type Asset = any;
export const state = { projects: [] as any[], remote: undefined as any, puts: [] as any[],
  drafts: [] as any[], events: [] as any[], progress: new Map(), listeners: new Set<Function>(),
  put: undefined as undefined | ((path: string, body: any) => Promise<any>) };
const getState = () => ({ projects: state.projects,
  openProject: (id: string) => state.projects.find((p) => p.id === id) ?? null,
  updateProject: (id: string, patch: any) => { state.projects = state.projects.map((p) => p.id === id ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p); },
  createProject: () => { throw new Error('Unexpected create'); },
  deleteProjects: (ids: string[]) => { state.projects = state.projects.filter((p) => !ids.includes(p.id)); },
});
export const useCanvasStore = { getState, setState: (update: any) => {
  const patch = typeof update === 'function' ? update(getState()) : update;
  if (patch.projects) state.projects = patch.projects;
} };
export const flushCanvasStorePersistence = async () => {};
export const useCanvasHistoryStore = { getState: () => ({ recordDeletedProjects: () => {} }) };
export const useAssetStore = { getState: () => ({ assets: [] }) };
export const resourceIdFromStorageKey = () => '';
export const isLocalWorkspaceMode = () => true;
export const useSyncProgressStore = { getState: () => ({ setProjectProgress: (id: string, value: any) => {
  state.progress.set(id, value === null ? null : { ...state.progress.get(id), ...value });
} }) };
export const preserveCanvasSyncDraft = async (project: any) => { state.drafts.push(structuredClone(project)); return state.drafts.length; };
export const publishCanvasRefresh = (project: any, previous: any) => {
  for (const listener of state.listeners) listener(project, previous);
  state.events.push({ project: structuredClone(project), previous: structuredClone(previous) });
};
export const http = {
  get: async () => ({ project: structuredClone(state.remote) }),
  put: async (path: string, body: any) => {
    const snapshot = structuredClone(body);
    state.puts.push({ path, body: snapshot });
    if (state.put) return state.put(path, snapshot);
    const saved = { ...snapshot.project, revision: (snapshot.project.revision ?? 0) + 1 };
    state.remote = saved;
    return { project: { id: saved.id, title: saved.title, createdAt: saved.createdAt, updatedAt: saved.updatedAt, revision: saved.revision } };
  },
  delete: async () => {},
};
`);
let source = readFileSync(new URL("../src/services/local-workspace-repository.ts", import.meta.url), "utf8");
for (const module of [
    "@/stores/canvas/use-canvas-store", "@/stores/canvas/use-canvas-history-store", "@/services/api/request",
    "@/services/api/resources", "@/stores/use-asset-store", "@/services/workspace-mode",
    "@/services/canvas-workspace-events", "@/stores/use-sync-progress-store", "@/services/canvas-sync-drafts",
]) source = source.replaceAll(JSON.stringify(module), JSON.stringify(pathToFileURL(ioPath).href));
writeFileSync(join(dir, "repository.ts"), source);
const repository: typeof import("../src/services/local-workspace-repository") = await import(join(dir, "repository.ts"));
const { state } = await import(ioPath);

let nextId = 0;
const project = (): CanvasProject => ({
    id: `agent-sync-${++nextId}`, revision: 1, title: "Local canvas",
    createdAt: "2026-09-26T08:00:00.000Z", updatedAt: "2026-09-26T08:00:00.000Z",
    nodes: [{ id: "one", title: "Frame", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100,
        updatedAt: "2026-09-26T08:00:00.000Z", metadata: { prompt: "Original" } }],
    connections: [], chatSessions: [], activeChatId: null,
    backgroundMode: "grid", showImageInfo: true, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [],
});
function replace(project: CanvasProject) { state.projects = [structuredClone(project)]; }
function current(): CanvasProject { return state.projects[0]; }
async function seed() {
    const base = project();
    replace(base);
    state.remote = structuredClone(base);
    await repository.openLocalCanvasProjectFromBackend(base.id);
    state.events.length = 0;
    return base;
}
function summary(project: CanvasProject, revision: number) {
    return { project: { id: project.id, title: project.title, createdAt: project.createdAt, updatedAt: project.updatedAt, revision } };
}
function conflict() { return Object.assign(new Error("Revision conflict"), { status: 409 }); }
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}
beforeEach(() => {
    state.projects = []; state.remote = undefined; state.puts = []; state.put = undefined;
    state.events = []; state.drafts = []; state.progress.clear(); state.listeners.clear();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("local Agent concurrent canvas synchronization", () => {
    it("rebases a 409 once, preserving a local drag and a remote added node", async () => {
        const base = await seed();
        const dragged = { ...base.nodes[0]!, position: { x: 250, y: 75 }, updatedAt: "2026-09-26T09:00:00.000Z" };
        replace({ ...base, nodes: [dragged], updatedAt: dragged.updatedAt! });
        const added = { ...base.nodes[0]!, id: "agent-added", title: "Agent result" };
        state.remote = { ...base, revision: 2, nodes: [...base.nodes, added], updatedAt: "2026-09-26T10:00:00.000Z" };
        state.put = async (_path: string, body: { project: CanvasProject }) => {
            if (state.puts.length === 1) throw conflict();
            expect(body.project.revision).toBe(2);
            expect(body.project.nodes).toEqual([dragged, added]);
            return summary(body.project, 3);
        };
        await repository.syncLocalCanvasProjectToBackend(base.id);
        expect(state.puts).toHaveLength(2);
        expect(current().revision).toBe(3);
        expect(current().nodes).toEqual([dragged, added]);
        expect(state.drafts).toHaveLength(0);
    });

    it("keeps same-field conflicts and a recovery draft without retrying an overwrite", async () => {
        const base = await seed();
        const local = { ...base, nodes: [{ ...base.nodes[0]!, metadata: { prompt: "Local prompt" } }], updatedAt: "2026-09-26T09:00:00.000Z" };
        replace(local);
        state.remote = { ...base, revision: 2, nodes: [{ ...base.nodes[0]!, metadata: { prompt: "Agent prompt" } }], updatedAt: "2026-09-26T10:00:00.000Z" };
        state.put = async () => { throw conflict(); };
        await expect(repository.syncLocalCanvasProjectToBackend(base.id)).rejects.toThrow("冲突");
        expect(current()).toEqual(local);
        expect(state.puts).toHaveLength(1);
        expect(state.events).toHaveLength(0);
        expect(state.drafts[0]).toEqual(local);
        expect(state.progress.get(base.id).phase).toBe("conflict");
    });

    it("preserves edits during PUT and saves them in the next serialized request", async () => {
        const base = await seed();
        const first = { ...base, title: "First save", updatedAt: "2026-09-26T09:00:00.000Z" };
        replace(first);
        const received = deferred<void>();
        const response = deferred<ReturnType<typeof summary>>();
        state.put = async (_path: string, body: { project: CanvasProject }) => {
            if (state.puts.length === 1) { received.resolve(); return response.promise; }
            expect(body.project.title).toBe("Edited during save");
            expect(body.project.revision).toBe(2);
            return summary(body.project, 3);
        };
        const firstSave = repository.syncLocalCanvasProjectToBackend(base.id);
        await received.promise;
        replace({ ...first, title: "Edited during save", updatedAt: "2026-09-26T10:00:00.000Z" });
        const nextSave = repository.syncLocalCanvasProjectToBackend(base.id);
        response.resolve(summary(first, 2));
        await Promise.all([firstSave, nextSave]);
        expect(current().title).toBe("Edited during save");
        expect(current().revision).toBe(3);
        expect(state.puts).toHaveLength(2);
    });

    it("merges a refresh into unsaved live editor drag without claiming it was already saved", async () => {
        const base = await seed();
        const dragged = { ...base.nodes[0]!, position: { x: 490, y: 120 } };
        let liveNodes = [dragged];
        const added = { ...base.nodes[0]!, id: "agent-added" };
        state.listeners.add((incoming: CanvasProject, previous: CanvasProject) => {
            liveNodes = mergeAgentCanvasEditor(previous, incoming, liveNodes, []).nodes;
        });
        state.remote = { ...base, revision: 2, nodes: [...base.nodes, added], updatedAt: "2026-09-26T10:00:00.000Z" };
        await repository.refreshLocalCanvasProjectIfChanged(base.id);
        expect(liveNodes).toEqual([dragged, added]);
        expect(current().nodes).toEqual([base.nodes[0]!, added]);
        expect(current().revision).toBe(2);
        // The ordinary lifecycle snapshot records the live editor's still-dirty
        // graph before saving; the remote addition must survive that write.
        replace({ ...current(), nodes: liveNodes, updatedAt: "2026-09-26T11:00:00.000Z" });
        await repository.syncLocalCanvasProjectToBackend(base.id);
        expect(state.puts[0].body.project.nodes).toEqual([dragged, added]);
    });

    it("rejects live-editor same-field conflicts before advancing the store baseline", async () => {
        const base = await seed();
        const liveNodes = [{ ...base.nodes[0]!, title: "Unsaved editor title" }];
        state.listeners.add((incoming: CanvasProject, previous: CanvasProject) => {
            mergeAgentCanvasEditor(previous, incoming, liveNodes, []);
        });
        state.remote = { ...base, revision: 2, nodes: [{ ...base.nodes[0]!, title: "Agent title" }], updatedAt: "2026-09-26T10:00:00.000Z" };
        await expect(repository.refreshLocalCanvasProjectIfChanged(base.id)).rejects.toThrow("冲突");
        expect(current()).toEqual(base);
        expect(liveNodes[0]!.title).toBe("Unsaved editor title");
        expect(state.progress.get(base.id).phase).toBe("conflict");
    });

    it("preserves divergent offline content when opening without a common baseline", async () => {
        const base = project();
        const local = { ...base, title: "Offline edit", updatedAt: "2026-09-26T09:00:00.000Z" };
        replace(local);
        state.remote = { ...base, revision: 2, title: "Later Agent edit", updatedAt: "2026-09-26T10:00:00.000Z" };
        await repository.openLocalCanvasProjectFromBackend(base.id);
        const preserved = current().title === local.title || state.drafts.some((draft: CanvasProject) => draft.title === local.title);
        expect(preserved).toBe(true);
    });

    it("does not discard edits made while preserving a conflict copy", async () => {
        const base = await seed();
        replace({ ...base, title: "Copy snapshot" });
        state.remote = { ...base, revision: 2, title: "Agent version" };
        const received = deferred<void>();
        const response = deferred<ReturnType<typeof summary>>();
        let copied: CanvasProject | undefined;
        state.put = async (_path: string, body: { project: CanvasProject }) => {
            copied = body.project;
            received.resolve();
            return response.promise;
        };
        const preserving = repository.keepLocalCanvasCopyAndLoadLatest(base.id);
        await received.promise;
        replace({ ...current(), title: "Edited while copy saves", updatedAt: "2026-09-26T11:00:00.000Z" });
        response.resolve(summary(copied!, 1));
        await preserving.catch(() => undefined);
        const preserved = state.projects.some((p: CanvasProject) => p.title === "Edited while copy saves") ||
            state.drafts.some((p: CanvasProject) => p.title === "Edited while copy saves");
        expect(preserved).toBe(true);
    });

    it("does not resurrect a deleted node by replaying an older revision", () => {
        const base = project();
        const deleted = { ...base, revision: 3, nodes: [] };
        const replay = applyAgentCanvasPatch(deleted, {
            canvasId: base.id, baseRevision: 1, revision: 2, updatedAt: "2026-09-26T08:01:00.000Z",
            nodes: [{ before: null, after: base.nodes[0]! }], connections: [],
        });
        expect(replay.nodes).toHaveLength(0);
        expect(replay.revision).toBe(3);
    });

    it("orders mixed Go and browser timestamp precision chronologically", () => {
        const base = project();
        const local = { ...base, updatedAt: "2026-09-26T09:00:00Z",
            nodes: [{ ...base.nodes[0]!, position: { x: 4, y: 7 }, updatedAt: "2026-09-26T09:00:00Z" }] };
        const remote = { ...base, revision: 2, updatedAt: "2026-09-26T09:00:00.123456789Z",
            nodes: [{ ...base.nodes[0]!, title: "Remote title", updatedAt: "2026-09-26T09:00:00.123456789Z" }] };
        const merged = mergeAgentCanvasDocument(base, remote, local);
        expect(merged.updatedAt).toBe(remote.updatedAt);
        expect(merged.nodes[0]!.updatedAt).toBe(remote.nodes[0]!.updatedAt);
        expect(merged.nodes[0]!.position).toEqual(local.nodes[0]!.position);
    });
});
