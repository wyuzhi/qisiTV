import { expect, test, mock, spyOn } from "bun:test";
import { App } from "antd";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as canvasProjectGeneration from "../src/lib/canvas/canvas-project-generation";
import { generationInputFingerprint, generationPromptFingerprint } from "../src/lib/generation-error";
import * as modelCapabilities from "../src/lib/model-capabilities";
import { submittedReferences } from "../src/pages/canvas/canvas-generation-failure";
import { useCanvasGenerationRetry } from "../src/pages/canvas/use-canvas-generation-retry";
import type { GenerationTask } from "../src/services/api/task-center";
import * as canvasVideoRetry from "../src/services/canvas-video-retry";
import { createCanvasPageUiStore } from "../src/stores/canvas/use-canvas-page-ui-store";
import { defaultConfig } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../src/types/canvas";
import { retryStoredCanvasVideo } from "../src/services/canvas-video-retry";

test("video retry reuses the persisted task without reading changed canvas inputs", async () => {
    const task = { id: "original", type: "canvas_video", status: "failed", prompt: "original compiled prompt" } as GenerationTask;
    const queryGenerationTask = mock(async () => task);
    const retryGenerationTask = mock(async (_id: string, _options?: unknown) => ({ ...task, status: "queued" as const }));
    const waitForGenerationTask = mock(async () => ({ ...task, status: "succeeded" as const }));
    const result = await retryStoredCanvasVideo(task.id, new AbortController().signal, () => {}, { queryGenerationTask, retryGenerationTask, waitForGenerationTask });
    expect(retryGenerationTask.mock.calls[0]?.[0]).toBe("original");
    expect(result.prompt).toBe(task.prompt);
    expect(waitForGenerationTask.mock.calls[0]?.[0]).toBe(task.id);
});

test("cancelled observation cannot start a paid retry", async () => {
    const controller = new AbortController();
    const task = { id: "original", type: "canvas_video", status: "failed" } as GenerationTask;
    const retryGenerationTask = mock(async () => task);
    await expect(retryStoredCanvasVideo(task.id, controller.signal, () => {}, {
        queryGenerationTask: async () => { controller.abort(); return task; },
        retryGenerationTask,
        waitForGenerationTask: async () => task,
    })).rejects.toThrow();
    expect(retryGenerationTask).not.toHaveBeenCalled();
});

test("accepted or completed original videos are recovered instead of resubmitted", async () => {
    for (const status of ["running", "succeeded"] as const) {
        const task = { id: "original", type: "canvas_video", status } as GenerationTask;
        const retryGenerationTask = mock(async () => task);
        await retryStoredCanvasVideo(task.id, new AbortController().signal, () => {}, {
            queryGenerationTask: async () => task, retryGenerationTask, waitForGenerationTask: async () => task,
        });
        expect(retryGenerationTask).not.toHaveBeenCalled();
    }
});

test("useCanvasGenerationRetry falls back to canvas video generation when stored task is not canvas_video, and surfaces error summary when prompt is missing", async () => {
    const readyChannel = {
        ...defaultConfig.channels[0]!,
        id: "beeftv",
        pinned: true,
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        hasApiKey: true,
        models: ["fixture-video-model"],
    };
    const buildConfigSpy = spyOn(canvasProjectGeneration, "buildGenerationConfig").mockReturnValue({
        ...defaultConfig,
        model: "fixture-video-model",
        videoModel: "fixture-video-model",
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        channels: [readyChannel],
    });
    const storedRetrySpy = spyOn(canvasVideoRetry, "retryStoredCanvasVideo").mockRejectedValue(new Error("原任务不是画布视频任务，无法按原输入重试"));
    const consumerCalls: Array<Record<string, unknown>> = [];
    const consumerSpy = spyOn(canvasProjectGeneration, "runCanvasGenerationTaskToConsumer").mockImplementation(async (input) => {
        consumerCalls.push(input as unknown as Record<string, unknown>);
        return { id: "fallback-video-task", type: "canvas_video", status: "succeeded" } as GenerationTask;
    });

    const nodeWithPrompt: CanvasNodeData = {
        id: "video-1",
        type: CanvasNodeType.Video,
        title: "分镜视频 1",
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: {
            status: "error",
            taskId: "storyboard-task-1",
            prompt: "雨夜街头镜头推进",
            errorDetails: "旧错误",
        },
    };
    const nodeWithoutPrompt: CanvasNodeData = {
        id: "video-2",
        type: CanvasNodeType.Video,
        title: "分镜视频 2",
        position: { x: 0, y: 240 },
        width: 320,
        height: 180,
        metadata: {
            status: "error",
            taskId: "storyboard-task-2",
            prompt: "   ",
            errorDetails: "旧错误",
        },
    };

    const nodesRef = { current: [nodeWithPrompt, nodeWithoutPrompt] };
    let retry!: ReturnType<typeof useCanvasGenerationRetry>;
    function Harness() {
        retry = useCanvasGenerationRetry({
            projectId: "project-retry-test",
            addedSkills: [],
            assets: [],
            nodesRef,
            connectionsRef: { current: [] },
            setNodes: (updater) => {
                nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
            },
            setRunningNodeId: () => {},
            startGenerationRequest: () => new AbortController(),
            finishGenerationRequest: () => {},
            bindGenerationTask: () => {},
            applyGenerationTaskResult: async () => {},
            regenerateImageBatch: async () => {},
        });
        return null;
    }

    try {
        renderToStaticMarkup(createElement(Harness));
        await retry(nodeWithPrompt);
        expect(consumerCalls).toHaveLength(1);
        expect(consumerCalls[0]?.nodeId).toBe("video-1");
        expect(consumerCalls[0]?.mode).toBe("video");
        expect(consumerCalls[0]?.prompt).toBe("雨夜街头镜头推进");
        expect(consumerCalls[0]?.retryOf).toBeUndefined();

        await retry(nodeWithoutPrompt);
        expect(consumerCalls).toHaveLength(1);
        const updatedWithoutPrompt = nodesRef.current.find((item) => item.id === "video-2");
        expect(updatedWithoutPrompt?.metadata?.status).toBe("error");
        expect(updatedWithoutPrompt?.metadata?.generationErrorSummary).toBe("原任务不是画布视频任务，无法按原输入重试");
        expect(updatedWithoutPrompt?.metadata?.errorDetails).toBe("原任务不是画布视频任务，无法按原输入重试");
    } finally {
        buildConfigSpy.mockRestore();
        storedRetrySpy.mockRestore();
        consumerSpy.mockRestore();
    }
});

test("edited prompt on a moderation-failed video skips stored task replay and unchanged moderation pops confirmation", async () => {
    const readyChannel = {
        ...defaultConfig.channels[0]!,
        id: "beeftv",
        pinned: true,
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        hasApiKey: true,
        models: ["fixture-video-model"],
    };
    const buildConfigSpy = spyOn(canvasProjectGeneration, "buildGenerationConfig").mockReturnValue({
        ...defaultConfig,
        model: "fixture-video-model",
        videoModel: "fixture-video-model",
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        channels: [readyChannel],
    });
    const storedRetrySpy = spyOn(canvasVideoRetry, "retryStoredCanvasVideo").mockResolvedValue({
        id: "replayed-old-task",
        type: "canvas_video",
        status: "succeeded",
    } as GenerationTask);
    const consumerCalls: Array<Record<string, unknown>> = [];
    const consumerSpy = spyOn(canvasProjectGeneration, "runCanvasGenerationTaskToConsumer").mockImplementation(async (input) => {
        consumerCalls.push(input as unknown as Record<string, unknown>);
        return { id: "new-video-task", type: "canvas_video", status: "succeeded" } as GenerationTask;
    });
    const retryContextSpy = spyOn(canvasProjectGeneration, "createGenerationRetryContext").mockResolvedValue({
        clientOperationId: "op-new-1",
    });

    const confirmCalls: Array<{ title?: unknown; content?: unknown }> = [];
    const useAppSpy = spyOn(App, "useApp").mockReturnValue({
        message: {} as ReturnType<typeof App.useApp>["message"],
        notification: {} as ReturnType<typeof App.useApp>["notification"],
        modal: {
            confirm: (config: { title?: unknown; content?: unknown; onCancel?: () => void }) => {
                confirmCalls.push({ title: config.title, content: config.content });
                config.onCancel?.();
                return { destroy: () => {}, update: () => {} };
            },
        } as unknown as ReturnType<typeof App.useApp>["modal"],
    });

    const configSource: CanvasNodeData = {
        id: "cfg-1",
        type: CanvasNodeType.Config,
        title: "视频配置",
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: { composerContent: "改写为柔和暖光电影感慢镜头" },
    };
    const editedModerationVideo: CanvasNodeData = {
        id: "video-edited",
        type: CanvasNodeType.Video,
        title: "成片",
        position: { x: 400, y: 0 },
        width: 320,
        height: 180,
        metadata: {
            status: "error",
            taskId: "task-mod-1",
            generatedFromNodeId: "cfg-1",
            prompt: "旧违规提示词",
            failedPromptFingerprint: generationPromptFingerprint("旧违规提示词"),
            generationErrorCode: "moderation_input",
            errorDetails: "输入文本未通过内容安全审核。请调整提示词后重新生成。",
            taskOutcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" },
        },
    };
    const unchangedModerationVideo: CanvasNodeData = {
        id: "video-unchanged",
        type: CanvasNodeType.Video,
        title: "未改输入",
        position: { x: 400, y: 240 },
        width: 320,
        height: 180,
        metadata: {
            status: "error",
            taskId: "task-mod-2",
            prompt: "原始未改提示词",
            failedPromptFingerprint: generationPromptFingerprint("原始未改提示词"),
            generationErrorCode: "moderation_input",
            errorDetails: "输入文本未通过内容安全审核。请调整提示词后重新生成。",
            taskOutcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" },
        },
    };

    const refImage: CanvasNodeData = {
        id: "img-ref-1",
        type: CanvasNodeType.Image,
        title: "参考立绘",
        position: { x: 0, y: 240 },
        width: 240,
        height: 160,
        metadata: { nodeRole: "result", storageKey: "resource:ref-1" },
    };
    const refModerationWithoutInputFp: CanvasNodeData = {
        id: "video-ref-no-input-fp",
        type: CanvasNodeType.Video,
        title: "参考审核未改",
        position: { x: 400, y: 500 },
        width: 320,
        height: 180,
        metadata: {
            status: "error",
            taskId: "task-mod-ref-1",
            prompt: "参考 @图片1 的夜晚镜头",
            failedPromptFingerprint: generationPromptFingerprint("参考 @图片1 的夜晚镜头"),
            generationErrorCode: "moderation_reference",
            errorDetails: "@图片1 疑似包含真人形象，该模型拒绝生成。",
            taskOutcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" },
        },
    };

    const nodesRef = { current: [configSource, editedModerationVideo, unchangedModerationVideo, refImage, refModerationWithoutInputFp] };
    const connectionsRef: { current: CanvasConnection[] } = {
        current: [{ id: "conn-ref-1", fromNodeId: "img-ref-1", toNodeId: "video-ref-no-input-fp" }],
    };
    let retry!: ReturnType<typeof useCanvasGenerationRetry>;
    function Harness() {
        retry = useCanvasGenerationRetry({
            projectId: "project-mod-retry",
            addedSkills: [],
            assets: [],
            nodesRef,
            connectionsRef,
            setNodes: (updater) => {
                nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
            },
            setRunningNodeId: () => {},
            startGenerationRequest: () => new AbortController(),
            finishGenerationRequest: () => {},
            bindGenerationTask: () => {},
            applyGenerationTaskResult: async () => {},
            regenerateImageBatch: async () => {},
        });
        return null;
    }

    try {
        renderToStaticMarkup(createElement(Harness));
        await retry(editedModerationVideo);
        expect(storedRetrySpy).not.toHaveBeenCalled();
        expect(consumerCalls).toHaveLength(1);
        expect(consumerCalls[0]?.prompt).toBe("改写为柔和暖光电影感慢镜头");
        expect(confirmCalls).toHaveLength(0);

        await retry(unchangedModerationVideo);
        expect(confirmCalls).toHaveLength(1);
        expect(confirmCalls[0]?.title).toBe("输入尚未修改，确认直接重试？");
        expect(storedRetrySpy).not.toHaveBeenCalled();
        expect(consumerCalls).toHaveLength(1);

        await retry(refModerationWithoutInputFp);
        expect(confirmCalls).toHaveLength(2);
        expect(confirmCalls[1]?.title).toBe("输入尚未修改，确认直接重试？");
        expect(storedRetrySpy).not.toHaveBeenCalled();
        expect(consumerCalls).toHaveLength(1);
    } finally {
        useAppSpy.mockRestore();
        retryContextSpy.mockRestore();
        buildConfigSpy.mockRestore();
        storedRetrySpy.mockRestore();
        consumerSpy.mockRestore();
    }
});

test("creative retry detects removed/reordered refs, ignores upstream text, catches stale mentions, and gates fixed-output batch roots", async () => {
    const readyChannel = {
        ...defaultConfig.channels[0]!,
        id: "beeftv",
        pinned: true,
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        hasApiKey: true,
        models: ["fixture-model"],
    };
    const buildConfigSpy = spyOn(canvasProjectGeneration, "buildGenerationConfig").mockReturnValue({
        ...defaultConfig,
        model: "fixture-model",
        imageModel: "fixture-model",
        videoModel: "fixture-model",
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        channels: [readyChannel],
    });
    const storedRetrySpy = spyOn(canvasVideoRetry, "retryStoredCanvasVideo").mockResolvedValue({
        id: "replayed-task",
        type: "canvas_video",
        status: "succeeded",
    } as GenerationTask);
    const consumerCalls: Array<Record<string, unknown>> = [];
    const consumerSpy = spyOn(canvasProjectGeneration, "runCanvasGenerationTaskToConsumer").mockImplementation(async (input) => {
        consumerCalls.push(input as unknown as Record<string, unknown>);
        return { id: "new-task", type: "canvas_video", status: "succeeded" } as GenerationTask;
    });
    const retryContextSpy = spyOn(canvasProjectGeneration, "createGenerationRetryContext").mockResolvedValue({
        clientOperationId: "op-new-edge",
    });

    let confirmAction: "ok" | "cancel" = "ok";
    const confirmCalls: Array<{ title?: unknown; cancelText?: unknown }> = [];
    const useAppSpy = spyOn(App, "useApp").mockReturnValue({
        message: { error: () => {}, warning: () => {}, info: () => {} } as unknown as ReturnType<typeof App.useApp>["message"],
        notification: {} as ReturnType<typeof App.useApp>["notification"],
        modal: {
            confirm: (config: { title?: unknown; cancelText?: unknown; onOk?: () => void; onCancel?: () => void }) => {
                confirmCalls.push({ title: config.title, cancelText: config.cancelText });
                if (confirmAction === "ok") config.onOk?.();
                else config.onCancel?.();
                return { destroy: () => {}, update: () => {} };
            },
        } as unknown as ReturnType<typeof App.useApp>["modal"],
    });

    const imgA: CanvasNodeData = {
        id: "img-a",
        type: CanvasNodeType.Image,
        title: "图A",
        position: { x: 0, y: 0 },
        width: 240,
        height: 160,
        metadata: { nodeRole: "result", storageKey: "resource:a", content: "/api/resources/a/file" },
    };
    const imgB: CanvasNodeData = {
        id: "img-b",
        type: CanvasNodeType.Image,
        title: "图B",
        position: { x: 0, y: 200 },
        width: 240,
        height: 160,
        metadata: { nodeRole: "result", storageKey: "resource:b", content: "/api/resources/b/file" },
    };
    const textUpstream: CanvasNodeData = {
        id: "text-script",
        type: CanvasNodeType.Text,
        title: "脚本说明",
        position: { x: 0, y: 400 },
        width: 240,
        height: 120,
        metadata: { content: "新增旁白备注" },
    };
    const videoRemovedRef: CanvasNodeData = {
        id: "vid-removed-ref",
        type: CanvasNodeType.Video,
        title: "删参考图",
        position: { x: 340, y: 0 },
        width: 320,
        height: 180,
        metadata: {
            status: "error",
            taskId: "task-removed-ref",
            composerContent: "霓虹雨夜慢镜头",
            prompt: "霓虹雨夜慢镜头",
            failedPromptFingerprint: generationPromptFingerprint("霓虹雨夜慢镜头"),
            failedInputFingerprint: generationInputFingerprint("霓虹雨夜慢镜头", [{ storageKey: "resource:a" }]),
            generationErrorCode: "moderation_reference",
            errorDetails: "@图片1 疑似包含真人形象，该模型拒绝生成。",
            taskOutcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" },
        },
    };
    const videoReorderedRefs: CanvasNodeData = {
        id: "vid-reordered-refs",
        type: CanvasNodeType.Video,
        title: "交换顺序",
        position: { x: 340, y: 220 },
        width: 320,
        height: 180,
        metadata: {
            status: "error",
            taskId: "task-reordered",
            composerContent: "参考 @[node:img-b] 与 @[node:img-a] 镜头推进",
            prompt: "参考 @[node:img-b] 与 @[node:img-a] 镜头推进",
            failedPromptFingerprint: generationPromptFingerprint("参考 @[node:img-b] 与 @[node:img-a] 镜头推进"),
            failedInputFingerprint: generationInputFingerprint("参考 @[node:img-b] 与 @[node:img-a] 镜头推进", [
                { storageKey: "resource:a" },
                { storageKey: "resource:b" },
            ]),
            generationErrorCode: "moderation_reference",
            errorDetails: "@图片1 疑似包含真人形象，该模型拒绝生成。",
            taskOutcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" },
        },
    };
    const videoWithTextUpstream: CanvasNodeData = {
        id: "vid-unchanged-with-text",
        type: CanvasNodeType.Video,
        title: "连了文本节点",
        position: { x: 340, y: 440 },
        width: 320,
        height: 180,
        metadata: {
            status: "error",
            taskId: "task-with-text",
            composerContent: "原样提示词",
            prompt: "原样提示词",
            failedPromptFingerprint: generationPromptFingerprint("原样提示词"),
            failedInputFingerprint: generationInputFingerprint("原样提示词", []),
            generationErrorCode: "moderation_input",
            errorDetails: "输入文本未通过内容安全审核。请调整提示词后重新生成。",
            taskOutcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" },
        },
    };
    const videoLegacyRefNoInputFp: CanvasNodeData = {
        id: "vid-legacy-no-fp",
        type: CanvasNodeType.Video,
        title: "旧版参考失败",
        position: { x: 340, y: 660 },
        width: 320,
        height: 180,
        metadata: {
            status: "error",
            taskId: "task-legacy-no-fp",
            composerContent: "镜头围绕主体旋转",
            prompt: "镜头围绕主体旋转",
            failedPromptFingerprint: generationPromptFingerprint("镜头围绕主体旋转"),
            generationErrorCode: "moderation_reference",
            errorDetails: "@图片1 未通过安全审核。",
            taskOutcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" },
        },
    };
    const videoStaleMention: CanvasNodeData = {
        id: "vid-stale-mention",
        type: CanvasNodeType.Video,
        title: "过期引用",
        position: { x: 340, y: 880 },
        width: 320,
        height: 180,
        metadata: {
            status: "error",
            taskId: "task-stale-mention",
            composerContent: "使用 @图片9 的构图生成",
            prompt: "使用 @图片9 的构图生成",
            generationErrorCode: "moderation_reference",
            errorDetails: "参考图片异常",
            taskOutcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" },
        },
    };
    const batchRootModeration: CanvasNodeData = {
        id: "img-batch-root",
        type: CanvasNodeType.Image,
        title: "固定多图批次",
        position: { x: 700, y: 0 },
        width: 320,
        height: 180,
        metadata: {
            status: "error",
            nodeRole: "generator",
            composerContent: "雨夜街道海报",
            prompt: "雨夜街道海报",
            failedPromptFingerprint: generationPromptFingerprint("雨夜街道海报"),
            failedInputFingerprint: generationInputFingerprint("雨夜街道海报", []),
            generationErrorCode: "moderation_input",
            errorDetails: "输入文本未通过内容安全审核。请调整提示词后重新生成。",
            taskOutcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" },
        },
    };

    const pageUi = createCanvasPageUiStore();
    const batchRegenCalls: Array<{ nodeId: string; prompt: string; options?: unknown }> = [];
    const nodesRef = {
        current: [
            imgA,
            imgB,
            textUpstream,
            videoRemovedRef,
            videoReorderedRefs,
            videoWithTextUpstream,
            videoLegacyRefNoInputFp,
            videoStaleMention,
            batchRootModeration,
        ],
    };
    const connectionsRef: { current: CanvasConnection[] } = {
        current: [
            // B before A changes reference slot order from baseline [a, b] -> [b, a]
            { id: "c-b", fromNodeId: "img-b", toNodeId: "vid-reordered-refs" },
            { id: "c-a", fromNodeId: "img-a", toNodeId: "vid-reordered-refs" },
            { id: "c-text", fromNodeId: "text-script", toNodeId: "vid-unchanged-with-text" },
            { id: "c-legacy", fromNodeId: "img-a", toNodeId: "vid-legacy-no-fp" },
        ],
    };

    let retry!: ReturnType<typeof useCanvasGenerationRetry>;
    function Harness() {
        retry = useCanvasGenerationRetry({
            pageUi,
            projectId: "project-edge-retry",
            addedSkills: [],
            assets: [],
            nodesRef,
            connectionsRef,
            setNodes: (updater) => {
                nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
            },
            setRunningNodeId: () => {},
            startGenerationRequest: () => new AbortController(),
            finishGenerationRequest: () => {},
            bindGenerationTask: () => {},
            applyGenerationTaskResult: async () => {},
            regenerateImageBatch: async (nodeId, prompt, options) => {
                batchRegenCalls.push({ nodeId, prompt, options });
            },
        });
        return null;
    }

    const capSpy = spyOn(modelCapabilities, "modelCapabilityConfigFor").mockImplementation(((_cfg, model) =>
        model === "fixture-model" ? ({ image: { fixedOutputs: 4 } } as ReturnType<typeof modelCapabilities.modelCapabilityConfigFor>) : ({} as ReturnType<typeof modelCapabilities.modelCapabilityConfigFor>)) as typeof modelCapabilities.modelCapabilityConfigFor);

    try {
        renderToStaticMarkup(createElement(Harness));

        // 1. Removed reference skips stored replay and submits empty refs without confirm dialog.
        await retry(videoRemovedRef);
        expect(storedRetrySpy).not.toHaveBeenCalled();
        expect(consumerCalls).toHaveLength(1);
        expect(consumerCalls[0]?.referenceImages).toEqual([]);
        expect(confirmCalls).toHaveLength(0);

        // 2. Reordered references ([b, a] vs [a, b]) count as edited: skips replay and submits fresh task without confirm.
        await retry(videoReorderedRefs);
        expect(storedRetrySpy).not.toHaveBeenCalled();
        expect(consumerCalls).toHaveLength(2);
        expect(confirmCalls).toHaveLength(0);

        // 3. Connected unmentioned Text node does not cause false edited state; confirms then replays stored task.
        confirmAction = "ok";
        await retry(videoWithTextUpstream);
        expect(confirmCalls).toHaveLength(1);
        expect(confirmCalls[0]?.title).toBe("输入尚未修改，确认直接重试？");
        expect(storedRetrySpy).toHaveBeenCalledTimes(1);
        expect(storedRetrySpy.mock.calls[0]?.[0]).toBe("task-with-text");

        // 4. Legacy moderation_reference without failedInputFingerprint confirms and fails closed (submits fresh, no stored replay).
        storedRetrySpy.mockClear();
        await retry(videoLegacyRefNoInputFp);
        expect(confirmCalls).toHaveLength(2);
        expect(storedRetrySpy).not.toHaveBeenCalled();
        expect(consumerCalls).toHaveLength(3);

        // 5. Stale @图片9 mention is caught inside retry try/catch and writes error metadata cleanly.
        await expect(retry(videoStaleMention)).resolves.toBeUndefined();
        const failedMentionNode = nodesRef.current.find((item) => item.id === "vid-stale-mention");
        expect(failedMentionNode?.metadata?.status).toBe("error");
        expect(failedMentionNode?.metadata?.errorDetails).toContain("@图片9");

        // 6. Fixed-output batch root pops confirm before regenerateImageBatch; cancel ("去修改输入") opens prompt editor.
        confirmAction = "cancel";
        await retry(batchRootModeration);
        expect(confirmCalls).toHaveLength(3);
        expect(confirmCalls[2]?.cancelText).toBe("去修改输入");
        expect(batchRegenCalls).toHaveLength(0);
        expect(pageUi.getState().dialogNodeId).toBe("img-batch-root");
        expect(pageUi.getState().selectedNodeIds.has("img-batch-root")).toBe(true);
    } finally {
        capSpy.mockRestore();
        useAppSpy.mockRestore();
        retryContextSpy.mockRestore();
        buildConfigSpy.mockRestore();
        storedRetrySpy.mockRestore();
        consumerSpy.mockRestore();
    }
});

test("audio submittedReferences & retry baseline, charge warning preservation, and read-only cancel guard", async () => {
    expect(
        submittedReferences({
            mode: "audio",
            prompt: "延续鼓点",
            referenceImages: [{ id: "img-1", name: "cover.png", type: "image/png", dataUrl: "", storageKey: "resource:img-1" }],
            referenceVideos: [{ id: "vid-1", name: "clip.mp4", type: "video/mp4", url: "", storageKey: "resource:vid-1" }],
            referenceAudios: [{ id: "aud-1", name: "beat.mp3", type: "audio/mpeg", url: "", storageKey: "resource:aud-1" }],
        }),
    ).toEqual([{ storageKey: "resource:img-1" }, { storageKey: "resource:aud-1" }]);

    const readyChannel = {
        ...defaultConfig.channels[0]!,
        id: "beeftv",
        pinned: true,
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        hasApiKey: true,
        models: ["fixture-audio-model"],
    };
    const buildConfigSpy = spyOn(canvasProjectGeneration, "buildGenerationConfig").mockReturnValue({
        ...defaultConfig,
        model: "fixture-audio-model",
        audioModel: "fixture-audio-model",
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        channels: [readyChannel],
    });
    const consumerCalls: Array<Record<string, unknown>> = [];
    const consumerSpy = spyOn(canvasProjectGeneration, "runCanvasGenerationTaskToConsumer").mockImplementation(async (input) => {
        consumerCalls.push(input as unknown as Record<string, unknown>);
        return { id: "new-audio-task", type: "canvas_audio", status: "succeeded" } as GenerationTask;
    });
    const retryContextSpy = spyOn(canvasProjectGeneration, "createGenerationRetryContext").mockResolvedValue({
        clientOperationId: "op-audio-retry",
    });

    let confirmAction: "ok" | "cancel" = "ok";
    const confirmCalls: Array<{ title?: unknown; content?: unknown; cancelText?: unknown }> = [];
    const useAppSpy = spyOn(App, "useApp").mockReturnValue({
        message: { error: () => {}, warning: () => {}, info: () => {} } as unknown as ReturnType<typeof App.useApp>["message"],
        notification: {} as ReturnType<typeof App.useApp>["notification"],
        modal: {
            confirm: (config: { title?: unknown; content?: unknown; cancelText?: unknown; onOk?: () => void; onCancel?: () => void }) => {
                confirmCalls.push({ title: config.title, content: config.content, cancelText: config.cancelText });
                if (confirmAction === "ok") config.onOk?.();
                else config.onCancel?.();
                return { destroy: () => {}, update: () => {} };
            },
        } as unknown as ReturnType<typeof App.useApp>["modal"],
    });

    const upstreamAudio: CanvasNodeData = {
        id: "aud-ref-1",
        type: CanvasNodeType.Audio,
        title: "鼓点采样",
        position: { x: 0, y: 0 },
        width: 240,
        height: 120,
        metadata: { nodeRole: "result", storageKey: "resource:aud-new", content: "/api/resources/aud-new/file" },
    };
    const audioChangedRef: CanvasNodeData = {
        id: "aud-gen-changed",
        type: CanvasNodeType.Audio,
        title: "替换参考音频后重试",
        position: { x: 340, y: 0 },
        width: 300,
        height: 160,
        metadata: {
            status: "error",
            taskId: "task-aud-changed",
            composerContent: "延续 @[node:aud-ref-1] 的鼓点",
            prompt: "延续 @音频1 的鼓点",
            failedPromptFingerprint: generationPromptFingerprint("延续 @音频1 的鼓点"),
            failedInputFingerprint: generationInputFingerprint("延续 @音频1 的鼓点", [{ storageKey: "resource:aud-old" }]),
            generationErrorCode: "moderation_reference",
            errorDetails: "@音频1 触发版权限制，请更换音频后重试。",
            taskOutcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" },
        },
    };
    const audioUnchangedWithChargeConfirm: CanvasNodeData = {
        id: "aud-gen-confirm",
        type: CanvasNodeType.Audio,
        title: "未改音频且需确认计费",
        position: { x: 340, y: 200 },
        width: 300,
        height: 160,
        metadata: {
            status: "error",
            taskId: "task-aud-confirm",
            composerContent: "延续 @[node:aud-ref-1] 的鼓点",
            prompt: "延续 @音频1 的鼓点",
            failedPromptFingerprint: generationPromptFingerprint("延续 @音频1 的鼓点"),
            failedInputFingerprint: generationInputFingerprint("延续 @音频1 的鼓点", [{ storageKey: "resource:aud-new" }]),
            generationErrorCode: "moderation_reference",
            errorDetails: "@音频1 触发版权限制，请更换音频后重试。",
            taskOutcome: { phase: "failed", regenerate: "confirm", reason: "input_rejected" },
        },
    };

    const pageUi = createCanvasPageUiStore();
    const nodesRef = { current: [upstreamAudio, audioChangedRef, audioUnchangedWithChargeConfirm] };
    const connectionsRef: { current: CanvasConnection[] } = {
        current: [
            { id: "c-aud-1", fromNodeId: "aud-ref-1", toNodeId: "aud-gen-changed" },
            { id: "c-aud-2", fromNodeId: "aud-ref-1", toNodeId: "aud-gen-confirm" },
        ],
    };
    const editedNodes: string[] = [];

    let editableRetry!: ReturnType<typeof useCanvasGenerationRetry>;
    let readOnlyRetry!: ReturnType<typeof useCanvasGenerationRetry>;
    function Harness() {
        editableRetry = useCanvasGenerationRetry({
            pageUi,
            readOnly: false,
            onEditGenerationInput: (target) => {
                editedNodes.push(target.id);
            },
            projectId: "project-audio-retry",
            addedSkills: [],
            assets: [],
            nodesRef,
            connectionsRef,
            setNodes: (updater) => {
                nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
            },
            setRunningNodeId: () => {},
            startGenerationRequest: () => new AbortController(),
            finishGenerationRequest: () => {},
            bindGenerationTask: () => {},
            applyGenerationTaskResult: async () => {},
            regenerateImageBatch: async () => {},
        });
        readOnlyRetry = useCanvasGenerationRetry({
            pageUi,
            readOnly: true,
            onEditGenerationInput: (target) => {
                editedNodes.push(target.id);
            },
            projectId: "project-audio-retry",
            addedSkills: [],
            assets: [],
            nodesRef,
            connectionsRef,
            setNodes: (updater) => {
                nodesRef.current = typeof updater === "function" ? updater(nodesRef.current) : updater;
            },
            setRunningNodeId: () => {},
            startGenerationRequest: () => new AbortController(),
            finishGenerationRequest: () => {},
            bindGenerationTask: () => {},
            applyGenerationTaskResult: async () => {},
            regenerateImageBatch: async () => {},
        });
        return null;
    }

    try {
        renderToStaticMarkup(createElement(Harness));

        // 1. Replaced @音频1 storageKey skips unchanged confirm dialog and submits updated audio reference.
        await editableRetry(audioChangedRef);
        expect(confirmCalls).toHaveLength(0);
        expect(consumerCalls).toHaveLength(1);
        expect(consumerCalls[0]?.mode).toBe("audio");
        expect((consumerCalls[0]?.referenceAudios as Array<{ storageKey?: string }>)[0]?.storageKey).toBe("resource:aud-new");

        // 2. Unchanged @音频1 + regenerate:"confirm" preserves charge warning AND delegates cancel ("去修改输入") to onEditGenerationInput.
        confirmAction = "cancel";
        await editableRetry(audioUnchangedWithChargeConfirm);
        expect(confirmCalls).toHaveLength(1);
        expect(confirmCalls[0]?.cancelText).toBe("去修改输入");
        expect(String(confirmCalls[0]?.content || "")).toContain("未修改直接重试大概率仍会失败");
        expect(String(confirmCalls[0]?.content || "")).toContain("重新生成可能会再扣一次");
        expect(editedNodes).toEqual(["aud-gen-confirm"]);
        expect(pageUi.getState().dialogNodeId).toBeNull();
        expect(consumerCalls).toHaveLength(1);

        // 3. readOnly:true suppresses "去修改输入" and never calls onEditGenerationInput or mutates pageUi on cancel.
        await readOnlyRetry(audioUnchangedWithChargeConfirm);
        expect(confirmCalls).toHaveLength(2);
        expect(confirmCalls[1]?.cancelText).toBe("取消");
        expect(editedNodes).toEqual(["aud-gen-confirm"]);
        expect(pageUi.getState().dialogNodeId).toBeNull();
        expect(pageUi.getState().selectedNodeIds.size).toBe(0);
    } finally {
        useAppSpy.mockRestore();
        retryContextSpy.mockRestore();
        buildConfigSpy.mockRestore();
        consumerSpy.mockRestore();
    }
});
