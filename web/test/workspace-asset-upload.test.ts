import { afterEach, expect, mock, test } from "bun:test";
import { setActiveUserScope } from "@/lib/user-scope";

const writes: Array<{ title: string; folderId?: string; kind?: string; data?: Record<string, unknown> }> = [];
let uploads: string[] = [];
let uploadKinds: Array<{ name: string; prefix?: string }> = [];
let release: () => void;
let gate: Promise<void>;
let persistCount = 0;
let persistError: Error | undefined;
let failedName = "";
function resetGate() { gate = new Promise<void>((resolve) => { release = resolve; }); }
resetGate();
mock.module("@/services/image-storage", () => ({ uploadImage: async () => { throw new Error("unused"); } }));
mock.module("@/services/file-storage", () => ({ uploadMediaFile: async (file: File, prefix?: string) => {
    uploads.push(file.name);
    uploadKinds.push({ name: file.name, prefix });
    await gate;
    if (file.name === failedName) throw new Error("upload failed");
    return {
        url: file.name,
        storageKey: `resource:${file.name}`,
        bytes: file.size || 1,
        mimeType: prefix === "audio" ? file.type : "video/mp4",
        durationMs: prefix === "audio" ? 3200 : undefined,
    };
} }));
mock.module("@/services/workspace-asset-repository", () => ({ persistWorkspaceAssetChanges: async () => { persistCount++; if (persistError) throw persistError; } }));
mock.module("@/stores/use-asset-store", () => ({ useAssetStore: { getState: () => ({ addAsset: (asset: { title: string; folderId?: string; kind?: string; data?: Record<string, unknown> }) => writes.push(asset) }) } }));
const { uploadWorkspaceAssetFiles } = await import("@/services/workspace-asset-upload");
const files = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => new File(["x"], `${prefix}${i}.mp4`, { type: "video/mp4" }));
afterEach(() => { writes.length = 0; uploads = []; uploadKinds = []; persistCount = 0; persistError = undefined; failedName = ""; resetGate(); });

test("six-file batch settles exactly once while another picker batch starts", async () => {
    setActiveUserScope("upload-owner");
    const first = uploadWorkspaceAssetFiles(files("first", 6), "folder-a");
    expect(uploads.length).toBe(4);
    // A new picker submission has its own cursor; neither submission needs a mounted view.
    const second = uploadWorkspaceAssetFiles(files("second", 2), "folder-b");
    release();
    expect(await first).toMatchObject({ completed: 6, failed: 0 });
    expect(await second).toMatchObject({ completed: 2, failed: 0 });
    expect(writes.length).toBe(8);
    expect(new Set(writes.map((asset) => asset.title)).size).toBe(8);
    expect(writes.filter((asset) => asset.folderId === "folder-a").length).toBe(6);
    expect(persistCount).toBe(2);
});

test("one upload failure does not discard the remaining queue or successful settlement", async () => {
    setActiveUserScope("upload-partial");
    failedName = "partial0.mp4";
    const pending = uploadWorkspaceAssetFiles(files("partial", 6), "");
    release();
    expect(await pending).toMatchObject({ completed: 5, failed: 1 });
    expect(writes.length).toBe(5);
    expect(persistCount).toBe(1);
});

test("persistence failure is reported separately from completed uploads", async () => {
    setActiveUserScope("upload-persist");
    persistError = new Error("disk unavailable");
    const pending = uploadWorkspaceAssetFiles(files("saved", 1), "");
    release();
    expect(await pending).toEqual({ completed: 1, failed: 0, persistenceError: persistError });
});

test("audio files with audio/mpeg and empty MIME type with .mp3 extension upload as audio assets", async () => {
    setActiveUserScope("upload-audio");
    const audioFiles = [
        new File(["id3"], "bgm-theme.mp3", { type: "audio/mpeg" }),
        new File(["id3"], "voice-over.mp3", { type: "" }),
    ];
    const pending = uploadWorkspaceAssetFiles(audioFiles, "folder-audio");
    release();
    expect(await pending).toMatchObject({ completed: 2, failed: 0 });
    expect(uploadKinds).toEqual([
        { name: "bgm-theme.mp3", prefix: "audio" },
        { name: "voice-over.mp3", prefix: "audio" },
    ]);
    expect(writes).toEqual([
        expect.objectContaining({
            title: "bgm-theme",
            folderId: "folder-audio",
            kind: "audio",
            data: {
                url: "bgm-theme.mp3",
                storageKey: "resource:bgm-theme.mp3",
                durationMs: 3200,
                bytes: 3,
                mimeType: "audio/mpeg",
            },
        }),
        expect.objectContaining({
            title: "voice-over",
            folderId: "folder-audio",
            kind: "audio",
            data: {
                url: "voice-over.mp3",
                storageKey: "resource:voice-over.mp3",
                durationMs: 3200,
                bytes: 3,
                mimeType: "audio/mpeg",
            },
        }),
    ]);
    expect(persistCount).toBe(1);
});
