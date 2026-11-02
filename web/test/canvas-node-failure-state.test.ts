import { expect, test } from "bun:test";
import { persistCanvasNodeFailure, nodeFailureExplanation } from "@/lib/canvas/canvas-node-failure-state";
import { canvasNodeFailureView } from "@/lib/canvas/canvas-node-failure-view";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function failure(): CanvasNodeData {
    return { id: "original", type: CanvasNodeType.Image, title: "image", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { status: "error", errorDetails: "too many requests" } };
}

test("stored explanation is reused with normalized copy and category", () => {
    const saved = persistCanvasNodeFailure(failure());
    expect(saved.metadata?.generationFailure?.explanation.category).toBe("throttled");
    expect(nodeFailureExplanation(saved.metadata)).toBe(saved.metadata!.generationFailure!.explanation);
    expect(persistCanvasNodeFailure(saved)).toBe(saved);
    const reopened = JSON.parse(JSON.stringify(saved));
    expect(canvasNodeFailureView(reopened).explanation).toEqual(canvasNodeFailureView(failure()).explanation);
});

test("late unknown markers update local outcome before saving", () => {
    const saved = persistCanvasNodeFailure(failure());
    expect(saved.metadata?.taskOutcome?.regenerate).toBe("allowed");
    const unknown = persistCanvasNodeFailure({ ...saved, metadata: { ...saved.metadata, generationSubmissionState: "unknown", taskStage: "submission_unknown" } });
    expect(unknown.metadata?.taskOutcome).toEqual({ phase: "retrievable", regenerate: "blocked", reason: "submission_unknown" });
    expect(canvasNodeFailureView(unknown).regenerateBlocked).toBe(true);
});

test("local normalization preserves authoritative task outcomes", () => {
    const node = failure();
    node.metadata = { ...node.metadata, taskId: "paid-task", taskOutcome: { phase: "running", regenerate: "blocked", reason: "task_running" } };
    const saved = persistCanvasNodeFailure(node);
    expect(saved.metadata?.taskOutcome).toBe(node.metadata.taskOutcome);
    expect(saved.metadata?.taskOutcomeSource).toBeUndefined();
});

test("changed error and cleared failure cannot reuse a stale explanation", () => {
    const saved = persistCanvasNodeFailure(failure());
    const changed = persistCanvasNodeFailure({ ...saved, metadata: { ...saved.metadata, errorDetails: "invalid api key" } });
    expect(nodeFailureExplanation(changed.metadata).category).toBe("auth");
    const cleared = persistCanvasNodeFailure({ ...changed, metadata: { ...changed.metadata, status: "loading", errorDetails: undefined } });
    expect(cleared.metadata?.generationFailure).toBeUndefined();
    expect(cleared.metadata?.taskOutcome).toBeUndefined();
});

test("upload interruption and recovery placeholders are not generation failures", () => {
    for (const metadata of [{ fileUpload: "error" as const, errorDetails: "上传已中断，请重新选择文件上传" }, { status: "loading" as const, errorDetails: "正在从任务中心恢复生成状态..." }]) {
        const item = { ...failure(), metadata };
        expect(persistCanvasNodeFailure(item)).toBe(item);
    }
});

test("an explicit outcome written over a local one is kept, so the node can regenerate", () => {
    const uncertain = failure();
    uncertain.metadata = { status: "error", generationSubmissionState: "unknown", generationErrorCode: "submission_uncertain", errorDetails: "提交结果待确认" };
    const saved = persistCanvasNodeFailure(uncertain);
    expect(saved.metadata?.taskOutcome?.reason).toBe("submission_unknown");
    expect(saved.metadata?.taskOutcomeSource).toBe("local");
    // Recovery found no task for the operation: it writes not_charged and clears the marker.
    const recovered = persistCanvasNodeFailure({ ...saved, metadata: { ...saved.metadata, generationSubmissionState: undefined, errorDetails: "上次提交没有找到，可以重新生成", taskOutcome: { phase: "failed", regenerate: "allowed", reason: "not_charged" } } });
    expect(recovered.metadata?.taskOutcome).toEqual({ phase: "failed", regenerate: "allowed", reason: "not_charged" });
    expect(recovered.metadata?.taskOutcomeSource).toBeUndefined();
    expect(recovered.metadata?.generationFailure?.localOutcome).toBeUndefined();
    const reopened = persistCanvasNodeFailure(JSON.parse(JSON.stringify(recovered)));
    expect(reopened.metadata?.taskOutcome?.reason).toBe("not_charged");
    expect(canvasNodeFailureView(reopened).regenerateBlocked).toBe(false);
});

test("a local outcome is not a live task for generating state or upscale locks", async () => {
    const { hasCancellableCanvasNodeTask, isCanvasNodeGenerating } = await import("@/lib/canvas/canvas-node-task-state");
    const { canReloadCanvasNodeResource, isNodeRegenerateBlocked } = await import("@/lib/task-outcome");
    const uncertain = failure();
    uncertain.metadata = { status: "error", generationSubmissionState: "unknown", errorDetails: "提交结果待确认" };
    const saved = persistCanvasNodeFailure(uncertain);
    expect(saved.metadata?.taskOutcome?.phase).toBe("retrievable");
    expect(isCanvasNodeGenerating(uncertain)).toBe(false);
    expect(isCanvasNodeGenerating(saved)).toBe(false);
    const retrievable = {
        ...failure(),
        metadata: {
            status: "error" as const,
            taskId: "task-retrievable",
            taskStatus: "succeeded" as const,
            taskOutcome: { phase: "retrievable" as const, regenerate: "blocked" as const, reason: "delivery_pending" },
            errorDetails: "生成结果已保留，请点击「继续取回」",
        },
    };
    expect(isCanvasNodeGenerating(retrievable)).toBe(false);
    expect(hasCancellableCanvasNodeTask(retrievable)).toBe(true);
    expect(canReloadCanvasNodeResource(retrievable)).toBe(true);
    expect(isNodeRegenerateBlocked(retrievable.metadata)).toBe(true);
    const errorWithRunningTask = {
        ...failure(),
        metadata: {
            status: "error" as const,
            taskId: "task-running-error",
            taskStatus: "running" as const,
        },
    };
    expect(isCanvasNodeGenerating(errorWithRunningTask)).toBe(false);
    expect(hasCancellableCanvasNodeTask(errorWithRunningTask)).toBe(true);
    expect(hasCancellableCanvasNodeTask({
        ...failure(),
        metadata: {
            status: "error",
            taskId: "task-legacy-retrievable",
            generationErrorCode: "canvas_conflict",
        },
    })).toBe(true);
    expect(isCanvasNodeGenerating({
        ...failure(),
        metadata: {
            status: "error",
            taskId: "task-ready-error",
            taskStatus: "succeeded",
            taskOutcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
        },
    })).toBe(false);
    expect(isCanvasNodeGenerating({
        ...failure(),
        metadata: {
            status: "error",
            taskId: "task-succeeded-error",
            taskStatus: "succeeded",
        },
    })).toBe(false);
});

test("batch retry restore keeps the local marker instead of turning it into a backend outcome", async () => {
    const { markImageBatchRetrying, restoreUnsubmittedImageBatchChild } = await import("@/lib/canvas/canvas-image-batch-retry");
    const child = persistCanvasNodeFailure({ ...failure(), id: "child", metadata: { status: "error", errorDetails: "invalid api key", batchRootId: "root" } });
    const before = canvasNodeFailureView(child).explanation.blockManualRetry;
    const [loading] = markImageBatchRetrying("root", ["child"], [child]);
    const restored = persistCanvasNodeFailure(restoreUnsubmittedImageBatchChild(persistCanvasNodeFailure(loading), child));
    expect(restored.metadata?.taskOutcomeSource).toBe("local");
    expect(canvasNodeFailureView(restored).explanation.blockManualRetry).toBe(before);
});

test("derived failure fields and outcome backfill do not stamp a new updatedAt", async () => {
    const { stampCanvasNodeChanges } = await import("@/lib/canvas/canvas-node-timestamps");
    const original = { ...failure(), updatedAt: "2026-01-01T00:00:00.000Z" };
    const [captured] = stampCanvasNodeChanges([original], [persistCanvasNodeFailure(original)], "2026-02-02T00:00:00.000Z");
    expect(captured.updatedAt).toBe(original.updatedAt);
    const bound = { ...original, metadata: { status: "success" as const, content: "resource:x", taskId: "t" } };
    const [filled] = stampCanvasNodeChanges([bound], [{ ...bound, metadata: { ...bound.metadata, taskOutcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" } } }], "2026-02-02T00:00:00.000Z");
    expect(filled.updatedAt).toBe(original.updatedAt);
    const [edited] = stampCanvasNodeChanges([original], [{ ...original, metadata: { ...original.metadata, errorDetails: "invalid api key" } }], "2026-02-02T00:00:00.000Z");
    expect(edited.updatedAt).toBe("2026-02-02T00:00:00.000Z");
});

test("bound success node with stale running taskOutcome is healed to ready on persist and task sync", async () => {
    const { isCanvasNodeGenerating } = await import("@/lib/canvas/canvas-node-task-state");
    const { isNodeRegenerateBlocked } = await import("@/lib/task-outcome");
    const { canvasGenerationTaskNodes } = await import("@/pages/canvas/canvas-generation-failure");

    const staleSuccess: CanvasNodeData = {
        ...failure(),
        metadata: {
            status: "success",
            taskId: "task-img-1",
            taskStatus: "succeeded",
            taskProgress: 100,
            content: "/api/resources/res-1/file",
            storageKey: "resource:res-1",
            assetId: "asset-1",
            taskOutcome: { phase: "running", regenerate: "blocked", reason: "in_flight" },
        },
    };
    const healed = persistCanvasNodeFailure(staleSuccess);
    expect(healed.metadata?.taskOutcome).toEqual({
        phase: "ready",
        regenerate: "allowed",
        reason: "result_ready",
    });
    expect(isCanvasNodeGenerating(healed)).toBe(false);
    expect(isNodeRegenerateBlocked(healed.metadata)).toBe(false);

    const [synced] = canvasGenerationTaskNodes([staleSuccess], staleSuccess.id, {
        id: "task-img-1",
        type: "canvas_image",
        prompt: "test",
        status: "succeeded",
        progress: 100,
        attempts: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:05.000Z",
    });
    expect(synced.metadata?.taskOutcome).toEqual({
        phase: "ready",
        regenerate: "allowed",
        reason: "result_ready",
    });
});
