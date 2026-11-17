import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { convertEditorGraph, editorNodeTypes, extractAppMode } from "../../plugin-packages/beeftv-plugin-comfyui/lib/editor.mjs";
import { applyWorkflowParameters, inputTargets, missingNodeTypes, outputNodeIds, prepareWorkflow, randomizeSeeds, workflowOutputKind } from "../../plugin-packages/beeftv-plugin-comfyui/lib/workflow.mjs";
import * as provider from "../../plugin-packages/beeftv-plugin-comfyui/provider.mjs";

// 只列出用到的节点，形状和 ComfyUI 的 /object_info 一致。
const objectInfo = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [["model.safetensors"]] } } },
    EmptyLatentImage: { input: { required: { width: ["INT", { default: 512 }], height: ["INT", { default: 512 }], batch_size: ["INT", { default: 1 }] } } },
    CLIPTextEncode: { input: { required: { text: ["STRING", { multiline: true }], clip: ["CLIP"] } } },
    KSampler: {
        input: {
            required: {
                model: ["MODEL"], seed: ["INT", { default: 0, control_after_generate: true }], steps: ["INT", { default: 20 }], cfg: ["FLOAT", { default: 8 }],
                sampler_name: [["euler", "dpmpp_2m"]], scheduler: [["normal", "karras"]], positive: ["CONDITIONING"], negative: ["CONDITIONING"],
                latent_image: ["LATENT"], denoise: ["FLOAT", { default: 1 }],
            },
        },
    },
    VAEDecode: { input: { required: { samples: ["LATENT"], vae: ["VAE"] } } },
    SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING", { default: "ComfyUI" }] } } },
    PreviewImage: { input: { required: { images: ["IMAGE"] } } },
    LoadImage: { input: { required: { image: [["example.png"], { image_upload: true }] } } },
    ImageInvert: { input: { required: { image: ["IMAGE"] } } },
};

function textToImage(seedControl: string) {
    return {
        nodes: [
            { id: 4, type: "CheckpointLoaderSimple", mode: 0, inputs: [], widgets_values: ["model.safetensors"] },
            { id: 5, type: "EmptyLatentImage", mode: 0, inputs: [], widgets_values: [512, 768, 1] },
            { id: 6, type: "CLIPTextEncode", title: "正向", mode: 0, inputs: [{ name: "clip", type: "CLIP", link: 1 }], widgets_values: ["a cat"] },
            { id: 7, type: "CLIPTextEncode", title: "反向", mode: 0, inputs: [{ name: "clip", type: "CLIP", link: 2 }], widgets_values: ["blurry"] },
            { id: 11, type: "Reroute", mode: 0, inputs: [{ name: "", type: "*", link: 3 }], outputs: [{ type: "CONDITIONING" }] },
            {
                id: 3, type: "KSampler", mode: 0,
                inputs: [{ name: "model", link: 4 }, { name: "positive", link: 5 }, { name: "negative", link: 6 }, { name: "latent_image", link: 7 }],
                widgets_values: [42, seedControl, 20, 7, "euler", "normal", 1],
            },
            { id: 8, type: "VAEDecode", mode: 0, inputs: [{ name: "samples", link: 8 }, { name: "vae", link: 9 }], widgets_values: [] },
            { id: 9, type: "SaveImage", mode: 0, inputs: [{ name: "images", link: 10 }], widgets_values: ["out"] },
            { id: 12, type: "PreviewImage", mode: 2, inputs: [{ name: "images", link: 11 }], widgets_values: [] },
            { id: 10, type: "Note", mode: 0, inputs: [], widgets_values: ["只是备注"] },
        ],
        links: [
            [1, 4, 1, 6, 0, "CLIP"], [2, 4, 1, 7, 0, "CLIP"], [3, 6, 0, 11, 0, "CONDITIONING"], [4, 4, 0, 3, 0, "MODEL"],
            [5, 11, 0, 3, 1, "CONDITIONING"], [6, 7, 0, 3, 2, "CONDITIONING"], [7, 5, 0, 3, 3, "LATENT"],
            [8, 3, 0, 8, 0, "LATENT"], [9, 4, 2, 8, 1, "VAE"], [10, 8, 0, 9, 0, "IMAGE"], [11, 8, 0, 12, 0, "IMAGE"],
        ],
        extra: {},
    };
}

const invertApp = {
    nodes: [
        { id: 1, type: "LoadImage", mode: 0, inputs: [], widgets_values: ["example.png", "image"] },
        { id: 2, type: "ImageInvert", mode: 0, inputs: [{ name: "image", link: 1 }], widgets_values: [] },
        { id: 3, type: "SaveImage", mode: 0, inputs: [{ name: "images", link: 2 }], widgets_values: ["inverted"] },
        { id: 4, type: "PreviewImage", mode: 0, inputs: [{ name: "images", link: 3 }], widgets_values: [] },
    ],
    links: [[1, 1, 0, 2, 0, "IMAGE"], [2, 2, 0, 3, 0, "IMAGE"], [3, 1, 0, 4, 0, "IMAGE"]],
    extra: { linearData: { inputs: [["root:1:image", "image"]], outputs: [3] } },
};

describe("ComfyUI workflow conversion", () => {
    test("saved widget values are matched to input names, and hidden or muted nodes are left out", () => {
        const { graph, fixedSeeds } = convertEditorGraph(textToImage("fixed"), objectInfo);
        expect(Object.keys(graph).sort()).toEqual(["3", "4", "5", "6", "7", "8", "9"]);
        expect(graph["3"].inputs).toMatchObject({ seed: 42, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, positive: ["6", 0], negative: ["7", 0] });
        expect(graph["5"].inputs).toEqual({ width: 512, height: 768, batch_size: 1 });
        expect(graph["6"]._meta).toEqual({ title: "正向" });
        expect([...fixedSeeds]).toEqual(["3.seed"]);
    });

    test("without App Mode the prompt goes to the encoder wired to the sampler's positive input", () => {
        const prepared = prepareWorkflow(textToImage("randomize"), objectInfo);
        const targets = inputTargets(prepared);
        expect(targets.prompt).toEqual({ nodeId: "6", widget: "text" });
        expect(targets.media).toEqual({ image: [], video: [], audio: [] });
        expect(outputNodeIds(prepared)).toEqual(["9"]);
    });

    test("a fresh seed is used each time unless the author fixed it", () => {
        const randomized = prepareWorkflow(textToImage("randomize"), objectInfo);
        randomizeSeeds(randomized, () => 0.5);
        expect(randomized.graph["3"].inputs.seed).toBe(2 ** 47);
        const fixed = prepareWorkflow(textToImage("fixed"), objectInfo);
        randomizeSeeds(fixed, () => 0.5);
        expect(fixed.graph["3"].inputs.seed).toBe(42);
    });

    test("App Mode decides which inputs are filled and which outputs are returned", () => {
        const { graph } = convertEditorGraph(invertApp, objectInfo);
        expect(graph["1"].inputs).toEqual({ image: "example.png" });
        expect(extractAppMode(invertApp, Object.keys(graph))).toEqual({ inputs: [{ nodeId: "1", widget: "image" }], outputNodeIds: ["3"] });
        const prepared = prepareWorkflow(invertApp, objectInfo);
        expect(inputTargets(prepared)).toEqual({ prompt: null, media: { image: [{ nodeId: "1", widget: "image", mode: "annotated" }], video: [], audio: [] } });
        expect(outputNodeIds(prepared)).toEqual(["3"]);
    });

    test("a workflow is listed by what it produces", () => {
        expect(workflowOutputKind(invertApp)).toBe("image");
        expect(workflowOutputKind({ "1": { class_type: "LoadImage", inputs: {} }, "2": { class_type: "SaveVideo", inputs: {} }, "3": { class_type: "SaveImage", inputs: {} } })).toBe("video");
        expect(workflowOutputKind({ nodes: [{ id: 1, type: "SaveAudio", mode: 0 }, { id: 2, type: "SaveVideo", mode: 4 }] })).toBe("audio");
        expect(workflowOutputKind({ nodes: [{ id: 1, type: "Note", mode: 0 }] })).toBeNull();
    });
});

describe("ComfyUI provider against a ComfyUI server", () => {
    const workflows: Record<string, unknown> = { "invert.app.json": invertApp, "txt2img.json": textToImage("randomize"), "notes.json": { nodes: [{ id: 1, type: "Note", mode: 0 }] } };
    const uploads: Array<{ name: string; subfolder: string }> = [];
    const prompts: Array<{ prompt: Record<string, { inputs: Record<string, unknown> }>; extra_data: { beeftv: { outputs: string[] } } }> = [];
    let historyReady = false;
    let server: ReturnType<typeof Bun.serve>;
    let ctx: { config: { baseUrl: string }; signal: AbortSignal; log: (message: string) => void };

    beforeAll(() => {
        server = Bun.serve({
            port: 0,
            async fetch(request) {
                const url = new URL(request.url);
                if (url.pathname === "/api/userdata") return Response.json(Object.keys(workflows));
                if (url.pathname.startsWith("/api/userdata/")) {
                    const name = decodeURIComponent(url.pathname.slice("/api/userdata/".length)).replace(/^workflows\//, "");
                    return name in workflows ? Response.json(workflows[name]) : new Response("not found", { status: 404 });
                }
                if (url.pathname === "/api/object_info") return Response.json(objectInfo);
                if (url.pathname === "/api/upload/image") {
                    const form = await request.formData();
                    const file = form.get("image") as File;
                    uploads.push({ name: file.name, subfolder: String(form.get("subfolder")) });
                    return Response.json({ name: file.name, subfolder: "beeftv", type: "input" });
                }
                if (url.pathname === "/api/prompt") {
                    const body = await request.json();
                    if (body.prompt["3"]?.inputs?.steps === 999) {
                        return Response.json({ error: { message: "Prompt outputs failed validation" }, node_errors: { "3": { class_type: "KSampler", errors: [{ message: "Value too big", details: "steps: 999 > 100" }] } } }, { status: 400 });
                    }
                    prompts.push(body);
                    return Response.json({ prompt_id: "p1", number: 1 });
                }
                if (url.pathname === "/api/history/p1") {
                    if (!historyReady) return Response.json({});
                    return Response.json({
                        p1: {
                            prompt: [1, "p1", {}, { beeftv: { outputs: ["3"] } }, ["3", "4"]],
                            outputs: {
                                "3": { images: [{ filename: "inverted_00001_.png", subfolder: "", type: "output" }] },
                                "4": { images: [{ filename: "ComfyUI_temp_1.png", subfolder: "", type: "temp" }] },
                            },
                            status: { status_str: "success", completed: true, messages: [] },
                        },
                    });
                }
                if (url.pathname.startsWith("/api/history/")) return Response.json({});
                if (url.pathname === "/api/queue") return Response.json({ queue_running: historyReady ? [] : [[1, "p1", {}, {}, []]], queue_pending: [] });
                return new Response("unexpected", { status: 500 });
            },
        });
        ctx = { config: { baseUrl: `http://127.0.0.1:${server.port}/` }, signal: new AbortController().signal, log: () => {} };
    });
    afterAll(() => server.stop(true));

    test("each saved workflow that produces media is one model", async () => {
        expect(await provider.models(ctx)).toEqual([
            { id: "invert.app.json", displayName: "invert", capability: "image" },
            { id: "txt2img.json", displayName: "txt2img", capability: "image" },
        ]);
    });

    test("submit uploads the reference image and fills the prompt where the workflow expects it", async () => {
        const image = { dataUrl: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`, mimeType: "image/png" };
        expect(await provider.submit({ model: "invert.app.json", prompt: "", images: [image], extra: { idempotencyKey: "task-1" } }, ctx)).toEqual({ taskId: "p1", status: "pending" });
        expect(uploads).toEqual([{ name: "task-1-image-1.png", subfolder: "beeftv" }]);
        expect(prompts[0].prompt["1"].inputs.image).toBe("beeftv/task-1-image-1.png");
        expect(prompts[0].extra_data.beeftv.outputs).toEqual(["3"]);

        await provider.submit({ model: "txt2img.json", prompt: "a dog in the rain", extra: { idempotencyKey: "task-2" } }, ctx);
        expect(prompts[1].prompt["6"].inputs.text).toBe("a dog in the rain");
        expect(prompts[1].prompt["7"].inputs.text).toBe("blurry");
        expect(prompts[1].prompt["3"].inputs.seed).not.toBe(42);
    });

    test("submit reports what ComfyUI rejected, and refuses more media than the workflow takes", async () => {
        const image = { dataUrl: "data:image/png;base64,AA==", mimeType: "image/png" };
        expect(await provider.submit({ model: "invert.app.json", images: [image, image] }, ctx)).toEqual({ status: "failed", message: "这个工作流最多接收 1 个图片，这次给了 2 个" });
        expect(await provider.submit({ model: "txt2img.json", images: [image] }, ctx)).toEqual({ status: "failed", message: "这个工作流不接收图片，这次给了 1 个" });

        workflows["too-many-steps.json"] = { "3": { class_type: "KSampler", inputs: { steps: 999 } }, "9": { class_type: "SaveImage", inputs: {} } };
        const rejected = await provider.submit({ model: "too-many-steps.json" }, ctx);
        expect(rejected).toEqual({ status: "failed", message: "Prompt outputs failed validation：节点 3（KSampler）：steps: 999 > 100" });
        delete workflows["too-many-steps.json"];
    });

    test("a failure before anything is queued says why, instead of leaving the outcome unknown", async () => {
        const deleted = await provider.submit({ model: "deleted.json" }, ctx);
        expect(deleted.status).toBe("failed");
        expect(deleted.message).toContain("ComfyUI 里找不到工作流「deleted.json」");

        const stopped = Bun.serve({ port: 0, fetch: () => new Response("") });
        const baseUrl = `http://127.0.0.1:${stopped.port}`;
        stopped.stop(true);
        const unreachable = await provider.submit({ model: "invert.app.json" }, { ...ctx, config: { baseUrl } });
        expect(unreachable.status).toBe("failed");
        expect(unreachable.message).toContain("连不上 ComfyUI");
    });

    test("query follows the queue, then returns only the outputs the workflow picked", async () => {
        expect(await provider.query("p1", { model: "invert.app.json" }, ctx)).toEqual({ taskId: "p1", status: "processing" });
        historyReady = true;
        expect(await provider.query("p1", { model: "invert.app.json" }, ctx)).toEqual({
            taskId: "p1",
            status: "succeeded",
            result: {
                images: [{ url: `http://127.0.0.1:${server.port}/api/view?filename=inverted_00001_.png&subfolder=&type=output`, name: "inverted_00001_.png", mimeType: "image/png", kind: "image" }],
                videos: [],
                audios: [],
            },
        });
    });

    test("a task ComfyUI no longer knows about fails after a few checks", async () => {
        const states = [];
        for (let i = 0; i < 3; i += 1) states.push((await provider.query("gone", { model: "invert.app.json" }, ctx)).status);
        expect(states).toEqual(["processing", "processing", "failed"]);
    });

    test("community wireless SetNode/GetNode, rgthree cosmetic nodes, and audio/video loaders convert cleanly (#523)", async () => {
        const communityObjectInfo = {
            ...objectInfo,
            EmptyHunyuanLatentVideo: { input: { required: { width: ["INT", { default: 848 }], height: ["INT", { default: 480 }], length: ["INT", { default: 81 }], batch_size: ["INT", { default: 1 }] } } },
            LoadAudio: { input: { required: { audio: [["voice.wav"], { audio_upload: true }], audioUI: ["AUDIOUI", {}] } } },
            VHS_LoadVideoPath: { input: { required: { video: ["STRING", { default: "clip.mp4" }] } } },
            SaveVideo: { input: { required: { video: ["VIDEO"], filename_prefix: ["STRING", { default: "vid" }] } } },
        };
        const wirelessWorkflow = {
            nodes: [
                { id: 1, type: "CheckpointLoaderSimple", mode: 0, inputs: [], widgets_values: ["model.safetensors"] },
                { id: 2, type: "SetNode", mode: 0, inputs: [{ name: "CLIP", type: "CLIP", link: 1 }], widgets_values: ["shared_clip"] },
                { id: 3, type: "GetNode", mode: 0, inputs: [], outputs: [{ name: "CLIP", type: "CLIP", links: [2] }], widgets_values: ["shared_clip"] },
                { id: 4, type: "Reroute (rgthree)", mode: 0, inputs: [{ name: "", type: "*", link: 2 }], outputs: [{ type: "CLIP", links: [3] }] },
                { id: 5, type: "CLIPTextEncode", mode: 0, inputs: [{ name: "clip", type: "CLIP", link: 3 }], widgets_values: ["positive prompt"] },
                { id: 6, type: "EmptyHunyuanLatentVideo", mode: 0, inputs: [], widgets_values: [848, 480, 81, 1] },
                { id: 7, type: "LoadAudio", mode: 0, inputs: [], widgets_values: ["voice.wav", "audio"] },
                { id: 8, type: "VHS_LoadVideoPath", mode: 0, inputs: [], widgets_values: { video: "clip.mp4" } },
                { id: 9, type: "SaveVideo", mode: 0, inputs: [{ name: "video", link: 4 }], widgets_values: ["out"] },
                { id: 10, type: "Label (rgthree)", mode: 0, inputs: [], widgets_values: ["注记"] },
                { id: 11, type: "Fast Groups Muter (rgthree)", mode: 0, inputs: [], widgets_values: [] },
                { id: 12, type: "easy setNode", mode: 0, inputs: [{ name: "LATENT", type: "LATENT", link: 5 }], widgets_values: ["shared_lat"] },
                { id: 13, type: "easy getNode", mode: 0, inputs: [], outputs: [{ name: "LATENT", type: "LATENT", links: [6] }], widgets_values: ["shared_lat"] },
                { id: 14, type: "KSampler", mode: 0, inputs: [{ name: "model", link: 7 }, { name: "positive", link: 8 }, { name: "negative", link: 8 }, { name: "latent_image", link: 6 }], widgets_values: [7, "randomize", 20, 7, "euler", "normal", 1] },
            ],
            links: [
                [1, 1, 1, 2, 0, "CLIP"],
                [2, 3, 0, 4, 0, "CLIP"],
                [3, 4, 0, 5, 0, "CLIP"],
                [4, 8, 0, 9, 0, "VIDEO"],
                [5, 6, 0, 12, 0, "LATENT"],
                [6, 13, 0, 14, 3, "LATENT"],
                [7, 1, 0, 14, 0, "MODEL"],
                [8, 5, 0, 14, 1, "CONDITIONING"],
            ],
            extra: {},
        };

        expect(missingNodeTypes(wirelessWorkflow, communityObjectInfo)).toEqual([]);
        expect(editorNodeTypes(wirelessWorkflow)).not.toContain("SetNode");
        expect(editorNodeTypes(wirelessWorkflow)).not.toContain("GetNode");
        expect(editorNodeTypes(wirelessWorkflow)).not.toContain("Reroute (rgthree)");
        expect(editorNodeTypes(wirelessWorkflow)).not.toContain("Label (rgthree)");

        const prepared = prepareWorkflow(wirelessWorkflow, communityObjectInfo);
        expect(prepared.graph["5"].inputs.clip).toEqual(["1", 1]);
        expect(prepared.graph["14"].inputs.latent_image).toEqual(["6", 0]);
        expect(inputTargets(prepared).media.audio).toEqual([{ nodeId: "7", widget: "audio", mode: "annotated" }]);
        expect(inputTargets(prepared).media.video).toEqual([{ nodeId: "8", widget: "video", mode: "url" }]);

        applyWorkflowParameters(prepared, { aspectRatio: "9:16", resolution: "720p", duration: 6 });
        expect(prepared.graph["6"].inputs.width).toBe(720);
        expect(prepared.graph["6"].inputs.height).toBe(1280);
        expect(prepared.graph["6"].inputs.length).toBe(145);

        const untouched = prepareWorkflow(wirelessWorkflow, communityObjectInfo);
        applyWorkflowParameters(untouched, {});
        expect(untouched.graph["6"].inputs.width).toBe(848);
        expect(untouched.graph["6"].inputs.height).toBe(480);
        expect(untouched.graph["6"].inputs.length).toBe(81);
    });

    test("modified workflows sync cleanly with cache-no-store and objectInfoCache refresh (#540)", async () => {
        const seenCacheModes: string[] = [];
        let objectInfoFetches = 0;
        const dynamicWorkflows: Record<string, unknown> = {
            "sync-test.json": { nodes: [{ id: 1, type: "SaveImage", mode: 0, inputs: [], widgets_values: ["img"] }], links: [], extra: {} },
        };
        const originalFetch = globalThis.fetch;
        const syncServer = Bun.serve({
            port: 0,
            fetch(request) {
                const url = new URL(request.url);
                if (url.pathname === "/api/userdata") return Response.json(Object.keys(dynamicWorkflows));
                if (url.pathname === "/api/userdata/workflows%2Fsync-test.json") return Response.json(dynamicWorkflows["sync-test.json"]);
                if (url.pathname === "/api/object_info") {
                    objectInfoFetches += 1;
                    return Response.json(
                        objectInfoFetches === 1
                            ? objectInfo
                            : { ...objectInfo, SaveVideo: { input: { required: { video: ["VIDEO"], filename_prefix: ["STRING", { default: "vid" }] } } } },
                    );
                }
                if (url.pathname === "/api/prompt") return Response.json({ prompt_id: "p-sync", number: 1 });
                return new Response("not found", { status: 404 });
            },
        });
        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.cache) seenCacheModes.push(init.cache);
            return originalFetch(input, init);
        }) as typeof fetch;
        try {
            const syncCtx = { config: { baseUrl: `http://127.0.0.1:${syncServer.port}` }, signal: new AbortController().signal, log: () => {} };
            expect(await provider.models(syncCtx)).toEqual([{ id: "sync-test.json", displayName: "sync-test", capability: "image" }]);
            dynamicWorkflows["sync-test.json"] = { nodes: [{ id: 1, type: "SaveVideo", mode: 0, inputs: [], widgets_values: ["vid"] }], links: [], extra: {} };
            expect(await provider.models(syncCtx)).toEqual([{ id: "sync-test.json", displayName: "sync-test", capability: "video" }]);
            expect(seenCacheModes.length).toBeGreaterThan(0);
            expect(seenCacheModes.every((mode) => mode === "no-store")).toBe(true);
            const submitted = await provider.submit({ model: "sync-test.json", prompt: "" }, syncCtx);
            expect(submitted).toEqual({ taskId: "p-sync", status: "pending" });
            expect(objectInfoFetches).toBeGreaterThanOrEqual(1);
        } finally {
            globalThis.fetch = originalFetch;
            syncServer.stop(true);
        }
    });

    test("VHS_LoadVideoPath and VHS_LoadAudio receive /api/view URLs without mutating trim duration, and image latents stay intact unless App Mode opts in", async () => {
        const extraObjectInfo = {
            ...objectInfo,
            VHS_LoadVideoPath: { input: { required: { video: ["STRING", { default: "" }] } } },
            VHS_LoadAudio: { input: { required: { audio_file: ["STRING", { default: "" }], seek_seconds: ["FLOAT", { default: 0 }], duration: ["FLOAT", { default: 0 }] } } },
            Wan22ImageToVideoLatent: { input: { required: { width: ["INT", { default: 832 }], height: ["INT", { default: 480 }], length: ["INT", { default: 81 }], aspect_ratio: [["16:9", "9:16"], { default: "16:9" }] } } },
            WanFirstLastFrameToVideo: { input: { required: { width: ["INT", { default: 832 }], height: ["INT", { default: 480 }], length: ["INT", { default: 81 }] } } },
            SaveVideo: { input: { required: { video: ["VIDEO"], filename_prefix: ["STRING", { default: "vid" }] } } },
            "CR Aspect Ratio": { input: { required: { aspect_ratio: [["16:9", "9:16", "1:1"], { default: "16:9" }] } } },
        };
        const submittedPrompts: Array<Record<string, { inputs: Record<string, unknown> }>> = [];
        const testWorkflows: Record<string, unknown> = {
            "img-keep-latent.json": textToImage("fixed"),
            "img-app-latent.app.json": {
                nodes: [
                    { id: 5, type: "EmptyLatentImage", mode: 0, inputs: [], widgets_values: [512, 768, 1] },
                    { id: 9, type: "SaveImage", mode: 0, inputs: [{ name: "images", link: 1 }], widgets_values: ["out"] },
                ],
                links: [],
                extra: { linearData: { inputs: [["root:5:width", "width"], ["root:5:height", "height"]], outputs: [9] } },
            },
            "img-app-ratio.app.json": {
                nodes: [
                    { id: 3, type: "CR Aspect Ratio", mode: 0, inputs: [], widgets_values: ["16:9"] },
                    { id: 5, type: "EmptyLatentImage", mode: 0, inputs: [{ name: "batch_size", type: "INT", link: 1 }], widgets_values: [512, 512, 1] },
                    { id: 6, type: "EmptyLatentImage", mode: 0, inputs: [], widgets_values: [640, 640, 1] },
                    { id: 9, type: "SaveImage", mode: 0, inputs: [{ name: "images", link: 2 }], widgets_values: ["out"] },
                ],
                links: [[1, 3, 0, 5, 2, "INT"], [2, 5, 0, 9, 0, "IMAGE"]],
                extra: { linearData: { inputs: [["root:3:aspect_ratio", "aspect_ratio"]], outputs: [9] } },
            },
            "api-wan-combo.json": {
                "3": { class_type: "Wan22ImageToVideoLatent", inputs: { width: 832, height: 480, length: 81, aspect_ratio: "16:9" } },
                "5": { class_type: "SaveVideo", inputs: { video: ["3", 0], filename_prefix: "vid" } },
            },
            "vhs-path-wan.json": {
                nodes: [
                    { id: 1, type: "VHS_LoadVideoPath", mode: 0, inputs: [], widgets_values: { video: "old.mp4" } },
                    { id: 2, type: "VHS_LoadAudio", mode: 0, inputs: [], widgets_values: { audio_file: "old.wav", seek_seconds: 0, duration: 0 } },
                    { id: 3, type: "Wan22ImageToVideoLatent", mode: 0, inputs: [], widgets_values: [832, 480, 81, "16:9"] },
                    { id: 4, type: "WanFirstLastFrameToVideo", mode: 0, inputs: [], widgets_values: [832, 480, 81] },
                    { id: 5, type: "SaveVideo", mode: 0, inputs: [{ name: "video", link: 1 }], widgets_values: ["vid"] },
                ],
                links: [[1, 3, 0, 5, 0, "VIDEO"]],
                extra: {},
            },
        };
        const localServer = Bun.serve({
            port: 0,
            async fetch(request) {
                const url = new URL(request.url);
                if (url.pathname.startsWith("/api/userdata/")) {
                    const name = decodeURIComponent(url.pathname.slice("/api/userdata/".length)).replace(/^workflows\//, "");
                    return name in testWorkflows ? Response.json(testWorkflows[name]) : new Response("not found", { status: 404 });
                }
                if (url.pathname === "/api/object_info") return Response.json(extraObjectInfo);
                if (url.pathname === "/api/upload/image") {
                    const form = await request.formData();
                    const file = form.get("image") as File;
                    return Response.json({ name: file.name, subfolder: "beeftv", type: "input" });
                }
                if (url.pathname === "/api/prompt") {
                    const body = await request.json();
                    submittedPrompts.push(body.prompt);
                    return Response.json({ prompt_id: `p-${submittedPrompts.length}`, number: submittedPrompts.length });
                }
                return new Response("not found", { status: 404 });
            },
        });
        const localCtx = { config: { baseUrl: `http://127.0.0.1:${localServer.port}` }, signal: new AbortController().signal, log: () => {} };
        try {
            // Image workflow without App Mode size controls preserves 512x768 even when global default aspectRatio is 1:1.
            await provider.submit({ model: "img-keep-latent.json", capability: "image", aspectRatio: "1:1", resolution: "1k", extra: { idempotencyKey: "t-img-1" } }, localCtx);
            expect(submittedPrompts[0]["5"].inputs.width).toBe(512);
            expect(submittedPrompts[0]["5"].inputs.height).toBe(768);

            // Image workflow WITH App Mode width/height opt-in applies 1:1 1k -> 1024x1024.
            await provider.submit({ model: "img-app-latent.app.json", capability: "image", aspectRatio: "1:1", resolution: "1k", extra: { idempotencyKey: "t-img-2" } }, localCtx);
            expect(submittedPrompts[1]["5"].inputs.width).toBe(1024);
            expect(submittedPrompts[1]["5"].inputs.height).toBe(1024);

            // VHS path loaders get /api/view URLs, VHS_LoadAudio.duration remains 0, Wan22 & WanFirstLastFrame resize & reframe, and unsupported combo ratio "21:9" leaves "16:9".
            const videoRef = { dataUrl: `data:video/mp4;base64,${Buffer.from("mp4-bytes").toString("base64")}`, mimeType: "video/mp4" };
            const audioRef = { dataUrl: `data:audio/wav;base64,${Buffer.from("wav-bytes").toString("base64")}`, mimeType: "audio/wav" };
            await provider.submit(
                { model: "vhs-path-wan.json", capability: "video", aspectRatio: "21:9", resolution: "720p", duration: 6, videos: [videoRef], audios: [audioRef], extra: { idempotencyKey: "t-vhs" } },
                localCtx,
            );
            expect(submittedPrompts[2]["1"].inputs.video).toBe(`http://127.0.0.1:${localServer.port}/api/view?filename=t-vhs-video-1.mp4&subfolder=beeftv&type=input`);
            expect(submittedPrompts[2]["2"].inputs.audio_file).toBe(`http://127.0.0.1:${localServer.port}/api/view?filename=t-vhs-audio-1.wav&subfolder=beeftv&type=input`);
            expect(submittedPrompts[2]["2"].inputs.duration).toBe(0);
            expect(submittedPrompts[2]["3"].inputs.aspect_ratio).toBe("16:9");
            expect(submittedPrompts[2]["3"].inputs.width).toBe(1280);
            expect(submittedPrompts[2]["3"].inputs.height).toBe(720);
            expect(submittedPrompts[2]["3"].inputs.length).toBe(97);
            expect(submittedPrompts[2]["4"].inputs.height).toBe(720);
            expect(submittedPrompts[2]["4"].inputs.length).toBe(97);

            // Supported combo ratio "9:16" IS written.
            await provider.submit(
                { model: "vhs-path-wan.json", capability: "video", aspectRatio: "9:16", resolution: "720p", duration: 6, videos: [videoRef], audios: [audioRef], extra: { idempotencyKey: "t-vhs-2" } },
                localCtx,
            );
            expect(submittedPrompts[3]["3"].inputs.aspect_ratio).toBe("9:16");
            expect(submittedPrompts[3]["3"].inputs.width).toBe(720);
            expect(submittedPrompts[3]["3"].inputs.height).toBe(1280);

            // API-format workflows also inspect objectInfo combo options and keep width/height consistent with kept ratio.
            await provider.submit(
                { model: "api-wan-combo.json", capability: "video", aspectRatio: "21:9", resolution: "720p", duration: 6, extra: { idempotencyKey: "t-api-combo" } },
                localCtx,
            );
            expect(submittedPrompts[4]["3"].inputs.aspect_ratio).toBe("16:9");
            expect(submittedPrompts[4]["3"].inputs.width).toBe(1280);
            expect(submittedPrompts[4]["3"].inputs.height).toBe(720);

            // Image workflow binding only aspect_ratio in App Mode opts EmptyLatentImage into 9:16 1k resizing.
            await provider.submit(
                { model: "img-app-ratio.app.json", capability: "image", aspectRatio: "9:16", resolution: "1k", extra: { idempotencyKey: "t-img-ratio" } },
                localCtx,
            );
            expect(submittedPrompts[5]["3"].inputs.aspect_ratio).toBe("9:16");
            expect(submittedPrompts[5]["5"].inputs.width).toBe(1088);
            expect(submittedPrompts[5]["5"].inputs.height).toBe(1920);
            expect(submittedPrompts[5]["6"].inputs.width).toBe(640);
            expect(submittedPrompts[5]["6"].inputs.height).toBe(640);
        } finally {
            localServer.stop(true);
        }
    });
});
