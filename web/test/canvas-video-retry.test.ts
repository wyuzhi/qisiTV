import { expect, mock, test } from "bun:test";
import { setActiveUserScope } from "../src/lib/user-scope";
import { retryStoredCanvasVideo, updateCanvasVideoRecoveryFeedback } from "../src/services/canvas-video-retry";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { canvasGenerationRetryBlocked } from "../src/pages/canvas/canvas-generation-failure";
import { resetGenerationTaskMetadata } from "../src/lib/canvas/canvas-project-generation";
import type { GenerationTask } from "../src/services/api/task-center";
import { createBrowserLikeAITaskService, type BrowserLikeAITaskRecord } from "../src/services/browser-likeai-tasks";

const original = (status: GenerationTask["status"]): GenerationTask => ({
    id: "original", type: "canvas_video", status, prompt: "original compiled prompt", model: "original-model",
    inputJson: JSON.stringify({ referenceImages: [{ id: "original-reference" }], config: { videoSeconds: "5", vquality: "720p" } }),
    attempts: 1, createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z",
});

test("recovery feedback is visible on the affected node without replacing generation failure evidence", () => {
    const node: CanvasNodeData = {
        id: "video", type: CanvasNodeType.Video, title: "Video", position: { x: 0, y: 0 }, width: 300, height: 200,
        metadata: { taskId: "original", status: "error", errorDetails: "原素材未通过审核", generationErrorCode: "moderation_reference", taskErrorCode: "provider_reference_invalid", failedPromptFingerprint: "prompt-snapshot", failedInputFingerprint: "input-snapshot" },
    };
    const unrelated = { ...node, id: "other" };
    const [updated, untouched] = updateCanvasVideoRecoveryFeedback([node, unrelated], node.id, "original", "查询原任务失败，请稍后再试");
    expect(updated.metadata?.status).toBe("error");
    expect(updated.metadata?.taskRecoveryError).toBe("查询原任务失败，请稍后再试");
    expect(updated.metadata).toMatchObject(node.metadata!);
    expect(untouched).toBe(unrelated);
    expect(canvasGenerationRetryBlocked(updated.metadata)).toBe(canvasGenerationRetryBlocked(node.metadata));
    const cleared = updateCanvasVideoRecoveryFeedback([updated], node.id, "original")[0];
    expect(cleared.metadata?.taskRecoveryError).toBeUndefined();
    expect(cleared.metadata?.errorDetails).toBe(node.metadata?.errorDetails);
    expect(updateCanvasVideoRecoveryFeedback([node], node.id, "replaced-task", "stale feedback")[0]).toBe(node);
    const reset = resetGenerationTaskMetadata(updated.metadata, "loading");
    expect(reset.status).toBe("loading");
    expect(reset.taskRecoveryError).toBeUndefined();
    expect(reset.errorDetails).toBeUndefined();
    expect(reset.taskId).toBeUndefined();
    expect(reset.generationErrorCode).toBeUndefined();
    expect(reset.failedInputFingerprint).toBeUndefined();
    expect(updated.metadata?.taskRecoveryError).toBe("查询原任务失败，请稍后再试");
});

test("query failures become persistent recovery feedback instead of hidden transient messages", async () => {
    let nodes: CanvasNodeData[] = [{ id: "video", type: CanvasNodeType.Video, title: "Video", position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { taskId: "original", status: "loading" } }];
    try {
        await retryStoredCanvasVideo("original", new AbortController().signal, () => {}, {
            queryGenerationTask: async () => { throw new Error("查询服务暂时不可用"); },
            retryGenerationTask: async () => { throw new Error("must not resubmit"); },
            waitForGenerationTask: async () => original("succeeded"), isBrowserWorkspace: () => true,
        });
    } catch (error) {
        nodes = updateCanvasVideoRecoveryFeedback(nodes, "video", "original", (error as Error).message);
    }
    expect(nodes[0].metadata?.status).toBe("error");
    expect(nodes[0].metadata?.taskRecoveryError).toBe("查询服务暂时不可用");
    expect(nodes[0].metadata?.generationErrorCode).toBeUndefined();
});

test("desktop retries the persisted task with its original prompt, model and input", async () => {
    const task = original("failed");
    const retryGenerationTask = mock(async (_id: string, _options?: unknown) => ({ ...task, status: "queued" as const }));
    const waitForGenerationTask = mock(async (_id: string, _options?: unknown) => ({ ...task, status: "succeeded" as const }));
    const result = await retryStoredCanvasVideo(task.id, new AbortController().signal, () => {}, {
        queryGenerationTask: async () => task, retryGenerationTask, waitForGenerationTask, isBrowserWorkspace: () => false,
    });
    expect(retryGenerationTask.mock.calls[0]?.[0]).toBe(task.id);
    expect(retryGenerationTask.mock.calls[0]?.[1]).toHaveProperty("expectedScope");
    expect(result.prompt).toBe(task.prompt);
    expect(result.model).toBe(task.model);
    expect(result.inputJson).toBe(task.inputJson);
    expect(waitForGenerationTask.mock.calls[0]?.[0]).toBe(task.id);
});

test("accepted originals are observed and completed originals returned without a second query", async () => {
    for (const status of ["queued", "running", "succeeded"] as const) {
        const task = original(status);
        const retryGenerationTask = mock(async () => task);
        const waitForGenerationTask = mock(async () => ({ ...task, status: "succeeded" as const }));
        const result = await retryStoredCanvasVideo(task.id, new AbortController().signal, () => {}, {
            queryGenerationTask: async () => task, retryGenerationTask, waitForGenerationTask, isBrowserWorkspace: () => false,
        });
        expect(retryGenerationTask).not.toHaveBeenCalled();
        expect(waitForGenerationTask).toHaveBeenCalledTimes(status === "succeeded" ? 0 : 1);
        expect(result.status).toBe("succeeded");
    }
});

test("an aborted observation never starts a paid retry", async () => {
    const controller = new AbortController();
    const task = original("failed");
    const retryGenerationTask = mock(async () => task);
    await expect(retryStoredCanvasVideo(task.id, controller.signal, () => {}, {
        queryGenerationTask: async () => { controller.abort(); return task; },
        retryGenerationTask, waitForGenerationTask: async () => task, isBrowserWorkspace: () => false,
    })).rejects.toThrow();
    expect(retryGenerationTask).not.toHaveBeenCalled();
});

test("a workspace change invalidates the stored task before paid retry", async () => {
    const task = original("failed");
    const retryGenerationTask = mock(async () => task);
    try {
        await expect(retryStoredCanvasVideo(task.id, new AbortController().signal, () => {}, {
            queryGenerationTask: async () => { setActiveUserScope("switched"); return task; },
            retryGenerationTask, waitForGenerationTask: async () => task, isBrowserWorkspace: () => false,
        })).rejects.toThrow("已切换");
        expect(retryGenerationTask).not.toHaveBeenCalled();
    } finally { setActiveUserScope(); }
});

test("a non-video task cannot be retried through video recovery", async () => {
    const task = { ...original("failed"), type: "canvas_image" };
    const retryGenerationTask = mock(async () => task);
    await expect(retryStoredCanvasVideo(task.id, new AbortController().signal, () => {}, {
        queryGenerationTask: async () => task, retryGenerationTask, waitForGenerationTask: async () => task, isBrowserWorkspace: () => false,
    })).rejects.toThrow("不是画布视频任务");
    expect(retryGenerationTask).not.toHaveBeenCalled();
});

function browserFixture(providerStatus: "completed" | "failed" | "running") {
    const records = new Map<string, BrowserLikeAITaskRecord>();
    const network: string[] = [];
    const service = createBrowserLikeAITaskService({
        store: {
            get: async (id) => structuredClone(records.get(id) || null),
            put: async (record) => { records.set(record.task.id, structuredClone(record)); },
            all: async () => structuredClone([...records.values()]),
            remove: async (id) => { records.delete(id); },
        },
        lock: async (_key, action) => action(),
        credential: async () => "fixture-only",
        reference: async (ref) => ref,
        request: async (path) => {
            network.push(path);
            if (path === "/task/create_task") throw new Error("Recovery must never submit a paid task");
            return { code: 200, data: { task_id: "provider-original", status: providerStatus, result: providerStatus === "completed" ? { videos: ["https://media.example/original.mp4"] } : undefined } };
        },
        download: async (result) => ({ ...result, video: { ...result.video!, storageKey: "video:local:original" } }),
    });
    const saved: BrowserLikeAITaskRecord = { task: { ...original("cancelled"), providerRequestId: "provider-original", stage: "locally_cancelled" }, channelId: "likeai", serviceBaseUrl: "https://task.likeai.pro/task-api", mode: "video", downloaded: false };
    records.set(saved.task.id, saved);
    const retryGenerationTask = mock(async () => { throw new Error("Browser paid retries are disabled"); });
    const dependencies = {
        queryGenerationTask: (id: string, options?: { signal?: AbortSignal; refreshProvider?: boolean }) => service.query(id, options?.signal, options?.refreshProvider),
        retryGenerationTask,
        waitForGenerationTask: async (id: string) => service.query(id),
        isBrowserWorkspace: () => true,
    };
    return { records, service, network, saved, dependencies, retryGenerationTask };
}

test("browser local cancellation recovers and downloads the completed original receipt", async () => {
    const fixture = browserFixture("completed");
    const result = await retryStoredCanvasVideo("original", new AbortController().signal, () => {}, fixture.dependencies);
    expect(result.status).toBe("succeeded");
    expect(JSON.parse(result.resultJson!).video.storageKey).toBe("video:local:original");
    expect(fixture.network).toEqual(["/task/query_task/provider-original"]);
    expect(fixture.retryGenerationTask).not.toHaveBeenCalled();
});

test("a downloaded browser result remains recoverable without provider access", async () => {
    const fixture = browserFixture("failed");
    fixture.saved.downloaded = true;
    fixture.saved.task.status = "succeeded";
    fixture.saved.task.resultJson = JSON.stringify({ video: { storageKey: "video:local:original" } });
    const result = await retryStoredCanvasVideo("original", new AbortController().signal, () => {}, fixture.dependencies);
    expect(result.status).toBe("succeeded");
    expect(JSON.parse(result.resultJson!).video.storageKey).toBe("video:local:original");
    expect(fixture.network).toEqual([]);
    expect(fixture.retryGenerationTask).not.toHaveBeenCalled();
});

test("browser local cancellation resumes a provider task still running without resubmission", async () => {
    const fixture = browserFixture("running");
    const waitForGenerationTask = mock(async () => ({ ...original("succeeded"), providerRequestId: "provider-original" }));
    await retryStoredCanvasVideo("original", new AbortController().signal, () => {}, { ...fixture.dependencies, waitForGenerationTask });
    expect(waitForGenerationTask).toHaveBeenCalledTimes(1);
    expect(fixture.network).toEqual(["/task/query_task/provider-original"]);
    expect(fixture.retryGenerationTask).not.toHaveBeenCalled();
});

test("browser confirmed failure explains explicit new generation instead of retrying current canvas inputs", async () => {
    const fixture = browserFixture("failed");
    await expect(retryStoredCanvasVideo("original", new AbortController().signal, () => {}, fixture.dependencies)).rejects.toThrow("将使用当前提示词、素材和参数并产生新费用");
    expect(fixture.network).toEqual(["/task/query_task/provider-original"]);
    expect(fixture.retryGenerationTask).not.toHaveBeenCalled();
});

test("browser missing receipt cannot turn an uncertain submission into another charge", async () => {
    const fixture = browserFixture("completed");
    delete fixture.saved.task.providerRequestId;
    await expect(retryStoredCanvasVideo("original", new AbortController().signal, () => {}, fixture.dependencies)).rejects.toThrow("未重新提交收费任务");
    expect(fixture.network).toEqual([]);
    expect(fixture.retryGenerationTask).not.toHaveBeenCalled();
});
