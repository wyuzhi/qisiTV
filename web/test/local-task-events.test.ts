import { afterAll, expect, test } from "bun:test";
import { apiClient } from "../src/services/api/request";
import {
    createGenerationTaskSubscriptionService,
    shouldUseTaskTextEvents,
    waitForGenerationTask,
    type GenerationTask,
} from "../src/services/api/task-center";
import { shouldEnableCanvasActiveTaskQuery } from "../src/pages/canvas/use-canvas-active-tasks";

const addedWindow = typeof window === "undefined";
if (addedWindow) Object.assign(globalThis, { window: globalThis });
afterAll(() => {
    if (addedWindow) delete (globalThis as { window?: unknown }).window;
});

function buildTask(overrides: Partial<GenerationTask>): GenerationTask {
    return {
        id: "task-server-authority",
        type: "canvas_image",
        status: "running",
        stage: "生成中",
        attempts: 1,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
        ...overrides,
    };
}

test("media task waits use durable task status polling instead of the text-only SSE path", () => {
    expect(shouldUseTaskTextEvents({})).toBe(false);
    expect(shouldUseTaskTextEvents({ onTaskUpdate: () => undefined })).toBe(false);
});

test("text generation opts into resumable SSE when it needs text deltas", () => {
    expect(shouldUseTaskTextEvents({ onTextDelta: () => undefined })).toBe(true);
    expect(shouldUseTaskTextEvents({ useTextEvents: true })).toBe(true);
});

test("local canvas task panel continues querying authoritative task state", () => {
    expect(shouldEnableCanvasActiveTaskQuery(true, "local-project")).toBe(true);
    expect(shouldEnableCanvasActiveTaskQuery(false, "local-project")).toBe(false);
    expect(shouldEnableCanvasActiveTaskQuery(true, "")).toBe(false);
});

test("waitForGenerationTask follows server-authoritative state past legacy 10m image cutoff without fabricating client timeout", async () => {
    const originalNow = Date.now;
    const originalAdapter = apiClient.defaults.adapter;
    const originalSetTimeout = window.setTimeout;
    let now = originalNow();
    let polls = 0;
    Date.now = () => now;
    window.setTimeout = ((cb: TimerHandler) => {
        if (typeof cb === "function") queueMicrotask(() => cb());
        return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof window.setTimeout;
    apiClient.defaults.adapter = async (config) => {
        polls += 1;
        now += 15 * 60 * 1000;
        const data = polls < 3
            ? buildTask({ status: "running", outcome: { phase: "running", regenerate: "blocked", reason: "in_flight" } })
            : buildTask({ status: "succeeded", resultUrl: "https://cdn.example.invalid/final.png", outcome: { phase: "ready", regenerate: "allowed", reason: "completed" } });
        return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "", data } };
    };
    try {
        const settled = await waitForGenerationTask("task-server-authority", {
            initialTask: buildTask({ status: "queued" }),
            intervalMs: 1,
        });
        expect(polls).toBe(3);
        expect(settled.status).toBe("succeeded");
        expect(settled.resultUrl).toBe("https://cdn.example.invalid/final.png");
    } finally {
        Date.now = originalNow;
        window.setTimeout = originalSetTimeout;
        apiClient.defaults.adapter = originalAdapter;
    }
});

test("waitForGenerationTask still honors explicit caller observation timeoutMs", async () => {
    const originalNow = Date.now;
    const originalAdapter = apiClient.defaults.adapter;
    const originalSetTimeout = window.setTimeout;
    let now = originalNow();
    Date.now = () => now;
    window.setTimeout = ((cb: TimerHandler) => {
        now += 250;
        if (typeof cb === "function") queueMicrotask(() => cb());
        return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof window.setTimeout;
    apiClient.defaults.adapter = async (config) => ({
        config,
        status: 200,
        statusText: "OK",
        headers: {},
        data: { code: 0, msg: "", data: buildTask({ status: "running" }) },
    });
    try {
        await expect(
            waitForGenerationTask("task-explicit-observation", { intervalMs: 1, timeoutMs: 200 }),
        ).rejects.toThrow("任务执行超时，请稍后重试");
    } finally {
        Date.now = originalNow;
        window.setTimeout = originalSetTimeout;
        apiClient.defaults.adapter = originalAdapter;
    }
});

test("resumable text SSE waits past legacy 12m cutoff across idle stream reconnects and fails fast on transport outage", async () => {
    const originalNow = Date.now;
    const originalAdapter = apiClient.defaults.adapter;
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = window.setTimeout;
    let now = originalNow();
    let streamCalls = 0;
    const deltas: string[] = [];
    Date.now = () => now;
    window.setTimeout = ((cb: TimerHandler) => {
        if (typeof cb === "function") queueMicrotask(() => cb());
        return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof window.setTimeout;

    apiClient.defaults.adapter = async (config) => {
        if (String(config.url || "").includes("task-text-outage")) {
            throw new Error("Failed to fetch");
        }
        return {
            config,
            status: 200,
            statusText: "OK",
            headers: {},
            data: {
                code: 0,
                msg: "",
                data: buildTask({
                    id: "task-text-long",
                    type: "project_text",
                    status: streamCalls >= 2 ? "succeeded" : "running",
                    resultText: streamCalls >= 2 ? "完整正文" : undefined,
                }),
            },
        };
    };
    globalThis.fetch = (async () => {
        streamCalls += 1;
        now += 10 * 60 * 1000;
        const sse = streamCalls === 1
            ? ""
            : 'id: 1\nevent: delta\ndata: {"sequence":1,"content":"完整正文"}\n\nevent: terminal\ndata: {"finalText":"完整正文"}\n\n';
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    try {
        const completed = await waitForGenerationTask("task-text-long", {
            initialTask: buildTask({ id: "task-text-long", type: "project_text", status: "running" }),
            intervalMs: 1,
            onTextDelta: (text) => deltas.push(text),
        });
        expect(streamCalls).toBe(2);
        expect(completed.status).toBe("succeeded");
        expect(deltas).toEqual(["完整正文"]);

        globalThis.fetch = (async () => {
            throw new Error("Failed to fetch");
        }) as unknown as typeof fetch;
        await expect(
            waitForGenerationTask("task-text-outage", {
                initialTask: buildTask({ id: "task-text-outage", type: "project_text", status: "running" }),
                intervalMs: 1,
                useTextEvents: true,
            }),
        ).rejects.toThrow("任务文本流同步失败：Failed to fetch");
    } finally {
        Date.now = originalNow;
        window.setTimeout = originalSetTimeout;
        globalThis.fetch = originalFetch;
        apiClient.defaults.adapter = originalAdapter;
    }
});

test("resumable text SSE does not reset failure counter on initial progress frame before stream error and settles immediately if backend reached terminal state", async () => {
    const originalAdapter = apiClient.defaults.adapter;
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = window.setTimeout;
    window.setTimeout = ((cb: TimerHandler) => {
        if (typeof cb === "function") queueMicrotask(() => cb());
        return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof window.setTimeout;

    let streamCalls = 0;
    let backendStatus: GenerationTask["status"] = "running";
    apiClient.defaults.adapter = async (config) => ({
        config,
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
            code: 0,
            msg: "",
            data: buildTask({
                id: "task-progress-then-error",
                type: "canvas_text",
                status: backendStatus,
                ...(backendStatus === "succeeded" ? { resultJson: JSON.stringify({ mode: "text", text: "服务端已归档正文" }) } : {}),
            }),
        },
    });
    globalThis.fetch = (async () => {
        streamCalls += 1;
        const sse = 'event: progress\ndata: {"status":"running","stage":"生成中","progress":20}\n\nevent: error\ndata: {"message":"任务文本流不可用"}\n\n';
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    try {
        await expect(
            waitForGenerationTask("task-progress-then-error", {
                initialTask: buildTask({ id: "task-progress-then-error", type: "canvas_text", status: "running" }),
                intervalMs: 1,
                useTextEvents: true,
            }),
        ).rejects.toThrow("任务文本流同步失败：任务文本流不可用");
        expect(streamCalls).toBe(5);

        streamCalls = 0;
        backendStatus = "succeeded";
        const settled = await waitForGenerationTask("task-progress-then-error", {
            initialTask: buildTask({ id: "task-progress-then-error", type: "canvas_text", status: "running" }),
            intervalMs: 1,
            useTextEvents: true,
        });
        expect(streamCalls).toBe(1);
        expect(settled.status).toBe("succeeded");
    } finally {
        window.setTimeout = originalSetTimeout;
        globalThis.fetch = originalFetch;
        apiClient.defaults.adapter = originalAdapter;
    }
});

test("waitForGenerationTask keeps polling live text_replay containers until completeTextReplayTask sets succeeded", async () => {
    const originalAdapter = apiClient.defaults.adapter;
    const originalSetTimeout = window.setTimeout;
    let polls = 0;
    window.setTimeout = ((cb: TimerHandler) => {
        if (typeof cb === "function") queueMicrotask(() => cb());
        return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof window.setTimeout;
    apiClient.defaults.adapter = async (config) => {
        polls += 1;
        const data = polls < 3
            ? buildTask({ id: "task-live-replay", type: "canvas_text", status: "text_replay", outcome: { phase: "failed", regenerate: "confirm", reason: "task_failed" } })
            : buildTask({ id: "task-live-replay", type: "canvas_text", status: "succeeded", resultText: "前端已完成流式回放", outcome: { phase: "ready", regenerate: "allowed", reason: "completed" } });
        return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "", data } };
    };
    try {
        const settled = await waitForGenerationTask("task-live-replay", { intervalMs: 1 });
        expect(polls).toBe(3);
        expect(settled.status).toBe("succeeded");
        expect(settled.resultText).toBe("前端已完成流式回放");
    } finally {
        window.setTimeout = originalSetTimeout;
        apiClient.defaults.adapter = originalAdapter;
    }
});

test("resumable text SSE fails after 5 immediate empty-200 fast-EOF responses without progress", async () => {
    const originalNow = Date.now;
    const originalAdapter = apiClient.defaults.adapter;
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = window.setTimeout;
    let now = originalNow();
    let streamCalls = 0;
    Date.now = () => now;
    window.setTimeout = ((cb: TimerHandler) => {
        now += 100;
        if (typeof cb === "function") queueMicrotask(() => cb());
        return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof window.setTimeout;
    apiClient.defaults.adapter = async (config) => {
        now += 6_000;
        return {
            config,
            status: 200,
            statusText: "OK",
            headers: {},
            data: { code: 0, msg: "", data: buildTask({ id: "task-fast-eof", type: "canvas_text", status: "running" }) },
        };
    };
    globalThis.fetch = (async () => {
        streamCalls += 1;
        now += 50;
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    try {
        await expect(
            waitForGenerationTask("task-fast-eof", {
                initialTask: buildTask({ id: "task-fast-eof", type: "canvas_text", status: "running" }),
                intervalMs: 1,
                useTextEvents: true,
            }),
        ).rejects.toThrow("任务文本流同步失败：任务文本流连接提前结束");
        expect(streamCalls).toBe(5);
    } finally {
        Date.now = originalNow;
        window.setTimeout = originalSetTimeout;
        globalThis.fetch = originalFetch;
        apiClient.defaults.adapter = originalAdapter;
    }
});

test("task subscription aborts background observation on final unsubscribe and publishes server-authoritative text_replay state verbatim", async () => {
    let observedSignal: AbortSignal | undefined;
    let waitCalls = 0;
    const serverOutcome = { phase: "failed", regenerate: "confirm", reason: "task_failed" } as const;
    const service = createGenerationTaskSubscriptionService({
        async queryTask(id) {
            if (id === "task-orphan-replay") {
                return buildTask({
                    id,
                    type: "canvas_text",
                    status: "text_replay",
                    stage: "文本持久化（前端自管）",
                    outcome: serverOutcome,
                });
            }
            return buildTask({ id, status: "running" });
        },
        waitTask(_id, options) {
            waitCalls += 1;
            observedSignal = options?.signal;
            return new Promise<GenerationTask>((_resolve, reject) => {
                options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
            });
        },
        notifyTaskChanged: () => undefined,
    });

    const unsub = service.subscribe(["task-live-watch"], () => undefined);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(waitCalls).toBe(1);
    expect(observedSignal?.aborted).toBe(false);

    unsub();
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(observedSignal?.aborted).toBe(true);

    const replayUpdates: GenerationTask[] = [];
    const unsubReplay = service.subscribe(["task-orphan-replay"], (task) => replayUpdates.push(task));
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    unsubReplay();
    expect(waitCalls).toBe(1);
    expect(replayUpdates.at(-1)).toMatchObject({
        id: "task-orphan-replay",
        status: "text_replay",
        outcome: serverOutcome,
    });
});

test("waitForGenerationTask polls through succeeded+retrievable and failed+retrievable until ready, and rejects succeeded+failed", async () => {
    const originalAdapter = apiClient.defaults.adapter;
    const originalSetTimeout = window.setTimeout;
    const delays: number[] = [];
    window.setTimeout = ((cb: TimerHandler, delay?: number) => {
        delays.push(delay ?? 0);
        if (typeof cb === "function") queueMicrotask(() => cb());
        return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof window.setTimeout;

    let retrievePolls = 0;
    let failedRecoverPolls = 0;
    let cancelledRecoverPolls = 0;
    apiClient.defaults.adapter = async (config) => {
        const url = String(config.url || "");
        if (url.endsWith("/task-succeeded-retrievable")) {
            retrievePolls += 1;
            const data = retrievePolls < 3
                ? buildTask({
                      id: "task-succeeded-retrievable",
                      status: "succeeded",
                      stage: "生成完成",
                      outcome: { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" },
                  })
                : buildTask({
                      id: "task-succeeded-retrievable",
                      status: "succeeded",
                      stage: "生成完成",
                      outcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
                  });
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "", data } };
        }
        if (url.endsWith("/task-failed-retrievable")) {
            failedRecoverPolls += 1;
            const data = failedRecoverPolls < 2
                ? buildTask({
                      id: "task-failed-retrievable",
                      status: "failed",
                      stage: "任务失败",
                      outcome: { phase: "retrievable", regenerate: "blocked", reason: "provider_result_pending" },
                  })
                : buildTask({
                      id: "task-failed-retrievable",
                      status: "succeeded",
                      stage: "生成完成",
                      outcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
                  });
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "", data } };
        }
        if (url.endsWith("/task-cancelled-retrievable")) {
            cancelledRecoverPolls += 1;
            const data = cancelledRecoverPolls < 2
                ? buildTask({
                      id: "task-cancelled-retrievable",
                      status: "cancelled",
                      stage: "任务已取消",
                      outcome: { phase: "retrievable", regenerate: "blocked", reason: "provider_result_pending" },
                  })
                : buildTask({
                      id: "task-cancelled-retrievable",
                      status: "cancelled",
                      stage: "生成完成",
                      outcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
                  });
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "", data } };
        }
        if (url.endsWith("/task-cancelled-failed")) {
            const data = buildTask({
                id: "task-cancelled-failed",
                status: "cancelled",
                stage: "任务已取消",
                outcome: { phase: "failed", regenerate: "allowed", reason: "no_result" },
            });
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "", data } };
        }
        const data = buildTask({
            id: "task-succeeded-failed",
            status: "succeeded",
            stage: "生成完成",
            outcome: { phase: "failed", regenerate: "confirm", reason: "result_unrecoverable" },
        });
        return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "", data } };
    };

    try {
        const readyAfterRetrieve = await waitForGenerationTask("task-succeeded-retrievable", { intervalMs: 2000 });
        expect(retrievePolls).toBe(3);
        expect(readyAfterRetrieve.outcome?.phase).toBe("ready");
        expect(delays.slice(0, 2)).toEqual([500, 500]);

        const readyAfterAutoRecover = await waitForGenerationTask("task-failed-retrievable", { intervalMs: 2000 });
        expect(failedRecoverPolls).toBe(2);
        expect(readyAfterAutoRecover.outcome?.phase).toBe("ready");

        const readyAfterCancelledRecover = await waitForGenerationTask("task-cancelled-retrievable", { intervalMs: 2000 });
        expect(cancelledRecoverPolls).toBe(2);
        expect(readyAfterCancelledRecover.status).toBe("cancelled");
        expect(readyAfterCancelledRecover.outcome?.phase).toBe("ready");

        let cancelledCaught: (Error & { taskOutcome?: unknown }) | undefined;
        try {
            await waitForGenerationTask("task-cancelled-failed", { intervalMs: 1 });
        } catch (error) {
            cancelledCaught = error as Error & { taskOutcome?: unknown };
        }
        expect(cancelledCaught?.message).toBe("任务已取消");
        expect(cancelledCaught?.taskOutcome).toEqual({ phase: "failed", regenerate: "allowed", reason: "no_result" });

        let caught: (Error & { taskOutcome?: unknown }) | undefined;
        try {
            await waitForGenerationTask("task-succeeded-failed", { intervalMs: 1 });
        } catch (error) {
            caught = error as Error & { taskOutcome?: unknown };
        }
        expect(caught).toBeDefined();
        expect(caught?.taskOutcome).toEqual({ phase: "failed", regenerate: "confirm", reason: "result_unrecoverable" });
    } finally {
        window.setTimeout = originalSetTimeout;
        apiClient.defaults.adapter = originalAdapter;
    }
});

test("resumable text SSE settles by authoritative outcome for succeeded+retrievable, failed+retrievable, and succeeded+failed", async () => {
    const originalAdapter = apiClient.defaults.adapter;
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = window.setTimeout;
    window.setTimeout = ((cb: TimerHandler) => {
        if (typeof cb === "function") queueMicrotask(() => cb());
        return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof window.setTimeout;

    globalThis.fetch = (async () =>
        new Response("event: terminal\ndata: {\"finalText\":\"文本已生成\"}\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
        })) as unknown as typeof fetch;

    let sseRetrieveQueries = 0;
    let sseFailedQueries = 0;
    let sseCancelledQueries = 0;
    apiClient.defaults.adapter = async (config) => {
        const url = String(config.url || "");
        if (url.endsWith("/sse-succeeded-retrievable")) {
            sseRetrieveQueries += 1;
            const data = sseRetrieveQueries < 2
                ? buildTask({
                      id: "sse-succeeded-retrievable",
                      type: "canvas_text",
                      status: "succeeded",
                      outcome: { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" },
                  })
                : buildTask({
                      id: "sse-succeeded-retrievable",
                      type: "canvas_text",
                      status: "succeeded",
                      resultText: "文本已生成",
                      outcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
                  });
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "", data } };
        }
        if (url.endsWith("/sse-failed-retrievable")) {
            sseFailedQueries += 1;
            const data = sseFailedQueries < 2
                ? buildTask({
                      id: "sse-failed-retrievable",
                      type: "canvas_text",
                      status: "failed",
                      outcome: { phase: "retrievable", regenerate: "blocked", reason: "evidence_unavailable" },
                  })
                : buildTask({
                      id: "sse-failed-retrievable",
                      type: "canvas_text",
                      status: "succeeded",
                      resultText: "恢复后文本",
                      outcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
                  });
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "", data } };
        }
        if (url.endsWith("/sse-cancelled-retrievable")) {
            sseCancelledQueries += 1;
            const data = sseCancelledQueries < 2
                ? buildTask({
                      id: "sse-cancelled-retrievable",
                      type: "canvas_text",
                      status: "cancelled",
                      outcome: { phase: "retrievable", regenerate: "blocked", reason: "provider_result_pending" },
                  })
                : buildTask({
                      id: "sse-cancelled-retrievable",
                      type: "canvas_text",
                      status: "cancelled",
                      resultText: "取消前已出结果",
                      outcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
                  });
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "", data } };
        }
        if (url.endsWith("/sse-cancelled-failed")) {
            const data = buildTask({
                id: "sse-cancelled-failed",
                type: "canvas_text",
                status: "cancelled",
                outcome: { phase: "failed", regenerate: "allowed", reason: "no_result" },
            });
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "", data } };
        }
        const data = buildTask({
            id: "sse-succeeded-failed",
            type: "canvas_text",
            status: "succeeded",
            outcome: { phase: "failed", regenerate: "confirm", reason: "result_unrecoverable" },
        });
        return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, msg: "", data } };
    };

    try {
        const retrieved = await waitForGenerationTask("sse-succeeded-retrievable", {
            initialTask: buildTask({ id: "sse-succeeded-retrievable", type: "canvas_text", status: "running" }),
            intervalMs: 1,
            useTextEvents: true,
        });
        expect(sseRetrieveQueries).toBe(2);
        expect(retrieved.outcome?.phase).toBe("ready");

        const recovered = await waitForGenerationTask("sse-failed-retrievable", {
            initialTask: buildTask({ id: "sse-failed-retrievable", type: "canvas_text", status: "running" }),
            intervalMs: 1,
            useTextEvents: true,
        });
        expect(sseFailedQueries).toBe(2);
        expect(recovered.outcome?.phase).toBe("ready");

        const cancelledRecovered = await waitForGenerationTask("sse-cancelled-retrievable", {
            initialTask: buildTask({ id: "sse-cancelled-retrievable", type: "canvas_text", status: "running" }),
            intervalMs: 1,
            useTextEvents: true,
        });
        expect(sseCancelledQueries).toBe(2);
        expect(cancelledRecovered.status).toBe("cancelled");
        expect(cancelledRecovered.outcome?.phase).toBe("ready");

        let cancelledSseCaught: (Error & { taskOutcome?: unknown }) | undefined;
        try {
            await waitForGenerationTask("sse-cancelled-failed", {
                initialTask: buildTask({ id: "sse-cancelled-failed", type: "canvas_text", status: "running" }),
                intervalMs: 1,
                useTextEvents: true,
            });
        } catch (error) {
            cancelledSseCaught = error as Error & { taskOutcome?: unknown };
        }
        expect(cancelledSseCaught?.message).toBe("任务已取消");
        expect(cancelledSseCaught?.taskOutcome).toEqual({ phase: "failed", regenerate: "allowed", reason: "no_result" });

        let caught: (Error & { taskOutcome?: unknown }) | undefined;
        try {
            await waitForGenerationTask("sse-succeeded-failed", {
                initialTask: buildTask({ id: "sse-succeeded-failed", type: "canvas_text", status: "running" }),
                intervalMs: 1,
                useTextEvents: true,
            });
        } catch (error) {
            caught = error as Error & { taskOutcome?: unknown };
        }
        expect(caught).toBeDefined();
        expect(caught?.taskOutcome).toEqual({ phase: "failed", regenerate: "confirm", reason: "result_unrecoverable" });
    } finally {
        window.setTimeout = originalSetTimeout;
        globalThis.fetch = originalFetch;
        apiClient.defaults.adapter = originalAdapter;
    }
});
