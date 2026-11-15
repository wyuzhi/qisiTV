import { afterEach, expect, test } from "bun:test";

import { initializeWorkspaceState } from "@/components/workspace/workspace-bootstrap-hydrator";
import { AgentStreamDetachedError, resetAgentUiSession, streamAgentChat } from "@/services/api/agent-assistant";
import { requestStreamingChatCompletion } from "@/services/api/image-streaming";
import { apiBaseURL, apiClient } from "@/services/api/request";
import { shouldUseTaskTextEvents, waitForGenerationTask } from "@/services/api/task-center";
import { subscribeCanvasEventsStream } from "@/services/canvas-external-writes";
import { getClientDiagnosticEvents } from "@/services/diagnostics/client-diagnostics";
import { desktopTransportChecks } from "@/services/diagnostics/environment-check";
import {
    bootstrapDesktopRuntime,
    configureDesktopRuntime,
    configureSameOriginDesktopFallback,
    DesktopStartupError,
    getDesktopBootSnapshot,
    resetDesktopBootSnapshot,
} from "@/services/desktop-runtime";
import {
    buildStartupDiagnosticPayload,
    isDesktopStreamingAvailable,
    setStartupDiagnosticPayloadBuilder,
} from "@/services/workspace-startup-state";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalAdapter = apiClient.defaults.adapter;

afterEach(() => {
    resetDesktopBootSnapshot();
    resetAgentUiSession();
    setStartupDiagnosticPayloadBuilder(null);
    apiClient.defaults.adapter = originalAdapter;
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
});

test("embedded bootstrap uses the same-origin Host API without desktop credentials", async () => {
    let bindingRead = false;
    Object.assign(globalThis, {
        window: {
            location: { origin: "http://127.0.0.1:3901" },
            __BEEFTV_HARNESS__: { embedded: true, basePath: "/beeftv/app/session-1", apiBase: "/beeftv/app/session-1/api" },
            go: { main: { DesktopApp: { StartupState: async () => { bindingRead = true; throw new Error("unexpected desktop bootstrap"); } } } },
        },
    });
    apiClient.defaults.headers.common["X-Desktop-Token"] = "old-desktop-token";
    apiClient.defaults.headers.common["X-Beeftv-UI-Bootstrap"] = "old-bootstrap-token";

    expect(await bootstrapDesktopRuntime()).toBe(true);
    expect(bindingRead).toBe(false);
    expect(apiBaseURL).toBe("/beeftv/app/session-1/api");
    expect(apiClient.defaults.headers.common["X-Desktop-Token"]).toBeUndefined();
    expect(apiClient.defaults.headers.common["X-Beeftv-UI-Bootstrap"]).toBeUndefined();
});

test("desktop runtime configures axios and same-runtime fetches without persisting the token", async () => {
    let captured: Request | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = new Request(input, init);
        return new Response(null, { status: 204 });
    }) as typeof fetch;

    configureDesktopRuntime({ baseURL: "http://127.0.0.1:43123/api", launchToken: "ephemeral-token", uiBootstrapToken: "ui-only-token" });

    expect(apiBaseURL).toBe("http://127.0.0.1:43123/api");
    expect(apiClient.defaults.baseURL).toBe("http://127.0.0.1:43123/api");
    expect(apiClient.defaults.headers.common["X-Desktop-Token"]).toBe("ephemeral-token");
    expect(apiClient.defaults.headers.common["X-Beeftv-UI-Bootstrap"]).toBe("ui-only-token");

    await fetch("http://127.0.0.1:43123/api/tasks", { headers: { Accept: "application/json" } });
    expect(captured?.headers.get("X-Desktop-Token")).toBe("ephemeral-token");
    expect(captured?.headers.get("Accept")).toBe("application/json");
    expect(captured?.headers.get("X-Beeftv-UI-Bootstrap")).toBeNull();
});

test("desktop bootstrap obtains ephemeral runtime configuration from the Wails binding", async () => {
    Object.assign(globalThis, {
        window: {
            go: {
                main: {
                    DesktopApp: {
                        StartupState: async () => ({ state: "ready" as const, baseURL: "http://127.0.0.1:43124/api", launchToken: "binding-token" }),
                    },
                },
            },
        },
    });

    expect(await bootstrapDesktopRuntime()).toBe(true);
    expect(apiBaseURL).toBe("http://127.0.0.1:43124/api");
});

test("desktop bootstrap falls back to the Wails asset handler when binding startup races", async () => {
    Object.assign(globalThis, {
        window: {
            location: { protocol: "wails:" },
            go: { main: { DesktopApp: { StartupState: async () => Promise.reject(new Error("binding not ready")) } } },
        },
    });
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({ state: "ready", baseURL: "http://127.0.0.1:43125/api", launchToken: "handler-token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })) as typeof fetch;

    expect(await bootstrapDesktopRuntime()).toBe(true);
    expect(apiBaseURL).toBe("http://127.0.0.1:43125/api");
});

test("desktop bootstrap rejects an empty early binding result and uses the asset handler", async () => {
    Object.assign(globalThis, {
        window: {
            location: { protocol: "wails:" },
            go: { main: { DesktopApp: { StartupState: async () => ({ state: "ready" as const, baseURL: "", launchToken: "" }) } } },
        },
    });
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({ state: "ready", baseURL: "http://127.0.0.1:43126/api", launchToken: "handler-token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })) as typeof fetch;

    expect(await bootstrapDesktopRuntime()).toBe(true);
    expect(apiBaseURL).toBe("http://127.0.0.1:43126/api");
});

test("Windows WebView2 wails.localhost polls startup phases until ready", async () => {
    const observedPhases: string[] = [];
    let pollCount = 0;
    Object.assign(globalThis, {
        window: {
            location: { protocol: "http:", hostname: "wails.localhost", host: "wails.localhost" },
            go: {
                main: {
                    DesktopApp: {
                        StartupState: async () => {
                            pollCount += 1;
                            if (pollCount === 1) {
                                return { state: "starting" as const, phase: "lock", detail: "正在检查工作区目录与实例锁" };
                            }
                            if (pollCount === 2) {
                                return { state: "starting" as const, phase: "migrate", detail: "正在检查并升级数据库结构" };
                            }
                            return {
                                state: "ready" as const,
                                phase: "ready",
                                detail: "本地工作区已就绪",
                                baseURL: "http://127.0.0.1:43127/api",
                                launchToken: "win-token",
                                uiBootstrapToken: "win-ui-token",
                            };
                        },
                    },
                },
            },
        },
    });
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({ code: 0, data: { status: "ok" }, msg: "ok" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })) as typeof fetch;

    const unsubscribe = (await import("@/services/desktop-runtime")).subscribeDesktopBootSnapshot(() => {
        const phase = getDesktopBootSnapshot().phase;
        if (phase && observedPhases[observedPhases.length - 1] !== phase) observedPhases.push(phase);
    });
    try {
        expect(await bootstrapDesktopRuntime({ pollIntervalMs: 5 })).toBe(true);
    } finally {
        unsubscribe();
    }

    expect(pollCount).toBe(3);
    expect(observedPhases).toEqual(["lock", "migrate", "ready"]);
    expect(apiBaseURL).toBe("http://127.0.0.1:43127/api");
    expect(getDesktopBootSnapshot().transportMode).toBe("loopback");
    expect(getDesktopBootSnapshot().streamAvailable).toBe(true);
});

test("desktop bootstrap throws structured DesktopStartupError when backend boot fails", async () => {
    Object.assign(globalThis, {
        window: {
            location: { protocol: "http:", hostname: "wails.localhost", host: "wails.localhost" },
            go: {
                main: {
                    DesktopApp: {
                        StartupState: async () => ({
                            state: "failed" as const,
                            phase: "lock",
                            reason: "workspace_locked",
                            error: "当前数据目录正被另一个 BeefTV 窗口占用，请先关闭其他窗口或结束残留进程后重试。",
                            dataDir: "D:\\BeefTV-Workspace",
                            diagnosticPath: "D:\\BeefTV-Workspace\\diagnostics\\beeftv-startup-diagnostics.zip",
                        }),
                    },
                },
            },
        },
    });

    let caught: unknown;
    try {
        await bootstrapDesktopRuntime({ pollIntervalMs: 5 });
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(DesktopStartupError);
    expect((caught as DesktopStartupError).failure).toMatchObject({
        stage: "desktop_boot",
        phase: "lock",
        reason: "workspace_locked",
        dataDir: "D:\\BeefTV-Workspace",
        diagnosticPath: "D:\\BeefTV-Workspace\\diagnostics\\beeftv-startup-diagnostics.zip",
    });
});

test("Windows WebView2 falls back to same-origin /api when loopback port is blocked", async () => {
    Object.assign(globalThis, {
        window: {
            location: { protocol: "http:", hostname: "wails.localhost", host: "wails.localhost" },
            go: {
                main: {
                    DesktopApp: {
                        StartupState: async () => ({
                            state: "ready" as const,
                            phase: "ready",
                            baseURL: "http://127.0.0.1:43128/api",
                            launchToken: "blocked-loopback-token",
                            uiBootstrapToken: "blocked-ui-token",
                        }),
                    },
                },
            },
        },
    });
    apiClient.defaults.headers.common["X-Desktop-Token"] = "stale-token";
    apiClient.defaults.headers.common["X-Beeftv-UI-Bootstrap"] = "stale-ui-token";

    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith("http://127.0.0.1:43128/")) {
            throw new TypeError("Failed to fetch");
        }
        if (url === "/api/health/live") {
            return new Response(JSON.stringify({ code: 0, data: { status: "ok" }, msg: "ok" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
        return new Response("not found", { status: 404 });
    }) as typeof fetch;

    expect(await bootstrapDesktopRuntime({ loopbackProbeTimeoutMs: 50, loopbackRetryDelaysMs: [5, 5], upgradeProbeIntervalMs: 0 })).toBe(true);
    expect(apiBaseURL).toBe("/api");
    expect(apiClient.defaults.headers.common["X-Desktop-Token"]).toBe("blocked-loopback-token");
    expect(apiClient.defaults.headers.common["X-Beeftv-UI-Bootstrap"]).toBe("blocked-ui-token");
    expect(getDesktopBootSnapshot().transportMode).toBe("same-origin-fallback");
    expect(getDesktopBootSnapshot().streamAvailable).toBe(false);
    expect(desktopTransportChecks()[0]).toMatchObject({ id: "desktop-loopback", status: "warning" });
    expect(getClientDiagnosticEvents().some((event) => event.code === "desktop_loopback_fallback")).toBe(true);
});

test("loopback probe retries transient hiccups and upgrades out of same-origin fallback when loopback recovers", async () => {
    Object.assign(globalThis, {
        window: {
            location: { protocol: "http:", hostname: "wails.localhost", host: "wails.localhost" },
            go: {
                main: {
                    DesktopApp: {
                        StartupState: async () => ({
                            state: "ready" as const,
                            phase: "ready",
                            baseURL: "http://127.0.0.1:43129/api",
                            launchToken: "recovered-loopback-token",
                            uiBootstrapToken: "recovered-ui-token",
                        }),
                    },
                },
            },
        },
    });

    let loopbackCalls = 0;
    let allowLoopback = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "http://127.0.0.1:43129/api/health/live") {
            loopbackCalls += 1;
            if (!allowLoopback) throw new TypeError("Failed to fetch");
            return new Response(JSON.stringify({ code: 0, data: { status: "ok" }, msg: "ok" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
        if (url === "/api/health/live") {
            return new Response(JSON.stringify({ code: 0, data: { status: "ok" }, msg: "ok" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
        return new Response("not found", { status: 404 });
    }) as typeof fetch;

    expect(
        await bootstrapDesktopRuntime({
            loopbackProbeTimeoutMs: 30,
            loopbackRetryDelaysMs: [5, 5],
            upgradeProbeIntervalMs: 15,
        }),
    ).toBe(true);
    expect(loopbackCalls).toBe(3);
    expect(getDesktopBootSnapshot().transportMode).toBe("same-origin-fallback");
    expect(isDesktopStreamingAvailable()).toBe(false);

    allowLoopback = true;
    const deadline = Date.now() + 500;
    while (getDesktopBootSnapshot().transportMode !== "loopback" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(getDesktopBootSnapshot().transportMode).toBe("loopback");
    expect(isDesktopStreamingAvailable()).toBe(true);
    expect(apiBaseURL).toBe("http://127.0.0.1:43129/api");
    expect(apiClient.defaults.headers.common["X-Desktop-Token"]).toBe("recovered-loopback-token");
});

test("same-origin fallback disables buffered SSE streams and detaches assistant chat observation", async () => {
    Object.assign(globalThis, {
        window: {
            location: { protocol: "http:", hostname: "wails.localhost", host: "wails.localhost" },
            setTimeout: globalThis.setTimeout.bind(globalThis),
            clearTimeout: globalThis.clearTimeout.bind(globalThis),
            dispatchEvent: () => true,
        },
    });
    configureSameOriginDesktopFallback();
    expect(isDesktopStreamingAvailable()).toBe(false);
    expect(shouldUseTaskTextEvents({ onTextDelta: () => undefined })).toBe(false);

    let sseFetched = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/events") || url.includes("/text-events")) {
            sseFetched = true;
        }
        return new Response("unexpected stream", { status: 500 });
    }) as typeof fetch;

    const unsubscribeCanvas = subscribeCanvasEventsStream("canvas-1", () => undefined);
    unsubscribeCanvas();
    expect(sseFetched).toBe(false);

    let pollCount = 0;
    apiClient.defaults.adapter = async (config) => {
        if (config.url === "/assistant/ui-session") {
            return {
                data: { code: 0, msg: "ok", data: { token: "ui-session-1", expiresAt: new Date(Date.now() + 120_000).toISOString() } },
                status: 200,
                statusText: "OK",
                headers: {},
                config,
            };
        }
        pollCount += 1;
        const task =
            pollCount === 1
                ? { id: "task-1", type: "text", prompt: "hi", status: "running", textDraft: "第一段", attempts: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" }
                : { id: "task-1", type: "text", prompt: "hi", status: "succeeded", textDraft: "第一段第二段", attempts: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:02Z" };
        return {
            data: { code: 0, msg: "ok", data: task },
            status: 200,
            statusText: "OK",
            headers: {},
            config,
        };
    };

    const deltas: string[] = [];
    const terminal = await waitForGenerationTask("task-1", { intervalMs: 5, onTextDelta: (text) => deltas.push(text) });
    expect(terminal.status).toBe("succeeded");
    expect(deltas).toEqual(["第一段", "第一段第二段"]);
    expect(sseFetched).toBe(false);

    let chatObserverHeader: string | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input instanceof URL ? input.toString() : typeof input === "string" ? `http://wails.localhost${input}` : input, init);
        chatObserverHeader = req.headers.get("X-Beeftv-Observer-Mode");
        return new Response('{"type":"observer_error","reason":"buffered_transport"}\n', {
            status: 200,
            headers: { "Content-Type": "application/x-ndjson" },
        });
    }) as typeof fetch;

    let detachedError: unknown;
    try {
        await streamAgentChat("canvas-1", "你好", {});
    } catch (error) {
        detachedError = error;
    }
    expect(chatObserverHeader).toBe("detach");
    expect(detachedError).toBeInstanceOf(AgentStreamDetachedError);
    expect((detachedError as AgentStreamDetachedError).reason).toBe("buffered_transport");

    // Custom channel relay over /api/ai/custom must downgrade to non-streaming JSON when streamAvailable === false.
    let customRelayBody: Record<string, unknown> | undefined;
    let customRelayAccept: string | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input instanceof URL ? input.toString() : typeof input === "string" ? `http://wails.localhost${input}` : input, init);
        customRelayAccept = req.headers.get("Accept");
        customRelayBody = JSON.parse(await req.text()) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "非流式返回成功" } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof fetch;

    const customDeltas: string[] = [];
    const customResult = await requestStreamingChatCompletion(
        {
            baseUrl: "https://api.example.com/v1",
            apiKey: "test-key",
            apiFormat: "openai",
        } as any,
        { model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
        (delta) => customDeltas.push(delta),
    );
    expect(customRelayAccept).toBe("application/json");
    expect(customRelayBody?.stream).toBe(false);
    expect(customResult.content).toBe("非流式返回成功");
    expect(customDeltas).toEqual(["非流式返回成功"]);

    // Canvas SSE subscription registered during fallback must automatically connect once loopback upgrades.
    let upgradedSseUpdates = 0;
    let upgradedSseUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/canvas-projects/canvas-upgrade/events")) {
            upgradedSseUrl = url;
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode("event: canvas.updated\ndata: {}\n\n"));
                    controller.close();
                },
            });
            return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
        }
        return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const stopUpgradeSub = subscribeCanvasEventsStream("canvas-upgrade", () => {
        upgradedSseUpdates += 1;
    });
    try {
        expect(upgradedSseUrl).toBe("");
        configureDesktopRuntime({ baseURL: "http://127.0.0.1:43130/api", launchToken: "upgraded-token" });
        const sseDeadline = Date.now() + 300;
        while (upgradedSseUpdates === 0 && Date.now() < sseDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(upgradedSseUrl).toBe("http://127.0.0.1:43130/api/canvas-projects/canvas-upgrade/events");
        expect(upgradedSseUpdates).toBe(1);
    } finally {
        stopUpgradeSub();
    }
});

test("initializeWorkspaceState never fabricates a local session on bootstrap failure and diagnostic payload builder falls back safely", async () => {
    const applied: unknown[] = [];
    let restoredModelConfig = false;
    await expect(
        initializeWorkspaceState({
            loadWorkspace: async () => {
                throw new Error("bootstrap 503");
            },
            applySession: async (payload) => {
                applied.push(payload);
            },
            restoreModelConfig: async () => {
                restoredModelConfig = true;
            },
        }),
    ).rejects.toThrow("bootstrap 503");
    expect(applied).toEqual([]);
    expect(restoredModelConfig).toBe(true);

    setStartupDiagnosticPayloadBuilder(async () => {
        throw new DOMException("IndexedDB blocked", "InvalidStateError");
    });
    const fallbackPayload = await buildStartupDiagnosticPayload({
        stage: "desktop_boot",
        reason: "workspace_locked",
        message: "locked",
    });
    expect(fallbackPayload.description).toBe("startup_failure:desktop_boot:workspace_locked");
    expect(fallbackPayload.clientEvents).toEqual([]);
});
