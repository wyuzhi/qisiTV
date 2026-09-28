import { describe, expect, test } from "bun:test";
import { browserLikeAIRequest, buildLikeAICreateBody, likeAIInput, parseLikeAIResponse } from "../src/services/browser-likeai-client";
import { createBrowserLikeAITaskService, fetchBrowserLikeAIArtifact, type BrowserLikeAITaskRecord, type BrowserLikeAITaskStore } from "../src/services/browser-likeai-tasks";
import type { CreateTaskInput } from "../src/services/api/task-center";
import { prepareBackendGenerationTask, backendProviderConfig } from "../src/services/api/generation-task";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";

function request(overrides: Record<string, unknown> = {}): CreateTaskInput {
    return { projectId: "canvas-1", type: "canvas_video", prompt: "scene", input: {
        mode: "video", prompt: "scene", config: { channelId: "likeai", apiFormat: "likeai", interfaceType: "likeai-video", baseUrl: "https://task.likeai.pro/task-api", apiKey: "test-api-key", model: "doubao_seedance_2_5", size: "adaptive", videoSeconds: "5", vquality: "720p", videoGenerateAudio: true },
        metadata: { nodeId: "node-1", clientOperationId: "operation-1", batchIndex: 0, apiKey: "must-not-persist", providerOptions: { "likeai-video": { body: { private_field: "must-not-persist" } } } },
        ...overrides,
    } };
}

function fixture(options: { request?: (path: string) => Promise<Record<string, unknown>>; downloadFails?: boolean; storeFails?: boolean } = {}) {
    const records = new Map<string, BrowserLikeAITaskRecord>();
    const calls: string[] = [];
    const requests: Array<{ path: string; method?: string; body?: Record<string, unknown> }> = [];
    let sequence = 0;
    let downloadFails = options.downloadFails || false;
    const store: BrowserLikeAITaskStore = {
        get: async (id) => structuredClone(records.get(id) || null),
        all: async () => structuredClone([...records.values()]),
        put: async (record) => { if (options.storeFails) throw new Error("storage unavailable"); records.set(record.task.id, structuredClone(record)); },
        remove: async (id) => { records.delete(id); },
    };
    const tails = new Map<string, Promise<unknown>>();
    const lock = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
        const operation = (tails.get(name) || Promise.resolve()).catch(() => undefined).then(action);
        tails.set(name, operation);
        try { return await operation; } finally { if (tails.get(name) === operation) tails.delete(name); }
    };
    const dependencies = {
        store, lock,
        id: () => `id-${++sequence}`,
        now: () => "2026-09-28T00:00:00.000Z",
        credential: async () => "current-api-key",
        reference: async (ref: Record<string, unknown>) => ({ ...ref, url: "https://media.example/reference.png" }),
        request: async (path: string, _apiKey: string, init?: RequestInit) => {
            calls.push(path);
            requests.push({ path, method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
            expect(records.size).toBeGreaterThan(0);
            if (options.request) return options.request(path);
            return path === "/task/create_task" ? { code: 200, data: { task_id: "provider-1", status: "queued" } }
                : { code: 200, data: { task_id: "provider-1", status: "completed", result: { videos: ["https://media.example/result.mp4"] } } };
        },
        download: async (result: { mode?: string; video?: { dataUrl: string } }) => {
            calls.push("download");
            if (downloadFails) throw new Error("CORS / quota");
            return { ...result, video: { ...result.video!, storageKey: "video:local:result", mimeType: "video/mp4", bytes: 100 } } as never;
        },
    };
    const service = createBrowserLikeAITaskService(dependencies);
    return { records, calls, requests, store, service, reopen: () => createBrowserLikeAITaskService(dependencies), allowDownloads: () => { downloadFails = false; } };
}

describe("LikeAI browser protocol", () => {
    test("keeps the selected model and explicit frame roles, and maps model-specific audio options", () => {
        const input = likeAIInput(request({ referenceImages: [{ id: "first", url: "https://media.example/first.png" }, { id: "ref", url: "https://media.example/ref.png" }], metadata: { videoStartFrameNodeId: "first", providerOptions: { "likeai-video": { body: { api_name: "wrong" }, duration: -1, kwargs: { off_peak: true } } } } }).input);
        const body = buildLikeAICreateBody(input);
        expect(body.api_name).toBe("doubao_seedance_2_5");
        expect(body.first_image_url).toBe("https://media.example/first.png");
        expect(body.image_urls).toEqual(["https://media.example/ref.png"]);
        expect(body.duration).toBe(-1);
        expect(body.kwargs).toEqual({ generate_audio: true, off_peak: true });
        input.config.model = "like_lite_1";
        expect(buildLikeAICreateBody(input).kwargs).toEqual({ bgm: true, off_peak: true });
    });

    test("rejects unsupported masks and contradictory frame roles before submission", () => {
        expect(() => likeAIInput(request({ mask: {} }).input)).toThrow("蒙版");
        const input = likeAIInput(request({ referenceImages: [{ id: "last", url: "https://media.example/last.png" }], metadata: { videoEndFrameNodeId: "last" } }).input);
        expect(() => buildLikeAICreateBody(input)).toThrow("尾帧");
        input.metadata = { videoStartFrameNodeId: "missing" };
        expect(() => buildLikeAICreateBody(input)).toThrow("首帧");
    });

    test("parses terminal results strictly without disguising unknown status or business errors", () => {
        expect(parseLikeAIResponse({ code: 200, data: { status: "completed", result: { images: ["https://media.example/result.png"] } } }, "image").status).toBe("succeeded");
        expect(() => parseLikeAIResponse({ code: 500, data: {} }, "image")).toThrow();
        expect(() => parseLikeAIResponse({ code: 200, data: { status: "unknown" } }, "image")).toThrow("未知");
        expect(() => parseLikeAIResponse({ code: 200, data: { status: "completed", result: {} } }, "video")).toThrow("未返回");
        expect(() => parseLikeAIResponse({ code: 200, data: { status: "completed", result: { images: ["javascript:bad"] } } }, "image")).toThrow("HTTPS");
    });

    test("sends credentials only to the fixed same-origin proxy in headers", async () => {
        let observed: { url: string; init?: RequestInit } | undefined;
        const fakeFetch = (async (url: unknown, init?: RequestInit) => {
            observed = { url: String(url), init };
            return new Response(JSON.stringify({ code: 200, data: { models: [] } }), { headers: { "Content-Type": "application/json" } });
        }) as typeof fetch;
        await browserLikeAIRequest("/task/models", "test-api-key", {}, fakeFetch);
        expect(observed?.url).toBe("/api/qisitv/likeai/task/models");
        expect(observed?.url).not.toContain("test-api-key");
        expect(new Headers(observed?.init?.headers).get("X-API-Key")).toBe("test-api-key");
        expect(observed?.init?.credentials).toBe("omit");
        await expect(browserLikeAIRequest("https://evil.example", "test-api-key", {}, fakeFetch)).rejects.toThrow("路径");
    });
});

describe("browser persisted LikeAI lifecycle", () => {
    test("prepares a real configured UI model and submits it through the browser service", async () => {
        const previousFlag = process.env.VITE_QISITV_BROWSER_ONLY;
        process.env.VITE_QISITV_BROWSER_ONLY = "1";
        try {
            for (const mode of ["image", "video", "text", "audio"] as const) {
                const model = mode === "video" ? "doubao_seedance_2_5" : `${mode}-model`;
                const channel = createModelChannel({
                    id: "my-likeai", name: "LikeAI", scope: "user", apiFormat: "likeai", baseUrl: "https://task.likeai.pro/task-api", apiKey: "test-api-key", models: [model],
                    modelProfiles: [{ model, capability: mode, protocol: `likeai-${mode}`, billingMode: "fixed_request", unitPriceMicrocredits: 0 }],
                });
                const config = { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, model), quality: "1080p", vquality: "720p", videoSeconds: "5", size: mode === "video" ? "adaptive" : "16:9", videoGenerateAudio: "true" };
                const taskOptions = { mode, prompt: "actual UI configuration", config, projectId: "canvas-real", metadata: { nodeId: "node-real", ...(mode === "video" ? { videoStartFrameNodeId: "ref-1" } : {}) }, clientOperationId: `real-${mode}`,
                    referenceImages: mode === "image" || mode === "video" ? [{ id: "ref-1", name: "ref.png", type: "image/png", dataUrl: "", storageKey: "image:local:ref-1", width: 1024, height: 1024, bytes: 128 }] : [],
                };
                const prepared = await prepareBackendGenerationTask(taskOptions);
                expect(prepared.input?.config).toMatchObject({ channelId: "my-likeai", apiFormat: "likeai", interfaceType: `likeai-${mode}`, model, apiKey: "test-api-key" });
                const f = fixture();
                const accepted = await f.service.create(prepared);
                expect(accepted.status).toBe("queued");
                expect(accepted.providerRequestId).toBe("provider-1");
                expect(accepted.clientContext?.nodeId).toBe("node-real");
                expect(f.calls).toEqual(["/task/create_task"]);
                expect(f.requests[0].method).toBe("POST");
                expect(f.requests[0].body).toMatchObject({ api_name: model, prompt: "actual UI configuration" });
                if (mode === "image") expect(f.requests[0].body).toMatchObject({ image_urls: ["https://media.example/reference.png"], resolution: "1080p", aspect_ratio: "16:9" });
                if (mode === "video") {
                    expect(f.requests[0].body).toMatchObject({ first_image_url: "https://media.example/reference.png", duration: 5, resolution: "720p", aspect_ratio: "adaptive", kwargs: { generate_audio: true } });
                    const invalid = await prepareBackendGenerationTask({ ...taskOptions, config: { ...config, size: "16:9" }, clientOperationId: "bad-first-frame" });
                    await expect(f.service.create(invalid)).rejects.toThrow("adaptive");
                    expect(f.calls).toEqual(["/task/create_task"]);
                }
                expect(JSON.stringify([...f.records.values()])).not.toContain("test-api-key");

                delete process.env.VITE_QISITV_BROWSER_ONLY;
                expect(backendProviderConfig(config, mode)).toMatchObject({ channelId: "", apiFormat: "openai", interfaceType: `likeai-${mode}` });
                process.env.VITE_QISITV_BROWSER_ONLY = "1";
            }
        } finally {
            if (previousFlag === undefined) delete process.env.VITE_QISITV_BROWSER_ONLY;
            else process.env.VITE_QISITV_BROWSER_ONLY = previousFlag;
        }
    });

    test("deduplicates concurrent submissions and never persists API keys or provider options", async () => {
        const f = fixture();
        const [a, b] = await Promise.all([f.service.create(request()), f.service.create(request())]);
        expect(a.id).toBe(b.id);
        expect(f.calls).toEqual(["/task/create_task"]);
        const saved = JSON.stringify([...f.records.values()]);
        expect(saved).not.toContain("test-api-key");
        expect(saved).not.toContain("must-not-persist");
        expect(saved).not.toContain("apiKey");
        expect(a.clientContext?.nodeId).toBe("node-1");
        expect(a.providerRequestId).toBe("provider-1");
    });

    test("resumes after refresh by querying the accepted ID and downloading locally", async () => {
        const f = fixture();
        const pending = await f.service.create(request());
        const completed = await f.reopen().query(pending.id);
        expect(f.calls).toEqual(["/task/create_task", "/task/query_task/provider-1", "download"]);
        expect(completed.status).toBe("succeeded");
        expect(JSON.parse(completed.resultJson!).video.storageKey).toBe("video:local:result");
        expect(completed.outputs).toEqual([{ outputIndex: 0, mediaType: "video", providerArtifactRef: "video:local:result" }]);
        await f.reopen().query(pending.id);
        expect(f.calls).toHaveLength(3);
    });

    test("force-refresh preserves downloaded storage keys and materialization state", async () => {
        const f = fixture();
        const pending = await f.service.create(request());
        const completed = await f.service.query(pending.id);
        const stored = f.records.get(pending.id)!;
        stored.task.resultState = "READY";
        stored.task.outputs![0].materializedAssetId = "asset-1";
        const refreshed = await f.reopen().query(pending.id, undefined, true);
        expect(refreshed.resultJson).toBe(completed.resultJson);
        expect(JSON.parse(refreshed.resultJson!).video.storageKey).toBe("video:local:result");
        expect(refreshed.resultState).toBe("READY");
        expect(refreshed.outputs![0].materializedAssetId).toBe("asset-1");
        expect(refreshed.stage).toBe("completed");
        expect(f.calls).toEqual(["/task/create_task", "/task/query_task/provider-1", "download", "/task/query_task/provider-1"]);
        expect(JSON.parse(f.records.get(pending.id)!.task.resultJson!).video.storageKey).toBe("video:local:result");
    });

    test("an uncertain submission remains deduplicated and is never retried on refresh", async () => {
        const f = fixture({ request: async () => { throw new TypeError("Network error with test-api-key"); } });
        const failed = await f.service.create(request());
        expect(failed.status).toBe("failed");
        expect(failed.errorCode).toBe("submission_uncertain");
        expect(failed.error).not.toContain("test-api-key");
        await f.reopen().create(request());
        await f.reopen().query(failed.id);
        expect(f.calls).toEqual(["/task/create_task"]);
    });

    test("does not make a paid request when persistence is unavailable", async () => {
        const f = fixture({ storeFails: true });
        await expect(f.service.create(request())).rejects.toThrow("storage unavailable");
        expect(f.calls).toEqual([]);
    });

    test("stops local waiting without claiming provider cancellation or resubmitting", async () => {
        const f = fixture();
        const pending = await f.service.create(request());
        const cancelled = await f.service.cancel(pending.id);
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.providerCancelStatus).toBe("uncertain");
        expect(cancelled.error).toContain("计费");
        await f.reopen().query(pending.id);
        expect(f.calls).toEqual(["/task/create_task"]);
        const recovered = await f.reopen().query(pending.id, undefined, true);
        expect(recovered.status).toBe("succeeded");
        expect(f.calls.filter((path) => path === "/task/create_task")).toHaveLength(1);
    });

    test("retains completed provider results on download failure and retries only downloading", async () => {
        const f = fixture({ downloadFails: true });
        const pending = await f.service.create(request());
        const failedDownload = await f.service.query(pending.id);
        expect(failedDownload.status).toBe("succeeded");
        expect(failedDownload.resultState).toBe("FAILED_RETRYABLE");
        expect(failedDownload.previewUrl).toBe("https://media.example/result.mp4");
        f.allowDownloads();
        const recovered = await f.reopen().query(pending.id);
        expect(recovered.stage).toBe("completed");
        expect(f.calls).toEqual(["/task/create_task", "/task/query_task/provider-1", "download", "download"]);
    });

    test("removing visible history preserves the operation receipt against duplicate charges", async () => {
        const f = fixture();
        const pending = await f.service.create(request());
        await f.service.cancel(pending.id);
        await f.service.remove(pending.id);
        expect(await f.service.list(20)).toEqual([]);
        expect((await f.service.create(request())).id).toBe(pending.id);
        expect(f.calls).toEqual(["/task/create_task"]);
    });
});

describe("LikeAI browser artifact downloads", () => {
    const mp4 = new Uint8Array(32);
    mp4.set(new TextEncoder().encode("ftypisom"), 4);
    const options = { url: "https://media.example/result.mp4", providerId: "provider-1", kind: "video" as const, index: 0, apiKey: "test-api-key" };

    test("falls back from CDN CORS to authenticated artifact relay and detects octet-stream media", async () => {
        const requests: Array<{ url: string; headers: Headers }> = [];
        const fetchImpl = (async (url: unknown, init?: RequestInit) => {
            requests.push({ url: String(url), headers: new Headers(init?.headers) });
            if (String(url).startsWith("https:")) throw new TypeError("CORS");
            return new Response(mp4, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(mp4.length) } });
        }) as typeof fetch;
        const blob = await fetchBrowserLikeAIArtifact({ ...options, fetchImpl });
        expect(blob.type).toBe("video/mp4");
        expect(blob.size).toBe(32);
        expect(requests[0].headers.has("X-API-Key")).toBe(false);
        expect(requests[1].url).toBe("/api/qisitv/likeai/task/artifact/provider-1/video/0");
        expect(requests[1].headers.get("X-API-Key")).toBe("test-api-key");
    });

    test("uses a CORS-enabled CDN without sharing the API key or requesting the relay", async () => {
        let count = 0;
        const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
            count += 1;
            expect(new Headers(init?.headers).has("X-API-Key")).toBe(false);
            return new Response(mp4, { headers: { "Content-Type": "video/mp4" } });
        }) as typeof fetch;
        expect((await fetchBrowserLikeAIArtifact({ ...options, fetchImpl })).type).toBe("video/mp4");
        expect(count).toBe(1);
    });

    test("rejects incomplete downloads and HTML disguised as a video", async () => {
        const incomplete = (async (url: unknown) => {
            if (String(url).startsWith("https:")) throw new TypeError("CORS");
            return new Response(mp4, { headers: { "Content-Type": "application/octet-stream", "Content-Length": "100" } });
        }) as typeof fetch;
        await expect(fetchBrowserLikeAIArtifact({ ...options, fetchImpl: incomplete })).rejects.toThrow("不完整");
        const html = (async () => new Response("<html>error</html>", { headers: { "Content-Type": "video/mp4" } })) as typeof fetch;
        await expect(fetchBrowserLikeAIArtifact({ ...options, fetchImpl: html })).rejects.toThrow("有效媒体");
    });

    test("reports relay limits without attempting another generation", async () => {
        const fetchImpl = (async (url: unknown) => {
            if (String(url).startsWith("https:")) throw new TypeError("CORS");
            return new Response("Too large", { status: 413 });
        }) as typeof fetch;
        await expect(fetchBrowserLikeAIArtifact({ ...options, fetchImpl })).rejects.toThrow("原结果链接");
    });
});
