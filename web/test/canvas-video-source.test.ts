import { beforeEach, expect, mock, test } from "bun:test";
import type { HttpRequestConfig } from "../src/services/api/request";
import type { ResourcePlayback } from "../src/services/api/resources";

const resources = await import("../src/services/api/resources");
let config: HttpRequestConfig | undefined;
let resolvePlayback!: (value: ResourcePlayback) => void;
let pending: Promise<ResourcePlayback>;
mock.module("../src/services/api/resources", () => ({
    ...resources,
    refreshResource: async () => ({ id: "video", playbackStatus: "ready" }),
    getResourcePlayback: (_key: string, requestConfig?: HttpRequestConfig) => { config = requestConfig; return pending; },
}));
const { acquireCanvasVideoSource } = await import("../src/services/canvas-video-source");

beforeEach(() => {
    config = undefined;
    pending = new Promise((resolve) => { resolvePlayback = resolve; });
});

test("preview forwards cancellation to the full download", async () => {
    const controller = new AbortController();
    const request = acquireCanvasVideoSource("resource:video", "", controller.signal);
    await Promise.resolve();
    expect(config?.signal).toBe(controller.signal);
    controller.abort();
    resolvePlayback({ blob: new Blob(["bytes"]), compatible: false });
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
});

test("owned media creates a releasable Blob URL", async () => {
    const request = acquireCanvasVideoSource("resource:video");
    resolvePlayback({ blob: new Blob(["bytes"], { type: "video/mp4" }), compatible: true });
    const source = await request;
    expect(await (await fetch(source.url)).text()).toBe("bytes");
    source.release();
    await expect(fetch(source.url)).rejects.toThrow();
});
