import { describe, expect, test } from "bun:test";
import { QISI_API_BASE_URL, OFFICIAL_LIKEAI_BASE_URL } from "../src/lib/likeai-service";
import { browserLikeAIRequest, buildLikeAICreateBody, fetchBrowserLikeAIModels, likeAIInput, LikeAIRequestError } from "../src/services/browser-likeai-client";
import { createBrowserLikeAITaskService, fetchBrowserLikeAIArtifact, prepareBrowserLikeAIReference, type BrowserLikeAITaskRecord } from "../src/services/browser-likeai-tasks";
import { createModelChannel, defaultConfig, encodeChannelModel, likeAIWorkspaceConfig } from "../src/stores/use-config-store";
import { prepareBackendGenerationTask } from "../src/services/api/generation-task";
import type { CreateTaskInput } from "../src/services/api/task-center";

function input(patch: Record<string, unknown> = {}) {
    return { mode: "video", prompt: "scene", config: { channelId: "qisi-api", apiKey: "customer-fixture-key", apiFormat: "likeai", interfaceType: "likeai-video", baseUrl: QISI_API_BASE_URL, model: "doubao_seedance_2_5", size: "adaptive", videoSeconds: "5", vquality: "720p", videoGenerateAudio: false }, ...patch };
}

describe("qisi API browser channel", () => {
    test("uses Bearer only at the fixed gateway and keeps direct LikeAI credentials separate", async () => {
        const calls: Array<{ url: string; headers: Headers }> = [];
        const fake = (async (url: unknown, init?: RequestInit) => {
            calls.push({ url: String(url), headers: new Headers(init?.headers) });
            return Response.json({ code: 200, data: { models: [] } });
        }) as typeof fetch;
        await browserLikeAIRequest("/task/models", "customer-key", { headers: { "X-API-Key": "must-be-removed" } }, fake, QISI_API_BASE_URL);
        await browserLikeAIRequest("/task/models", "official-key", { headers: { Authorization: "must-be-removed" } }, fake);
        expect(calls[0].url).toBe("/api-service/likeai/task/models");
        expect(calls[0].headers.get("Authorization")).toBe("Bearer customer-key");
        expect(calls[0].headers.has("X-API-Key")).toBe(false);
        expect(calls[1].url).toBe("/api/qisitv/likeai/task/models");
        expect(calls[1].headers.get("X-API-Key")).toBe("official-key");
        expect(calls[1].headers.has("Authorization")).toBe(false);
        await expect(browserLikeAIRequest("/task/models", "customer-key", {}, fake, "https://evil.example")).rejects.toThrow("地址");
        expect(calls).toHaveLength(2);
    });

    test("adds a separate empty gateway channel without moving existing Keys or selected models", () => {
        const previousFlag = process.env.VITE_QISITV_BROWSER_ONLY;
        process.env.VITE_QISITV_BROWSER_ONLY = "1";
        try {
            const official = createModelChannel({ id: "likeai", name: "LikeAI", apiFormat: "likeai", apiKey: "official-key", models: ["doubao_seedance_2_5"] });
            const active = likeAIWorkspaceConfig({ ...defaultConfig, channels: [official], videoModel: encodeChannelModel("likeai", "doubao_seedance_2_5") });
            const qisi = active.channels.find((channel) => channel.baseUrl === QISI_API_BASE_URL)!;
            expect(qisi.apiKey).toBe("");
            expect(qisi.models).toEqual([]);
            expect(active.channels.find((channel) => channel.id === "likeai")?.apiKey).toBe("official-key");
            expect(active.videoModel).toBe("likeai::doubao_seedance_2_5");
            const profile = likeAIWorkspaceConfig({ ...defaultConfig, channels: [{ ...qisi, models: ["doubao_seedance_2_5", "unsupported"] }] }).channels.find((channel) => channel.id === qisi.id)!;
            expect(profile.models).toEqual(["doubao_seedance_2_5"]);
            expect(profile.modelProfiles?.[0].capabilityConfig?.video?.duration).toEqual({ selection: "range", min: 4, max: 30, step: 1, default: 5 });
            expect(profile.modelProfiles?.[0].capabilityConfig?.video?.references.maxVideos).toBe(0);
            expect(profile.modelProfiles?.[0].capabilityConfig?.video?.references.maxAudios).toBe(0);
        } finally {
            if (previousFlag === undefined) delete process.env.VITE_QISITV_BROWSER_ONLY;
            else process.env.VITE_QISITV_BROWSER_ONLY = previousFlag;
        }
    });

    test("rejects unsupported paid input before upload or submission", () => {
        const base = input();
        for (const patch of [
            { config: { ...base.config, videoSeconds: "-1" } },
            { config: { ...base.config, systemPrompt: "separate instructions" } },
            { referenceVideos: [{ url: "https://media.example/ref.mp4" }] },
            { referenceAudios: [{ url: "https://media.example/ref.mp3" }] },
            { metadata: { providerOptions: { "likeai-video": { kwargs: { off_peak: true } } } } },
            { metadata: { providerOptions: { "likeai-video": { body: { duration: -1 } } } } },
        ]) expect(() => likeAIInput(input(patch))).toThrow();
        const body = buildLikeAICreateBody(likeAIInput(base));
        expect(body).toEqual({ api_name: "doubao_seedance_2_5", prompt: "scene", aspect_ratio: "adaptive", resolution: "720p", duration: 5, kwargs: { generate_audio: false } });
    });

    test("filters the catalog and accepts the flat official upload response through the gateway", async () => {
        const original = globalThis.fetch;
        const seen: string[] = [];
        globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
            if (String(url).startsWith("data:")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
            seen.push(String(url));
            expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer customer-key");
            if (String(url).endsWith("/files")) {
                expect(init?.body).toBeInstanceOf(FormData);
                return Response.json({ id: "file-1", object: "file", bytes: 3, url: "https://media.example/upload.png" });
            }
            return Response.json({ code: 200, data: { models: [{ api_name: "doubao_seedream_4_5", type: "image" }, { api_name: "doubao_seedance_2_5", type: "video" }, { api_name: "unpriced-model", type: "video" }] } });
        }) as typeof fetch;
        try {
            expect((await fetchBrowserLikeAIModels("customer-key", QISI_API_BASE_URL)).models).toEqual(["doubao_seedance_2_5", "doubao_seedream_4_5"]);
            const uploaded = await prepareBrowserLikeAIReference({ dataUrl: "data:image/png;base64,AQID", name: "reference.png" }, "image", "customer-key", QISI_API_BASE_URL);
            expect(uploaded.url).toBe("https://media.example/upload.png");
            expect(seen).toEqual(["/api-service/likeai/task/models", "/api-service/likeai/files"]);
        } finally { globalThis.fetch = original; }
    });

    test("prepares qisi models through the actual UI generation path", async () => {
        const previousFlag = process.env.VITE_QISITV_BROWSER_ONLY;
        process.env.VITE_QISITV_BROWSER_ONLY = "1";
        try {
            for (const mode of ["image", "video"] as const) {
                const model = mode === "image" ? "doubao_seedream_4_5" : "doubao_seedance_2_5";
                const channel = createModelChannel({ id: "qisi-api", name: "qisi API", apiFormat: "likeai", baseUrl: QISI_API_BASE_URL, apiKey: "customer-key", models: [model], modelProfiles: [{ model, capability: mode, protocol: `likeai-${mode}` }] });
                const config = likeAIWorkspaceConfig({ ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, model), quality: "1440p", vquality: "720p", videoSeconds: "5", size: "adaptive" });
                const prepared = await prepareBackendGenerationTask({ mode, prompt: "scene", config, projectId: "project-local" });
                const request = likeAIInput(prepared.input);
                expect(request.config.baseUrl).toBe(QISI_API_BASE_URL);
                expect(request.config.apiKey).toBe("customer-key");
                expect(buildLikeAICreateBody(request).api_name).toBe(model);
            }
        } finally {
            if (previousFlag === undefined) delete process.env.VITE_QISITV_BROWSER_ONLY;
            else process.env.VITE_QISITV_BROWSER_ONLY = previousFlag;
        }
    });

    test("pins the task transport through reload and never persists a Key or repeats creation", async () => {
        const records = new Map<string, BrowserLikeAITaskRecord>();
        const paths: string[] = [];
        const deps = {
            store: { get: async (id: string) => structuredClone(records.get(id) || null), all: async () => structuredClone([...records.values()]), put: async (record: BrowserLikeAITaskRecord) => { records.set(record.task.id, structuredClone(record)); }, remove: async (id: string) => { records.delete(id); } },
            lock: async <T>(_name: string, action: () => Promise<T>) => action(),
            credential: async (_id: string, base?: string) => { expect(base).toBe(QISI_API_BASE_URL); return "customer-key"; },
            reference: async (ref: Record<string, unknown>) => ref,
            request: async (path: string, _key: string, _init?: RequestInit, _fetch?: typeof fetch, base?: string) => {
                expect(base).toBe(QISI_API_BASE_URL); paths.push(path);
                return { code: 200, data: { task_id: "qisi-task-id", status: "queued" } };
            },
            download: async (result: Record<string, unknown>) => result,
        };
        const service = createBrowserLikeAITaskService(deps as never);
        const created = await service.create({ type: "canvas_video", projectId: "project", prompt: "scene", input: input() } as CreateTaskInput);
        expect(records.get(created.id)?.serviceBaseUrl).toBe(QISI_API_BASE_URL);
        await createBrowserLikeAITaskService(deps as never).query(created.id);
        expect(paths).toEqual(["/task/create_task", "/task/query_task/qisi-task-id"]);
        expect(JSON.stringify([...records.values()])).not.toContain("customer-fixture-key");
        // Records created before gateway support had no service snapshot.
        const legacy = records.get(created.id)!;
        delete legacy.serviceBaseUrl;
        legacy.channelId = "old-likeai";
        let legacyBase = "";
        await createBrowserLikeAITaskService({ ...deps,
            credential: async (channelId: string, base?: string) => { expect(channelId).toBe("old-likeai"); expect(base).toBe(OFFICIAL_LIKEAI_BASE_URL); return "official-key"; },
            request: async (_path: string, key: string, _init?: RequestInit, _fetch?: typeof fetch, base?: string) => {
                expect(key).toBe("official-key"); legacyBase = base || "";
                return { code: 200, data: { task_id: "qisi-task-id", status: "queued" } };
            },
        } as never).query(created.id);
        expect(legacyBase).toBe(OFFICIAL_LIKEAI_BASE_URL);
    });

    test("uses gateway ownership-based download fallback without sending Key to CDN", async () => {
        for (const kind of ["image", "video", "audio"] as const) {
            let count = 0;
            const index = kind === "image" ? 2 : 0;
            const mime = kind === "image" ? "image/png" : `${kind}/mp4`;
            const fake = (async (url: unknown, init?: RequestInit) => {
                count++;
                const headers = new Headers(init?.headers);
                if (count === 1) { expect(headers.has("Authorization")).toBe(false); throw new TypeError("CORS"); }
                expect(String(url)).toBe(`/api-service/likeai/task/artifact/qisi-task-id/${kind}s/${index}`);
                expect(headers.get("Authorization")).toBe("Bearer customer-key");
                expect(headers.has("X-API-Key")).toBe(false);
                const media = new Uint8Array(32);
                if (kind === "image") media.set([137, 80, 78, 71, 13, 10, 26, 10]);
                else media.set(new TextEncoder().encode("ftypisom"), 4);
                return new Response(media, { headers: { "Content-Type": mime } });
            }) as typeof fetch;
            expect((await fetchBrowserLikeAIArtifact({ url: "https://media.example/result", providerId: "qisi-task-id", kind, index, apiKey: "customer-key", baseUrl: QISI_API_BASE_URL, fetchImpl: fake })).type).toBe(mime);
        }
    });

    test("reports definite gateway rejection separately from an uncertain submission", async () => {
        const fake = (async () => new Response("", { status: 402 })) as typeof fetch;
        try { await browserLikeAIRequest("/task/create_task", "key", {}, fake, QISI_API_BASE_URL); throw new Error("expected rejection"); }
        catch (error) { expect(error).toBeInstanceOf(LikeAIRequestError); expect((error as LikeAIRequestError).rejected).toBe(true); expect((error as Error).message).toContain("余额"); }
        try { await browserLikeAIRequest("/task/create_task", "key", {}, fake, OFFICIAL_LIKEAI_BASE_URL); throw new Error("expected rejection"); }
        catch (error) { expect((error as LikeAIRequestError).rejected).toBe(false); }
    });
});
