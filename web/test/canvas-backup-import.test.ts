import { expect, test } from "bun:test";
import { importCanvasBackupProjects, importedCanvasMediaKey, importedCanvasNodeMetadata, remapImportedCanvasMedia } from "../src/services/canvas-backup-import";
import { findCanvasNodeAsset } from "../src/lib/canvas/canvas-node-asset";
import type { CanvasNodeData } from "../src/types/canvas";
import type { Asset } from "../src/stores/use-asset-store";
import type { CanvasProjectExportItem } from "../src/types/canvas-export";

const item = (title: string) => ({ project: { id: "original", title, nodes: [], connections: [] }, files: [] }) as unknown as CanvasProjectExportItem;

function fixture() {
    const projects = new Map([["original", "original data"]]);
    const saved: string[] = [];
    const events: string[] = [];
    const dependencies = {
        ensureReady: async () => { events.push("permission"); },
        create: (entry: CanvasProjectExportItem) => {
            const id = `copy-${entry.project.title}`;
            projects.set(id, "new data");
            events.push(`create:${id}`);
            return id;
        },
        restore: async (id: string) => { events.push(`media:${id}`); },
        persist: async (id: string) => { saved.push(id); events.push(`disk:${id}`); },
        discard: async (id: string) => { projects.delete(id); events.push(`discard:${id}`); },
    };
    return { projects, saved, events, dependencies };
}

test("does not advance to the next project until the authoritative save completes", async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const completed = importCanvasBackupProjects([item("one"), item("two")], {
        ...f.dependencies,
        persist: async (id) => { if (id === "copy-one") { entered(); await gate; } await f.dependencies.persist(id); },
    });
    await started;
    expect(f.projects.has("copy-one")).toBe(true);
    expect(f.projects.has("copy-two")).toBe(false);
    expect(f.saved).toEqual([]);
    release();
    const result = await completed;
    expect(result.completed.map((entry) => entry.id)).toEqual(["copy-one", "copy-two"]);
    expect(f.saved).toEqual(["copy-one", "copy-two"]);
    expect(f.projects.get("original")).toBe("original data");
});

test("missing folder permission stops before creating or restoring any project", async () => {
    const f = fixture();
    const result = await importCanvasBackupProjects([item("one"), item("two")], {
        ...f.dependencies,
        ensureReady: async () => { throw new Error("请先授权项目文件夹"); },
    });
    expect(result.completed).toEqual([]);
    expect(result.remaining).toBe(1);
    expect(result.failed?.error).toEqual(new Error("请先授权项目文件夹"));
    expect([...f.projects.keys()]).toEqual(["original"]);
    expect(f.events).toEqual([]);
});

test("disk failure retains committed projects, removes only the failed copy and skips remaining entries", async () => {
    const f = fixture();
    const result = await importCanvasBackupProjects([item("one"), item("two"), item("three")], {
        ...f.dependencies,
        persist: async (id) => { if (id === "copy-two") throw new Error("disk full"); await f.dependencies.persist(id); },
    });
    expect(result.completed).toEqual([{ id: "copy-one", title: "one" }]);
    expect(result.failed?.title).toBe("two");
    expect(result.remaining).toBe(1);
    expect([...f.projects.keys()]).toEqual(["original", "copy-one"]);
    expect(f.saved).toEqual(["copy-one"]);
});

test("media restore failure never reaches disk commit and cleanup failure is reported", async () => {
    const f = fixture();
    const result = await importCanvasBackupProjects([item("one")], {
        ...f.dependencies,
        restore: async () => { throw new Error("missing media"); },
        discard: async () => { throw new Error("cache unavailable"); },
    });
    expect(result.completed).toEqual([]);
    expect(result.failed?.error).toEqual(new Error("missing media"));
    expect(result.failed?.cleanupError).toEqual(new Error("cache unavailable"));
    expect(f.saved).toEqual([]);
});

test("permissions are rechecked between imports and already saved work remains available", async () => {
    const f = fixture();
    const result = await importCanvasBackupProjects([item("one"), item("two")], {
        ...f.dependencies,
        ensureReady: async () => { if (f.saved.length) throw new Error("permission revoked"); },
    });
    expect(result.completed).toHaveLength(1);
    expect(result.failed?.title).toBe("two");
    expect(f.projects.has("copy-two")).toBe(false);
    expect(f.saved).toEqual(["copy-one"]);
});

test("reimported media cannot overwrite an original or previous import's cache key", () => {
    const blobs = new Map([["image:original", "original bytes"]]);
    const first = importedCanvasMediaKey("new-project-1", 0, "image/png");
    const second = importedCanvasMediaKey("new-project-2", 0, "image/png");
    blobs.set(first, "backup bytes");
    blobs.set(second, "second backup bytes");
    expect(blobs.size).toBe(3);
    expect(blobs.get("image:original")).toBe("original bytes");
    expect(importedCanvasMediaKey("new-project-1", 1, "video/mp4")).toStartWith("video:");
});

test("remaps media in nodes, scene panoramas, chat attachments and timeline without reusing asset IDs", () => {
    const media = { storageKey: "image:old", url: "blob:expired", assetId: "original-asset" };
    const source = {
        nodes: [{ metadata: { ...media, content: "blob:expired", prompt: "keep this prompt" } }],
        directorScenes: [{ panorama: media }],
        chatSessions: [{ attachments: [{ ...media, dataUrl: "blob:expired" }] }],
        timeline: { clips: [{ directMedia: media }] },
    };
    const restored = remapImportedCanvasMedia(source, new Map([["image:old", { storageKey: "image:import:new:0", url: "blob:import" }]]));
    expect(restored.nodes[0].metadata.content).toBe("blob:import");
    expect(restored.nodes[0].metadata.prompt).toBe("keep this prompt");
    expect(restored.directorScenes[0].panorama.storageKey).toBe("image:import:new:0");
    expect(restored.chatSessions[0].attachments[0].dataUrl).toBe("blob:import");
    expect(restored.timeline.clips[0].directMedia.url).toBe("blob:import");
    expect(JSON.stringify(restored)).not.toContain("original-asset");
    expect(JSON.stringify(restored)).not.toContain("blob:expired");
    expect(source.nodes[0].metadata.storageKey).toBe("image:old");
});

test("an incomplete archive cannot silently borrow original-project media from cache", () => {
    expect(() => remapImportedCanvasMedia({ metadata: { storageKey: "image:existing" } }, new Map())).toThrow("备份缺少");
});

test("zero-file archives cannot succeed by silently clearing expired media URLs", () => {
    for (const type of ["image", "video", "audio"]) {
        expect(() => remapImportedCanvasMedia({ nodes: [{ type, metadata: { content: "blob:expired" } }] }, new Map())).toThrow("缺少原文件");
    }
});

test("imported generated nodes cannot resolve to the source task's asset", () => {
    const original = {
        id: "source-node", type: "image", title: "generated image", position: { x: 0, y: 0 }, width: 320, height: 240,
        metadata: { storageKey: "image:old", content: "blob:old", taskId: "old-task", taskStatus: "success", assetId: "old-asset", generationEffectKeys: ["old-commit"] },
    } as CanvasNodeData;
    const oldAsset = { id: "old-asset", kind: "image", data: { storageKey: "image:old", dataUrl: "blob:old" }, metadata: { taskId: "old-task", nodeId: original.id, canvasId: "original" } } as unknown as Asset;
    const remapped = remapImportedCanvasMedia(original, new Map([["image:old", { storageKey: "image:import:copy:0", url: "blob:copy" }]]));
    expect(findCanvasNodeAsset([oldAsset], remapped, "copy")).toBe(oldAsset);
    const independent = { ...remapped, metadata: importedCanvasNodeMetadata(remapped) };
    expect(findCanvasNodeAsset([oldAsset], independent, "copy")).toBeUndefined();
    expect(independent.metadata.taskId).toBeUndefined();
    expect(independent.metadata.generationEffectKeys).toBeUndefined();
    expect(independent.metadata.content).toBe("blob:copy");
});
