import { expect, mock } from "bun:test";
let probeCode = -1;
let probe = '{"streams":[{"index":1}],"format":{"duration":"2"}}';
const encodes: string[][] = [];
const removed: string[] = [];
const ffmpeg = {
    writeFile: async () => undefined,
    ffprobe: async () => probeCode,
    readFile: async (name: string) => name.includes("probe") ? probe : new Uint8Array([0xff, 0xfb, 0x90, 0]),
    exec: async (args: string[]) => { encodes.push(args); return 0; },
    deleteFile: async (name: string) => { removed.push(name); },
};
mock.module("../../src/lib/canvas/canvas-ffmpeg-session", () => ({ withFFmpegLease: async (work: (lease: unknown) => unknown) => work({ ffmpeg, filePrefix: "fixture-" }) }));
mock.module("../../src/services/file-storage", () => ({ getMediaBlob: async () => new Blob(["fixture"], { type: "video/mp4" }) }));
mock.module("@ffmpeg/util", () => ({ fetchFile: async (blob: Blob) => new Uint8Array(await blob.arrayBuffer()) }));
const { extractVideoAudio } = await import("../../src/lib/canvas/canvas-video-segment");
await extractVideoAudio({ storageKey: "video:fixture" }, { startMs: 0, endMs: 2000 }, 2000);
expect(encodes).toHaveLength(1);
expect(removed).toContain("fixture-audio-probe.json");
encodes.length = 0;
removed.length = 0;
probe = '{"streams":[],"format":{"duration":"2"}}';
await expect(extractVideoAudio({ storageKey: "video:fixture" }, { startMs: 0, endMs: 2000 }, 2000)).rejects.toThrow("没有音轨");
expect(encodes).toHaveLength(0);
expect(removed).toContain("fixture-audio-probe.json");
probeCode = 1;
await expect(extractVideoAudio({ storageKey: "video:fixture" }, { startMs: 0, endMs: 2000 }, 2000)).rejects.toThrow("无法读取");
expect(encodes).toHaveLength(0);
console.log("audio probe and cleanup verified");
