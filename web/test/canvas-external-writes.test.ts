import { afterEach, describe, expect, test } from "bun:test";
import { apiClient, configureApiRuntime } from "@/services/api/request";
import {
    fetchExternalCanvasWrites,
    notifyExternalCanvasEvent,
    subscribeCanvasEventsStream,
    subscribeExternalCanvasEvent,
    undoExternalCanvasWrite,
} from "@/services/canvas-external-writes";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalAdapter = apiClient.defaults.adapter;

afterEach(() => {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
    apiClient.defaults.adapter = originalAdapter;
    delete apiClient.defaults.headers.common["X-Desktop-Token"];
});

describe("桌面端实时画布 SSE 与外部改动记录", () => {
    test("Wails 协议或桌面端 Token 下通过流式 fetch 实时接收 canvas.updated", async () => {
        configureApiRuntime("http://127.0.0.1:18090/api", "desktop-secret-token");
        globalThis.window = {
            location: { protocol: "wails:" },
        } as unknown as Window & typeof globalThis;

        let capturedUrl = "";
        let capturedHeaders: Record<string, string> = {};
        const encoder = new TextEncoder();

        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            capturedUrl = String(input);
            capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));
                    controller.enqueue(encoder.encode("event: canvas.updated\ndata: {\"revision\":2}\n\n"));
                },
            });
            return new Response(stream, { status: 200 });
        }) as typeof fetch;

        let updates = 0;
        const unsubscribe = subscribeCanvasEventsStream("canvas-wails-1", () => {
            updates += 1;
        });

        await new Promise((resolve) => setTimeout(resolve, 30));
        unsubscribe();

        expect(capturedUrl).toBe("http://127.0.0.1:18090/api/canvas-projects/canvas-wails-1/events");
        expect(capturedHeaders["X-Desktop-Token"]).toBe("desktop-secret-token");
        expect(capturedHeaders.Accept).toBe("text/event-stream");
        expect(updates).toBe(1);
    });

    test("读取外部改动列表与按写入记录撤销", async () => {
        const calls: Array<{ method?: string; url?: string; params?: unknown; data?: unknown }> = [];
        apiClient.defaults.adapter = async (config) => {
            calls.push({
                method: config.method,
                url: config.url,
                params: config.params,
                data: config.data ? JSON.parse(String(config.data)) : undefined,
            });
            if (config.url === "/ops/external-writes") {
                return {
                    data: {
                        code: 0,
                        msg: "ok",
                        data: {
                            writes: [
                                {
                                    opId: "ext-op-99",
                                    canvasId: "c-1",
                                    op: "canvas.node.update",
                                    callerKind: "external",
                                    clientLabel: "Codex CLI",
                                    revisionBefore: 3,
                                    revisionAfter: 4,
                                    changedNodeIds: ["n1"],
                                    summary: "修改 镜头 1",
                                    createdAt: "2026-11-01T10:00:00Z",
                                },
                            ],
                        },
                    },
                    status: 200,
                    statusText: "OK",
                    headers: {},
                    config,
                };
            }
            return {
                data: {
                    code: 0,
                    msg: "ok",
                    data: {
                        canvasId: "c-1",
                        opId: "ext-op-99",
                        clientLabel: "Codex CLI",
                        revision: 5,
                        restoredNodeIds: ["n1"],
                        undone: true,
                    },
                },
                status: 200,
                statusText: "OK",
                headers: {},
                config,
            };
        };

        const writes = await fetchExternalCanvasWrites("c-1");
        expect(writes).toHaveLength(1);
        expect(writes[0].clientLabel).toBe("Codex CLI");
        expect(writes[0].changedNodeIds).toEqual(["n1"]);

        const undoRes = await undoExternalCanvasWrite("c-1", "ext-op-99");
        expect(undoRes.undone).toBe(true);
        expect(undoRes.revision).toBe(5);
        expect(undoRes.restoredNodeIds).toEqual(["n1"]);
        expect(calls[1]).toMatchObject({
            method: "post",
            url: "/ops/external-writes/ext-op-99/undo",
            data: { canvasId: "c-1" },
        });
    });

    test("外部画布事件广播唤醒对应画布订阅者", () => {
        const seen: string[] = [];
        const off = subscribeExternalCanvasEvent((canvasId) => seen.push(canvasId));
        notifyExternalCanvasEvent("c-alpha");
        off();
        notifyExternalCanvasEvent("c-beta");
        expect(seen).toEqual(["c-alpha"]);
    });
});
