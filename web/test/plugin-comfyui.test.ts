import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { convertEditorGraph, extractAppMode } from "../../plugin-packages/beeftv-plugin-comfyui/lib/editor.mjs";
import { inputTargets, outputNodeIds, prepareWorkflow, randomizeSeeds, workflowOutputKind } from "../../plugin-packages/beeftv-plugin-comfyui/lib/workflow.mjs";
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
        expect(inputTargets(prepared)).toEqual({ prompt: null, media: { image: [{ nodeId: "1", widget: "image" }], video: [], audio: [] } });
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
});
