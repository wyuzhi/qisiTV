import { afterEach, expect, spyOn, test } from "bun:test";

import { acquireCanvasVideoPreview, CANVAS_VIDEO_PREVIEW_VERSION, canvasVideoPreviewNeedsHydration } from "../src/services/canvas-video-preview";
import * as canvasVideoSourceModule from "../src/services/canvas-video-source";
import { capturePresentedVideoPoster } from "../src/lib/video-poster";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const node = (videoPreview?: CanvasNodeData["metadata"]["videoPreview"]): CanvasNodeData => ({
    id: "video-1",
    type: CanvasNodeType.Video,
    title: "video.mp4",
    position: { x: 0, y: 0 },
    width: 720,
    height: 405,
    metadata: {
        content: "/api/resources/source/file",
        storageKey: "resource:source",
        videoPreview,
    },
});

test("legacy and source-mismatched posters are hydrated again", () => {
    expect(canvasVideoPreviewNeedsHydration(node({ content: "/api/resources/old-poster/file" }))).toBe(true);
    expect(
        canvasVideoPreviewNeedsHydration(
            node({
                content: "/api/resources/poster/file",
                captureVersion: CANVAS_VIDEO_PREVIEW_VERSION,
                sourceKey: "resource:other-source",
            }),
        ),
    ).toBe(true);
    expect(
        canvasVideoPreviewNeedsHydration(
            node({
                content: "/api/resources/poster/file",
                captureVersion: CANVAS_VIDEO_PREVIEW_VERSION,
                sourceKey: "resource:source",
            }),
        ),
    ).toBe(false);
});

test("poster capture waits for a presented video frame before drawing", async () => {
    let presented: (() => void) | undefined;
    let drawCount = 0;
    const video = Object.assign(new EventTarget(), {
        videoWidth: 1920,
        videoHeight: 1080,
        duration: 10,
        currentTime: 0.001,
        readyState: 4,
        requestVideoFrameCallback(callback: () => void) {
            presented = callback;
            return 1;
        },
        async play() {},
        pause() {},
    }) as unknown as HTMLVideoElement;
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
            fillStyle: "",
            fillRect() {},
            drawImage() {
                drawCount += 1;
            },
        }),
        toBlob(callback: BlobCallback) {
            callback(new Blob(["poster"], { type: "image/jpeg" }));
        },
    } as unknown as HTMLCanvasElement;

    const resultPromise = capturePresentedVideoPoster(video, canvas, { maxWidth: 400, timeoutMs: 1_000 });
    await Promise.resolve();
    expect(drawCount).toBe(0);
    presented?.();
    const result = await resultPromise;

    expect(drawCount).toBe(1);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.poster?.type).toBe("image/jpeg");
});

test("video preview retries with compatible playback when first poster capture resolves without a poster", async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    let videoCalls = 0;
    const acquireCalls: boolean[] = [];
    const acquireSpy = spyOn(canvasVideoSourceModule, "acquireCanvasVideoSource").mockImplementation(async (_storageKey, _fallback, _signal, needsCompatible = false) => {
        acquireCalls.push(needsCompatible);
        return {
            url: needsCompatible ? "blob:compatible-video" : "blob:original-video",
            release: () => {},
        };
    });
    Object.assign(globalThis, {
        window: {
            requestIdleCallback: (cb: () => void) => { cb(); return 1; },
            cancelIdleCallback: () => {},
            setTimeout: globalThis.setTimeout.bind(globalThis),
            clearTimeout: globalThis.clearTimeout.bind(globalThis),
        },
        document: {
            createElement(tag: string) {
                if (tag === "video") {
                    const attempt = ++videoCalls;
                    const el = Object.assign(new EventTarget(), {
                        videoWidth: 1280,
                        videoHeight: 720,
                        duration: 10,
                        currentTime: 0.001,
                        readyState: 4,
                        preload: "",
                        muted: false,
                        playsInline: false,
                        src: "",
                        onloadedmetadata: null as ((ev: Event) => void) | null,
                        onloadeddata: null as ((ev: Event) => void) | null,
                        onerror: null as ((ev: Event) => void) | null,
                        requestVideoFrameCallback(cb: () => void) { cb(); return 1; },
                        async play() {},
                        pause() {},
                        removeAttribute() {},
                        load() {
                            if (!this.src) return;
                            queueMicrotask(() => {
                                if (attempt === 1) {
                                    this.onerror?.(new Event("error"));
                                } else {
                                    this.onloadeddata?.(new Event("loadeddata"));
                                }
                            });
                        },
                    });
                    return el;
                }
                return {
                    width: 0,
                    height: 0,
                    getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }),
                    toBlob(cb: BlobCallback) { cb(new Blob(["compatible-poster"], { type: "image/jpeg" })); },
                };
            },
        },
    });
    try {
        const lease = acquireCanvasVideoPreview({
            metadata: {
                storageKey: "resource:decode-fail-video",
                content: "/api/resources/decode-fail-video/file",
            },
        });
        const preview = await lease.promise;
        lease.release();
        expect(acquireCalls).toEqual([false, true]);
        expect(preview).not.toBeNull();
        expect(preview?.width).toBe(1280);
        expect(preview?.height).toBe(720);
    } finally {
        acquireSpy.mockRestore();
        globalThis.window = originalWindow;
        globalThis.document = originalDocument;
    }
});

afterEach(() => {
    // The production capture queue is serialized; let settled microtasks flush
    // before another test replaces browser primitives.
    return Promise.resolve();
});
