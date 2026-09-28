import { expect, test } from "bun:test";
import { createProjectFolderStorage, type ProjectDirectoryHandle, type ProjectFolderManifest } from "../src/services/browser-project-folder";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";

class MemoryFile {
    readonly kind = "file" as const;
    blob = new Blob();
    constructor(public name: string, private owner: MemoryDirectory) {}
    async getFile() { return new File([this.blob], this.name, { type: this.blob.type }); }
    async createWritable() {
        let pending: Blob | undefined;
        return {
            write: async (data: Blob | string) => { pending = typeof data === "string" ? new Blob([data]) : data; },
            close: async () => {
                if (this.owner.failClose === this.name) throw new Error("disk full");
                this.blob = pending!;
                this.owner.writes.push(this.name);
            },
            abort: async () => { pending = undefined; },
        };
    }
}
class MemoryDirectory implements ProjectDirectoryHandle {
    readonly kind = "directory" as const;
    children = new Map<string, MemoryDirectory | MemoryFile>();
    permission: PermissionState = "granted";
    failClose = "";
    writes: string[] = [];
    constructor(public name: string) {}
    async queryPermission() { return this.permission; }
    async requestPermission() { return this.permission; }
    async *values() { yield* this.children.values(); }
    async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
        let child = this.children.get(name);
        if (!child && options?.create) { child = new MemoryDirectory(name); this.children.set(name, child); }
        if (!child) throw new DOMException("missing", "NotFoundError");
        if (child.kind !== "directory") throw new Error("not directory");
        return child;
    }
    async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFile> {
        let child = this.children.get(name);
        if (!child && options?.create) { child = new MemoryFile(name, this); this.children.set(name, child); }
        if (!child) throw new DOMException("missing", "NotFoundError");
        if (child.kind !== "file") throw new Error("not file");
        return child;
    }
}
const project = (id = "p-001"): CanvasProject => ({ id, title: "起司广告", createdAt: "2026-01-01", updatedAt: "2026-01-01", nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [] } as CanvasProject);
function fixture() {
    const root = new MemoryDirectory("qisiTV 项目");
    const blobs = new Map<string, Blob>();
    const drawingBundles = new Map<string, any>();
    const restoredDrawings = new Map<string, any>();
    let remembered: ProjectDirectoryHandle | null = null;
    let tail: Promise<unknown> = Promise.resolve();
    const locks: string[] = [];
    const dependencies = {
        supported: () => true,
        pick: async () => root,
        readHandle: async () => remembered,
        rememberHandle: async (handle: ProjectDirectoryHandle) => { remembered = handle; },
        readBlob: async (key: string) => blobs.get(key) || null,
        cacheBlob: async (key: string, blob: Blob) => { blobs.set(key, blob); return `blob:restored-${key}`; },
        readLocalUrl: async (url: string) => { const blob = blobs.get(url); if (!blob) throw new Error("expired local URL"); return blob; },
        readDrawing: async (_projectId: string, id: string) => drawingBundles.get(id) || null,
        cacheDrawing: async (_projectId: string, id: string, drawing: unknown) => { restoredDrawings.set(id, drawing); },
        lock: <T>(name: string, action: () => Promise<T>) => {
            locks.push(name);
            const result = tail.catch(() => undefined).then(action);
            tail = result;
            return result;
        },
    };
    return { root, blobs, drawingBundles, restoredDrawings, locks, create: () => createProjectFolderStorage(dependencies) };
}
async function manifest(root: MemoryDirectory, name: string) {
    return JSON.parse(await (await (await root.getDirectoryHandle(name)).getFileHandle("project.qisitv.json")).blob.text()) as ProjectFolderManifest;
}

test("creates real per-project directories, commits media before manifest, and restores without browser cache", async () => {
    const f = fixture();
    const storage = f.create();
    await expect(storage.ensureReady()).rejects.toThrow("选择项目");
    await storage.pick();
    const p = project();
    const first = await storage.persist(p);
    expect(first.revision).toBe(1);
    const directory = await f.root.getDirectoryHandle(first.directoryName);
    expect([...directory.children.keys()]).toContain("exports");
    f.blobs.set("generation-image:local:one", new Blob(["actual png bytes"], { type: "image/png" }));
    const updated = { ...p, revision: 1, agentTaskReceipts: { job: { fingerprint: "abc", nodeId: "n-1", state: "pending" } }, nodes: [{ id: "n-1", type: "image", metadata: { storageKey: "generation-image:local:one", content: "blob:old-image", apiKey: "DO-NOT-EXPORT", headers: { "X-API-Key": "hidden" } } }] } as unknown as CanvasProject;
    const second = await storage.persist(updated);
    const saved = await manifest(f.root, first.directoryName);
    expect(second.revision).toBe(2);
    expect(saved.project.nodes[0].metadata?.content).toMatch(/^images\/[a-f0-9]+\.png$/);
    expect(JSON.stringify(saved)).not.toContain("blob:");
    expect(JSON.stringify(saved)).not.toContain("DO-NOT-EXPORT");
    expect(JSON.stringify(saved)).not.toContain("X-API-Key");
    expect(directory.writes.at(-1)).toBe("project.qisitv.json");
    expect(saved.project.agentTaskReceipts?.job.fingerprint).toBe("abc");
    f.blobs.clear();
    const restarted = f.create();
    await restarted.initialize();
    const restored = await restarted.restore();
    expect(restored[0].revision).toBe(2);
    expect(restored[0].nodes[0].metadata?.content).toBe("blob:restored-generation-image:local:one");
    expect(await f.blobs.get("generation-image:local:one")?.text()).toBe("actual png bytes");
    const renamed = await restarted.persist({ ...restored[0], title: "新名称" });
    expect(renamed.directoryName).toBe(first.directoryName);
});

test("missing media and failed atomic close keep the previous manifest intact", async () => {
    const f = fixture();
    const storage = f.create();
    await storage.pick();
    const p = project();
    const saved = await storage.persist(p);
    await expect(storage.persist({ ...p, revision: 1, nodes: [{ id: "gone", type: "image", metadata: { storageKey: "image:missing", content: "blob:expired" } }] } as CanvasProject)).rejects.toThrow("尚未完整保存");
    expect((await manifest(f.root, saved.directoryName)).revision).toBe(1);
    const directory = await f.root.getDirectoryHandle(saved.directoryName);
    directory.failClose = "project.qisitv.json";
    await expect(storage.persist({ ...p, revision: 1, title: "not saved" })).rejects.toThrow("disk full");
    expect((await manifest(f.root, saved.directoryName)).project.title).toBe(p.title);
    directory.failClose = "";
    expect((await storage.persist({ ...p, revision: 1, title: "retry" })).revision).toBe(2);
});

test("LikeAI output keys use their generated media directories", async () => {
    const f = fixture();
    const storage = f.create();
    await storage.pick();
    const kinds = ["image", "video", "audio"] as const;
    const keys = kinds.map((kind) => `${kind}:local:likeai:task-123:0`);
    keys.forEach((key, index) => f.blobs.set(key, new Blob([kinds[index]], { type: `${kinds[index]}/${index === 0 ? "png" : index === 1 ? "mp4" : "mpeg"}` })));
    const saved = await storage.persist({ ...project(), nodes: keys.map((key, index) => ({ id: `n-${index}`, type: kinds[index], metadata: { storageKey: key, content: `blob:${index}` } })) } as CanvasProject);
    const document = await manifest(f.root, saved.directoryName);
    expect(keys.map((key) => document.media[key].path.split("/")[0])).toEqual(["images", "videos", "audio"]);
});

test("an interrupted first manifest creation remains retryable without losing media", async () => {
    const f = fixture();
    const storage = f.create();
    await storage.pick();
    const directory = await f.root.getDirectoryHandle("起司广告-p-001", { create: true });
    directory.failClose = "project.qisitv.json";
    await expect(storage.persist(project())).rejects.toThrow("disk full");
    directory.failClose = "";
    expect((await storage.persist(project())).revision).toBe(1);
});

test("independent tabs reject stale revisions inside the shared lock", async () => {
    const f = fixture();
    const one = f.create();
    await one.pick();
    const p = project();
    await one.persist(p);
    const two = f.create();
    await two.initialize();
    const [restored] = await two.restore();
    const results = await Promise.allSettled([one.persist({ ...p, revision: 1, title: "tab one" }), two.persist({ ...restored, title: "tab two" })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason.status).toBe(409);
    expect(f.locks.every((lock) => lock === "qisitv:project-folder:p-001")).toBe(true);
});

test("unsafe restored paths are rejected, and changed or missing media cannot silently restore", async () => {
    const f = fixture();
    const storage = f.create();
    await storage.pick();
    f.blobs.set("image:x", new Blob(["picture"], { type: "image/png" }));
    const saved = await storage.persist({ ...project(), nodes: [{ id: "n", type: "image", metadata: { storageKey: "image:x", content: "blob:x" } }] } as CanvasProject);
    const disk = await manifest(f.root, saved.directoryName);
    const directory = await f.root.getDirectoryHandle(saved.directoryName);
    const file = await directory.getFileHandle("project.qisitv.json");
    const originalPath = disk.media["image:x"].path;
    disk.media["image:x"].path = "../secret";
    file.blob = new Blob([JSON.stringify(disk)]);
    await expect(storage.restore()).rejects.toThrow("项目媒体路径");
    disk.media["image:x"].path = originalPath;
    file.blob = new Blob([JSON.stringify(disk)]);
    const [folder, name] = originalPath.split("/");
    (await (await directory.getDirectoryHandle(folder)).getFileHandle(name)).blob = new Blob(["edited"]);
    await expect(storage.restore()).rejects.toThrow("缺失或被修改");
});

test("permission revocation stops writes and soft deletion preserves the project directory", async () => {
    const f = fixture();
    const storage = f.create();
    await storage.pick();
    const p = project();
    const saved = await storage.persist(p);
    f.root.permission = "prompt";
    await expect(storage.persist({ ...p, revision: 1 })).rejects.toThrow("权限已失效");
    expect(storage.getState().ready).toBe(false);
    f.root.permission = "granted";
    await storage.reauthorize();
    const deleted = await storage.persist({ ...p, revision: 1 }, { deleted: true });
    expect(await storage.restore()).toEqual([]);
    expect(f.root.children.has(saved.directoryName)).toBe(true);
    expect((await manifest(f.root, saved.directoryName)).deletedAt).toBeTruthy();
    await storage.persist({ ...p, revision: deleted.revision });
    expect((await storage.restore())[0].id).toBe(p.id);
    expect((await manifest(f.root, saved.directoryName)).deletedAt).toBeUndefined();
});

test("drawing original, preview, render and unique exports survive a fresh cache", async () => {
    const f = fixture();
    const storage = f.create();
    await storage.pick();
    f.drawingBundles.set("drawing-1", {
        document: { version: 2, engine: "excalidraw", snapshot: { elements: [{ id: "shape" }] }, revision: 4, updatedAt: "today", shapeCount: 1, pageCount: 1 },
        preview: new Blob(["preview"], { type: "image/png" }),
        render: { blob: new Blob(["render"], { type: "image/png" }), version: 1, revision: 4, updatedAt: "today", pageId: "page", width: 100, height: 100, mimeType: "image/png", background: "white" },
    });
    await storage.persist({ ...project(), nodes: [{ id: "n", type: "drawing", metadata: { drawingId: "drawing-1", drawingRevision: 4 } }] } as CanvasProject);
    const a = await storage.exportFile("p-001", "movie.mp4", new Blob(["video"]));
    const b = await storage.exportFile("p-001", "movie.mp4", new Blob(["video2"]));
    expect(a).not.toBe(b);
    await expect(storage.exportFile("p-001", "../outside.mp4", new Blob())).rejects.toThrow("路径不安全");
    f.blobs.clear();
    f.drawingBundles.clear();
    const restarted = f.create();
    await restarted.initialize();
    await restarted.restore();
    const drawing = f.restoredDrawings.get("drawing-1");
    expect(drawing.document.snapshot.elements[0].id).toBe("shape");
    expect(await drawing.preview.text()).toBe("preview");
    expect(await drawing.render.blob.text()).toBe("render");
});
