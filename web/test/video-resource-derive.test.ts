import { afterEach, describe, expect, test } from "bun:test";
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from "axios";

import { ApiError, apiBaseURL, apiClient, configureApiRuntime } from "../src/services/api/request";
import { getClientDiagnosticEvents } from "../src/services/diagnostics/client-diagnostics";
import { createCanvasMediaOperation } from "../src/pages/canvas/canvas-media-operation";
import { CanvasOwnerAbandonedError, createCanvasOwnerLifetime } from "../src/pages/canvas/canvas-owner-epoch";
import {
    canDeriveNodeViaBackend,
    deriveNodeSeparatedAudioViaBackend,
    deriveNodeVideoFramesViaBackend,
    shouldFallbackToBrowserMediaTools,
} from "../src/services/video-resource-derive";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const defaultAdapter = apiClient.defaults.adapter;
const initialBaseURL = apiBaseURL;

afterEach(() => {
    apiClient.defaults.adapter = defaultAdapter;
    configureApiRuntime(initialBaseURL);
});

function makeVideoNode(overrides?: Partial<CanvasNodeData["metadata"]>): CanvasNodeData {
    return {
        id: "node-video-1",
        type: CanvasNodeType.Video,
        title: "测试视频",
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: {
            storageKey: "resource:res-video-1",
            content: "/api/resources/res-video-1/file",
            durationMs: 4200,
            ...overrides,
        },
    };
}

function mockEnvelopeAdapter(
    handler: (config: InternalAxiosRequestConfig) => { status: number; data: unknown } | Promise<{ status: number; data: unknown }>,
): AxiosAdapter {
    return async (config) => {
        const res = await handler(config);
        const response: AxiosResponse = {
            data: res.data,
            status: res.status,
            statusText: String(res.status),
            headers: {},
            config,
        };
        if (res.status >= 400) {
            const error = Object.assign(new Error("Request failed"), {
                isAxiosError: true,
                config,
                response,
            });
            throw error;
        }
        return response;
    };
}

describe("shouldFallbackToBrowserMediaTools", () => {
    test("falls back only when native backend route or tool is unavailable or offline", () => {
        expect(shouldFallbackToBrowserMediaTools(new ApiError("本地媒体工具不可用", { status: 503, reason: "unavailable" }))).toBe(true);
        expect(shouldFallbackToBrowserMediaTools(new ApiError("route not found", { status: 404, reason: "not_found" }))).toBe(true);
        expect(shouldFallbackToBrowserMediaTools(new ApiError("network error", {}))).toBe(true);
    });

    test("never swallows domain validation, quota, auth, or abort errors into WASM fallback", () => {
        expect(shouldFallbackToBrowserMediaTools(new ApiError("原视频没有音轨", { status: 400, reason: "invalid_argument" }))).toBe(false);
        expect(shouldFallbackToBrowserMediaTools(new ApiError("存储空间不足", { status: 403, reason: "quota_exceeded" }))).toBe(false);
        expect(shouldFallbackToBrowserMediaTools(new ApiError("未授权", { status: 401, reason: "unauthenticated" }))).toBe(false);
        expect(shouldFallbackToBrowserMediaTools(new ApiError("资源仍在上传中", { status: 409, reason: "conflict" }))).toBe(false);
        expect(shouldFallbackToBrowserMediaTools(new ApiError("编码损坏", { status: 500, reason: "internal" }))).toBe(false);
        expect(shouldFallbackToBrowserMediaTools(new DOMException("Aborted", "AbortError"))).toBe(false);
    });
});

describe("deriveNodeVideoFramesViaBackend & deriveNodeSeparatedAudioViaBackend", () => {
    test("eligibility disables backend route in browser-local IndexedDB mode and enables it on native desktop loopback", () => {
        configureApiRuntime("/api");
        expect(canDeriveNodeViaBackend(makeVideoNode())).toBe(false);

        configureApiRuntime("http://127.0.0.1:18080/api");
        expect(canDeriveNodeViaBackend(makeVideoNode())).toBe(true);
        expect(canDeriveNodeViaBackend(makeVideoNode({ storageKey: "local-idb:1", content: "blob:http://localhost/1" }))).toBe(false);
    });

    test("maps backend frame extraction response, headers, finite timeout, and partial failures", async () => {
        configureApiRuntime("http://127.0.0.1:18080/api");
        let capturedConfig: InternalAxiosRequestConfig | undefined;
        apiClient.defaults.adapter = mockEnvelopeAdapter((config) => {
            capturedConfig = config;
            return {
                status: 200,
                data: {
                    code: 0,
                    msg: "ok",
                    data: {
                        durationMs: 4200,
                        failures: [{ timeMs: 2500, reason: "画面提取失败" }],
                        frames: [
                            {
                                timeMs: 0,
                                resource: {
                                    id: "frame-res-1",
                                    userId: "u1",
                                    kind: "image",
                                    status: "ready",
                                    provider: "local",
                                    endpoint: "",
                                    bucket: "",
                                    objectKey: "f1.png",
                                    publicUrl: "",
                                    mimeType: "image/png",
                                    size: 2048,
                                    width: 1280,
                                    height: 720,
                                    createdAt: "2026-01-01T00:00:00Z",
                                    updatedAt: "2026-01-01T00:00:00Z",
                                },
                            },
                        ],
                    },
                },
            };
        });

        const result = await deriveNodeVideoFramesViaBackend(
            makeVideoNode(),
            { timesMs: [0, 2500] },
            { idempotencyKey: "idem-frame-batch", canvasId: "canvas-1" },
        );

        expect(capturedConfig?.timeout).toBe(120_000);
        expect(capturedConfig?.headers?.get("X-Idempotency-Key")).toBe("idem-frame-batch");
        expect(result).not.toBeNull();
        expect(result?.durationMs).toBe(4200);
        expect(result?.failures).toEqual([{ timeMs: 2500, reason: "画面提取失败" }]);
        expect(result?.frames).toEqual([
            {
                timeMs: 0,
                image: {
                    url: expect.stringContaining("/resources/frame-res-1/file"),
                    storageKey: "resource:frame-res-1",
                    width: 1280,
                    height: 720,
                    bytes: 2048,
                    mimeType: "image/png",
                },
            },
        ]);
    });

    test("returns null and records a warning diagnostic when backend returns 503 unavailable, while rethrowing 400", async () => {
        configureApiRuntime("http://127.0.0.1:18080/api");
        const beforeCount = getClientDiagnosticEvents().filter((e) => e.code === "canvas_video_derive_backend_fallback").length;
        apiClient.defaults.adapter = mockEnvelopeAdapter(() => ({
            status: 503,
            data: { code: 503, reason: "unavailable", msg: "本地视频处理工具不可用" },
        }));

        const fallbackResult = await deriveNodeSeparatedAudioViaBackend(makeVideoNode(), { canvasId: "canvas-fallback-test" });
        expect(fallbackResult).toBeNull();
        const afterEvents = getClientDiagnosticEvents().filter((e) => e.code === "canvas_video_derive_backend_fallback");
        expect(afterEvents.length).toBe(beforeCount + 1);
        expect(afterEvents[afterEvents.length - 1]?.level).toBe("warning");

        apiClient.defaults.adapter = mockEnvelopeAdapter(() => ({
            status: 400,
            data: { code: 400, reason: "invalid_argument", msg: "原视频没有音轨" },
        }));
        await expect(deriveNodeSeparatedAudioViaBackend(makeVideoNode())).rejects.toThrow("原视频没有音轨");
    });
});

describe("createCanvasMediaOperation cancellation", () => {
    test("invalidating owner lifetime aborts operation.signal immediately and rejects wait with CanvasOwnerAbandonedError", async () => {
        const lifetime = createCanvasOwnerLifetime();
        let liveCanvas = "canvas-a";
        const op = createCanvasMediaOperation(lifetime, "canvas-a", () => liveCanvas, () => true);
        expect(op.signal.aborted).toBe(false);

        const pending = new Promise<string>((_resolve, reject) => {
            op.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });

        const waited = op.wait(pending);
        liveCanvas = "canvas-b";
        lifetime.invalidate();

        expect(op.signal.aborted).toBe(true);
        await expect(waited).rejects.toBeInstanceOf(CanvasOwnerAbandonedError);
    });

    test("subscribes to onInvalidate lazily on signal access and unsubscribes on dispose", () => {
        const base = createCanvasOwnerLifetime();
        let activeListeners = 0;
        const trackedLifetime = {
            ...base,
            onInvalidate(listener: () => void) {
                activeListeners += 1;
                const unsub = base.onInvalidate?.(listener);
                return () => {
                    activeListeners -= 1;
                    unsub?.();
                };
            },
        };

        const opWithoutSignal = createCanvasMediaOperation(trackedLifetime, "canvas-a", () => "canvas-a", () => true);
        expect(activeListeners).toBe(0);
        opWithoutSignal.dispose();

        const opWithSignal = createCanvasMediaOperation(trackedLifetime, "canvas-a", () => "canvas-a", () => true);
        expect(opWithSignal.signal.aborted).toBe(false);
        expect(activeListeners).toBe(1);
        opWithSignal.dispose();
        expect(activeListeners).toBe(0);
    });
});
