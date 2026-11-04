import { expect, test, mock, spyOn } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as canvasProjectGeneration from "../src/lib/canvas/canvas-project-generation";
import { useCanvasGenerationRetry } from "../src/pages/canvas/use-canvas-generation-retry";
import type { GenerationTask } from "../src/services/api/task-center";
import * as canvasVideoRetry from "../src/services/canvas-video-retry";
import { defaultConfig } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
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
        id: "beefapi",
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
