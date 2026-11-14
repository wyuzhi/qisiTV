import { apiClient } from "../src/services/api/request";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../src/types/canvas";
import { canRecoverUpscaleNode, hasPendingUpscaleTask, isAIUpscaleTask, upscaleObservationFailureMetadata, UPSCALE_OBSERVATION_TIMEOUT_MS } from "../src/lib/canvas/canvas-ai-upscale-task";
import { createModelChannel, modelOptionsFromChannels } from "../src/stores/use-config-store";
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "antd";
import { createUpscaleTask, estimateUpscale, getUpscaleCapabilities, isUpscaleMediaSelectionAvailable, normalizeUpscaleMediaSelection, recoverUpscaleTask, UPSCALE_CAPABILITIES_TIMEOUT_MS, UPSCALE_CREATE_TIMEOUT_MS, UPSCALE_ESTIMATE_TIMEOUT_MS, UPSCALE_RECOVER_TIMEOUT_MS, validUpscaleScale, type UpscaleCapabilities } from "../src/services/api/media-upscale";
import { parseBackendGenerationResult } from "../src/services/api/generation-task";
import { generationTaskMode } from "../src/lib/canvas/canvas-generation-task-sync";
import { mediaResultMetadata } from "../src/lib/canvas/canvas-node-semantics";
import { useCanvasMediaTools } from "../src/pages/canvas/use-canvas-media-tools";
import { createCanvasPageUiStore } from "../src/stores/canvas/use-canvas-page-ui-store";
import type { GenerationTask } from "../src/services/api/task-center";

const task = (patch: Partial<GenerationTask>): GenerationTask => ({ id: "topaz", type: "canvas_image", model: "topaz-standard-v2", status: "succeeded", prompt: "", attempts: 1, createdAt: "", updatedAt: "", ...patch });
describe("Topaz upscale contract", () => {
    test("estimate survives reference preparation longer than the local API deadline", async () => {
        const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
            expect(new URL(request.url).pathname).toBe("/media-upscale/estimate");
            await Bun.sleep(4_200);
            return Response.json({ code: 0, data: { mediaType: "video", source: { width: 714, height: 1280 }, output: { width: 1428, height: 2560 }, reservation: 1.25, currency: "CNY", generationSubmitted: false, cloudProcessing: true } });
        } });
        const baseURL = apiClient.defaults.baseURL;
        apiClient.defaults.baseURL = server.url.toString();
        try {
            const quote = await estimateUpscale({ resourceId: "source", channelId: "beeftv", mode: "precision", model: "Proteus", scale: 2 });
            expect(quote.reservation).toBe(1.25);
            expect(quote.generationSubmitted).toBe(false);
            expect(apiClient.defaults.timeout).toBe(4_000);
        } finally { apiClient.defaults.baseURL = baseURL; await server.stop(true); }
    }, 10_000);
    test("recovery recognizes the four official models with matching task types", () => {
        for (const model of ["topaz-standard-v2", "topaz-wonder-3.5"]) expect(isAIUpscaleTask(task({ model }))).toBe(true);
        for (const model of ["topaz-proteus", "topaz-starlight-fast-2"]) expect(isAIUpscaleTask(task({ type: "canvas_video", model }))).toBe(true);
        expect(isAIUpscaleTask(task({ model: "topaz-proteus" }))).toBe(false);
        expect(isAIUpscaleTask(task({ model: "gpt-image-2" }))).toBe(false);
    });
    test("failed upscale placeholder exposes recovery even without source media", () => {
        const node: CanvasNodeData = { id: "result", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { taskId: "original", taskStatus: "failed", status: "error", workflowOperation: { id: "image.ai-upscale", version: 1, config: {}, inputs: [] } } };
        expect(canRecoverUpscaleNode(node)).toBe(true);
        expect(canRecoverUpscaleNode({ ...node, metadata: { ...node.metadata, taskId: undefined } })).toBe(false);
        expect(canRecoverUpscaleNode({ ...node, metadata: { ...node.metadata, workflowOperation: undefined } })).toBe(false);
    });
    test("recovery calls only the original task recovery endpoint", () => {
        const originalRequest = apiClient.request;
        const requests: Array<{ method?: string; url?: string; data?: unknown; timeout?: number }> = [];
        apiClient.request = (async request => {
            requests.push({ method: request.method, url: request.url, data: request.data, timeout: request.timeout });
            return { status: 200, data: { code: 0, data: task({ id: "original", status: "running" }) } };
        }) as typeof apiClient.request;
        return recoverUpscaleTask("original").then(res => {
            expect(res.id).toBe("original");
            expect(requests).toEqual([{ method: "post", url: "/media-upscale/tasks/original/recover", data: {}, timeout: UPSCALE_RECOVER_TIMEOUT_MS }]);
        }).finally(() => { apiClient.request = originalRequest; });
    });
    test("estimate and create override the 4s default client timeout for media preupload and probe", async () => {
        const originalRequest = apiClient.request;
        const timeouts: Array<{ url?: string; timeout?: number }> = [];
        const originalWindow = globalThis.window;
        if (typeof globalThis.window === "undefined") {
            (globalThis as unknown as { window: EventTarget }).window = new EventTarget();
        }
        apiClient.request = (async request => {
            timeouts.push({ url: request.url, timeout: request.timeout });
            if (request.url === "/media-upscale/capabilities") {
                return { status: 200, data: { code: 0, data: { modes: [], cloudProcessing: true, maxVideoDurationMs: 300_000 } } };
            }
            if (request.url === "/media-upscale/estimate") {
                return { status: 200, data: { code: 0, data: { mediaType: "video", source: { width: 1280, height: 720, durationMs: 115752 }, output: { width: 2560, height: 1440, durationMs: 115752 }, reservation: 70, currency: "CNY", generationSubmitted: false, cloudProcessing: true } } };
            }
            return { status: 200, data: { code: 0, data: task({ id: "created", type: "canvas_video", model: "topaz-proteus", status: "queued" }) } };
        }) as typeof apiClient.request;
        try {
            const caps = await getUpscaleCapabilities();
            expect(caps.maxVideoDurationMs).toBe(300_000);
            const quote = await estimateUpscale({ resourceId: "res-1", channelId: "beeftv", mode: "precision", model: "topaz-proteus", scale: 2 });
            expect(quote.reservation).toBe(70);
            const created = await createUpscaleTask({ resourceId: "res-1", channelId: "beeftv", mode: "precision", model: "topaz-proteus", scale: 2, clientOperationId: "op-1", projectId: "proj-1", nodeId: "node-1" });
            expect(created.id).toBe("created");
            expect(timeouts).toEqual([
                { url: "/media-upscale/capabilities", timeout: UPSCALE_CAPABILITIES_TIMEOUT_MS },
                { url: "/media-upscale/estimate", timeout: UPSCALE_ESTIMATE_TIMEOUT_MS },
                { url: "/media-upscale/tasks", timeout: UPSCALE_CREATE_TIMEOUT_MS },
            ]);
            expect(UPSCALE_CAPABILITIES_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000);
            expect(UPSCALE_ESTIMATE_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
            expect(UPSCALE_CREATE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
        } finally {
            apiClient.request = originalRequest;
            if (typeof originalWindow === "undefined") {
                delete (globalThis as unknown as { window?: EventTarget }).window;
            }
        }
    });
    test("observer timeout and network errors cannot authorize another paid task", () => {
        expect(UPSCALE_OBSERVATION_TIMEOUT_MS).toBeGreaterThan(10 * 60 * 1000);
        for (const status of ["queued", "running"] as const) {
            for (const reason of ["任务执行超时", "Network Error"]) {
                const metadata = upscaleObservationFailureMetadata({ id: "topaz", status }, reason);
                expect(metadata.status).toBe("loading");
                expect(metadata.taskStatus).toBe(status);
                expect(hasPendingUpscaleTask(metadata)).toBe(true);
                expect(hasPendingUpscaleTask({ ...metadata, status: "error" })).toBe(true);
            }
        }
        expect(hasPendingUpscaleTask({ taskId: "topaz", status: "error" })).toBe(true);
        expect(hasPendingUpscaleTask({ taskClientOperationId: "unknown", status: "error", generationSubmissionState: "unknown" })).toBe(true);
    });
    test("failed or cancelled tasks still require checking the original paid task", () => {
        for (const status of ["failed", "cancelled"] as const) {
            const metadata = upscaleObservationFailureMetadata({ id: "topaz", status }, "终态");
            expect(metadata.status).toBe("error");
            expect(hasPendingUpscaleTask(metadata)).toBe(true);
            expect(metadata.errorDetails).toContain("任务详情");
        }
        expect(hasPendingUpscaleTask({ taskClientOperationId: "not-submitted", taskStatus: "failed", generationSubmissionState: "rejected" })).toBe(false);
        expect(hasPendingUpscaleTask({ taskId: "paid-task", taskClientOperationId: "submitted", taskStatus: "failed", generationSubmissionState: "rejected" })).toBe(true);
        expect(hasPendingUpscaleTask({ taskClientOperationId: "unknown", taskStatus: "failed", generationSubmissionState: "unknown" })).toBe(true);
        const succeeded = upscaleObservationFailureMetadata({ id: "topaz", status: "succeeded" }, "落图失败");
        expect(hasPendingUpscaleTask(succeeded)).toBe(true);
        expect(hasPendingUpscaleTask({ ...succeeded, content: "resource-result" })).toBe(false);

        const refunded = upscaleObservationFailureMetadata(
            { id: "erase-1", status: "failed", operation: "media.video.subtitle_erase", outcome: { phase: "failed", regenerate: "allowed", reason: "task_failed" } },
            "视频素材同步到上游超时，本次未扣费，请直接重试",
        );
        expect(refunded.status).toBe("error");
        expect(hasPendingUpscaleTask(refunded)).toBe(false);
        expect(refunded.errorDetails).toBe("视频素材同步到上游超时，本次未扣费，请直接重试");
        expect(refunded.errorDetails).not.toContain("暂勿重复提交");

        const settlementPending = upscaleObservationFailureMetadata(
            { id: "erase-2", status: "failed", operation: "media.video.subtitle_erase", outcome: { phase: "failed", regenerate: "blocked", reason: "settlement_pending" } },
            "上游处理失败",
        );
        expect(hasPendingUpscaleTask(settlementPending)).toBe(true);
        expect(settlementPending.errorDetails).toContain("暂勿重复提交");
    });
    test("processing models stay in settings but leave normal generation selectors", () => {
        const endpoints = ["topaz/upscale/image/precision", "topaz/upscale/image/generative", "topaz/upscale/image/transparent", "topaz/upscale/video/precision", "topaz/upscale/video/generative", "/topaz/upscale/image/precision", "topaz-standard-v2", "topaz-wonder-3.5", "topaz-proteus", "topaz-starlight-fast-2"];
        const channel = createModelChannel({
            id: "fal",
            models: [...endpoints, "video-subtitle-erase", "video-enhance-pro", "fal-ai/flux/dev"],
            modelProfiles: [
                { model: "video-subtitle-erase", capability: "video", mediaCapabilities: { video: { operations: ["subtitle_erase"], options: ["erase_method"], referenceKinds: ["video"], maxOutputs: 1 } } },
                { model: "video-enhance-pro", capability: "video", mediaCapabilities: { upscale: { operations: ["upscale"], options: ["upscale_factor"], referenceKinds: ["video"], maxOutputs: 1 } } },
            ],
        });
        expect(modelOptionsFromChannels([channel])).toEqual(["fal::fal-ai/flux/dev"]);
        expect(channel.models).toEqual([...endpoints, "video-subtitle-erase", "video-enhance-pro", "fal-ai/flux/dev"]);
    });
    test("official upscale uses integer scale bounds", () => {
        for (const value of [1, 2, 3, 4]) expect(validUpscaleScale(value)).toBe(true);
        for (const value of [0, 1.5, 4.1, NaN, Infinity]) expect(validUpscaleScale(value)).toBe(false);
        expect(validUpscaleScale(2, 4)).toBe(false);
        expect(validUpscaleScale(4, 4)).toBe(true);
    });
    test("owned image result is recoverable without remote URL", () => {
        const result = parseBackendGenerationResult(task({ resultJson: JSON.stringify({ mode: "image", images: [{ storageKey: "resource:image1", width: 200, height: 100 }] }) }));
        expect(result.images?.[0].storageKey).toContain("image1");
        expect(result.images?.[0].width).toBe(200);
    });
    test("video recovery does not default to image", () => {
        expect(generationTaskMode(task({ type: "canvas_video", model: "topaz-proteus", inputJson: JSON.stringify({ mode: "video" }) }))).toBe("video");
        const result = parseBackendGenerationResult(task({ type: "canvas_video", model: "topaz-proteus", resultJson: JSON.stringify({ mode: "video", video: { storageKey: "resource:video1", width: 200, height: 100, durationMs: 1000 } }) }));
        expect(result.video?.durationMs).toBe(1000);
    });
    test("upscale availability checks selected mode and normalizes saved precision when catalog only offers generative", () => {
        const generativeOnlyCatalog: UpscaleCapabilities = {
            cloudProcessing: true,
            maxVideoDurationMs: 600_000,
            modes: [
                {
                    mediaType: "image",
                    mode: "generative",
                    models: ["gen-image-v1"],
                    modelOptions: [{ id: "gen-image-v1", label: "细节重建图像模型" }],
                    scales: [2, 4],
                    outputFormats: ["webp"],
                },
                {
                    mediaType: "video",
                    mode: "precision",
                    models: [],
                    scales: [2],
                    outputFormats: ["mp4"],
                },
            ],
        };
        const savedImage = { mode: "precision" as const, model: "Standard V2", outputFormat: "png" };
        expect(isUpscaleMediaSelectionAvailable(generativeOnlyCatalog, "image", savedImage)).toBe(false);
        const normalizedImage = normalizeUpscaleMediaSelection(generativeOnlyCatalog, "image", savedImage);
        expect(normalizedImage).toEqual({ mode: "generative", model: "gen-image-v1", outputFormat: "webp" });
        expect(isUpscaleMediaSelectionAvailable(generativeOnlyCatalog, "image", normalizedImage)).toBe(true);

        const savedVideo = { mode: "precision" as const, model: "Proteus" };
        const normalizedVideo = normalizeUpscaleMediaSelection(generativeOnlyCatalog, "video", savedVideo);
        expect(isUpscaleMediaSelectionAvailable(generativeOnlyCatalog, "video", normalizedVideo)).toBe(false);
    });

    test("recoverAIUpscale and recoverVideoSubtitleErase register cancellation before await and never overwrite a node replaced by local upload", async () => {
        const pageUi = createCanvasPageUiStore();
        const upscaleFailedNode: CanvasNodeData = {
            id: "node-recover-1",
            type: CanvasNodeType.Image,
            title: "超分节点",
            position: { x: 0, y: 0 },
            width: 320,
            height: 240,
            metadata: mediaResultMetadata("derived", {
                status: "error",
                taskId: "task-up-1",
                taskStatus: "failed",
                workflowOperation: { id: "image.ai-upscale", version: 1, config: {}, inputs: [] },
            }),
        };
        const nodesRef = { current: [upscaleFailedNode] };
        const connectionsRef = { current: [] as CanvasConnection[] };
        const selectedNodeIdsRef = { current: new Set<string>() };
        const activeControllers = new Map<string, AbortController>();
        const boundTasks: Array<{ nodeId: string; taskId: string }> = [];
        let setNodesCalls = 0;

        let capturedTools!: ReturnType<typeof useCanvasMediaTools>;
        function Harness() {
            capturedTools = useCanvasMediaTools({
                pageUi,
                projectId: "proj-1",
                nodesRef,
                connectionsRef,
                selectedNodeIdsRef,
                setNodes: (updater) => {
                    setNodesCalls += 1;
                    nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
                },
                setConnections: () => undefined,
                setRunningNodeId: () => undefined,
                startUploadStatus: () => () => undefined,
                startGenerationRequest: (targetNodeId, _origin, _running, controller = new AbortController()) => {
                    activeControllers.get(targetNodeId)?.abort();
                    activeControllers.set(targetNodeId, controller);
                    return controller;
                },
                finishGenerationRequest: (targetNodeId, controller) => {
                    if (activeControllers.get(targetNodeId) === controller) activeControllers.delete(targetNodeId);
                },
                bindGenerationTask: (nodeId, bound) => {
                    boundTasks.push({ nodeId, taskId: bound.id });
                },
            });
            return null;
        }
        renderToStaticMarkup(createElement(App, null, createElement(Harness)));

        const originalRequest = apiClient.request;
        try {
            // 1) 在 queryGenerationTask 等待期间触发本地上传取消该节点请求：立刻中止，不调用 recover，不写回 loading
            let recoverEndpointCalls = 0;
            apiClient.request = (async (request) => {
                if (String(request.url).includes("/tasks/task-up-1") && request.method?.toLowerCase() === "get") {
                    expect(activeControllers.has("node-recover-1")).toBe(true);
                    activeControllers.get("node-recover-1")?.abort();
                    return { status: 200, data: { code: 0, data: task({ id: "task-up-1", status: "failed" }) } };
                }
                recoverEndpointCalls += 1;
                return { status: 200, data: { code: 0, data: task({ id: "task-up-1", status: "running" }) } };
            }) as typeof apiClient.request;

            await capturedTools.recoverAIUpscale(upscaleFailedNode);
            expect(recoverEndpointCalls).toBe(0);
            expect(setNodesCalls).toBe(0);
            expect(boundTasks).toHaveLength(0);

            // 2) 在 recoverUpscaleTask 返回前该节点已被替换为本地上传完成节点（即便带旧 taskId）：绝不把上传节点改成 loading
            nodesRef.current = [upscaleFailedNode];
            apiClient.request = (async (request) => {
                if (String(request.url).includes("/media-upscale/tasks/task-up-1/recover")) {
                    nodesRef.current = [{
                        ...upscaleFailedNode,
                        title: "local-replaced.png",
                        metadata: mediaResultMetadata("upload", {
                            content: "/api/resources/local-replaced/file",
                            storageKey: "resource:local-replaced",
                            status: "success",
                            taskId: "task-up-1",
                        }),
                    }];
                    return { status: 200, data: { code: 0, data: task({ id: "task-up-1", status: "running" }) } };
                }
                return { status: 200, data: { code: 0, data: task({ id: "task-up-1", status: "failed" }) } };
            }) as typeof apiClient.request;

            await capturedTools.recoverAIUpscale(upscaleFailedNode);
            expect(nodesRef.current[0]?.metadata?.resultOrigin).toBe("upload");
            expect(nodesRef.current[0]?.metadata?.status).toBe("success");
            expect(nodesRef.current[0]?.metadata?.content).toBe("/api/resources/local-replaced/file");
            expect(setNodesCalls).toBe(0);
            expect(boundTasks).toHaveLength(0);
        } finally {
            apiClient.request = originalRequest;
        }
    });
});
