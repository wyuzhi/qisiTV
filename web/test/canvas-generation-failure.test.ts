import { describe, expect, test } from "bun:test";
import { buildNodeGenerationContext } from "../src/components/canvas/canvas-node-generation";
import { canvasGenerationFailureMetadata, canvasTaskFailureMetadata, canvasGenerationTaskNodes } from "../src/pages/canvas/canvas-generation-failure";
import { canReloadCanvasNodeResource, canvasNodeHasPendingOutcomeResult, isNodeRegenerateBlocked, isNodeRegenerateConfirm, isTaskRegenerateBlocked, readTaskOutcome } from "../src/lib/task-outcome";
import { taskAttentionReason } from "../src/pages/tasks/task-shared";
import { resolveMetadataReferences, generationTaskMetadata, resetGenerationTaskMetadata } from "../src/lib/canvas/canvas-project-generation";
import { ApiError } from "../src/services/api/request";
import { explainGenerationError, formatGenerationDiagnostics, unchangedModeratedPrompt } from "../src/lib/generation-error";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { GenerationTask } from "../src/services/api/task-center";
import moderationFixtures from "../../fixtures/moderation-errors.json";

const rejection = { code: "content_policy_violation", message: "opaque" };

test("confirmed unsent submission remains retryable after restoring the task", () => {
    const task = { id: "unsent-task", type: "canvas_video", status: "failed", stage: "任务失败", errorCode: "request_not_sent", error: "未能连接服务，本次请求尚未提交。请检查网络或代理后重试。" } as GenerationTask;
    const metadata = { ...generationTaskMetadata(task), ...canvasTaskFailureMetadata(task) };
    expect(isTaskRegenerateBlocked(task)).toBe(false);
    expect(isNodeRegenerateBlocked(metadata)).toBe(false);
    expect(explainGenerationError({ code: task.errorCode, message: task.error }).message).toContain("尚未提交");
    expect(isNodeRegenerateBlocked({ ...metadata, taskOutcome: undefined, taskStage: "submission_unknown", generationErrorCode: "submission_uncertain" })).toBe(true);
});

test("completed media with a canvas commit conflict offers reload without another paid generation", () => {
    const failure = canvasGenerationFailureMetadata({ code: "canvas_conflict" }, { prompt: "red square", mode: "video" });
    expect(failure.errorDetails).toContain("生成结果已保留");
    expect(failure.errorDetails).not.toContain("模型不接受");
    expect(canReloadCanvasNodeResource({ taskId: "task-1", ...failure })).toBe(true);
    expect(isNodeRegenerateBlocked(failure)).toBe(true);
});

test("backend canvas revision 409 offers reload without treating it as a model failure", () => {
    const failure = canvasGenerationFailureMetadata(
        new ApiError("云端画布已有更新，已停止覆盖；请保留本地草稿并加载最新版本", { status: 409, reason: "conflict" }),
        { prompt: "red square", mode: "image" },
    );
    expect(failure.generationErrorCode).toBe("canvas_conflict");
    expect(canReloadCanvasNodeResource({ taskId: "task-1", ...failure })).toBe(true);
    expect(failure.errorDetails).toContain("生成结果已保留");
    expect(failure.errorDetails).not.toContain("模型不接受");
    expect(isNodeRegenerateBlocked(failure)).toBe(true);
});
const task: GenerationTask = { id: "task-failure", type: "canvas_image", status: "failed", prompt: "draw", attempts: 1, createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z", errorCode: "content_policy_violation", error: "opaque" };
const image = (id: string, storageKey: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: `https://example.test/${id}.png`, storageKey } });

test("complete image input rejection permits changed input while uncertain tasks stay locked", () => {
    const corrected: GenerationTask = { ...task, stage: "任务失败", errorCode: "moderation_input", error: "输入文本未通过内容安全审核。请调整提示词后重新生成。" };
    const stale = image("rejected-node", "");
    stale.metadata = { taskId: task.id, status: "error", taskStage: "submission_unknown", generationSubmissionState: "unknown", generationErrorCode: "submission_uncertain" };
    const restored = canvasGenerationTaskNodes([stale], stale.id, corrected)[0];
    expect(restored.metadata?.errorDetails).toContain("输入文本未通过内容安全审核");
    expect(restored.metadata?.errorDetails).not.toContain("结果尚未确认");
    expect(canvasNodeHasPendingOutcomeResult(restored, [restored])).toBe(false);
    expect(isNodeRegenerateConfirm(restored.metadata)).toBe(true);
    expect(unchangedModeratedPrompt(restored.metadata, "draw")).toBe(true);
    expect(unchangedModeratedPrompt(restored.metadata, "a different drawing")).toBe(false);
    expect(readTaskOutcome(corrected)?.regenerate).toBe("confirm");
    const uncertain: GenerationTask = { ...task, stage: "submission_unknown", errorCode: "submission_uncertain", error: "图片结果尚未确认" };
    const pending = canvasGenerationTaskNodes([stale], stale.id, uncertain)[0];
    expect(canvasNodeHasPendingOutcomeResult(pending, [pending])).toBe(true);
    expect(isNodeRegenerateBlocked(pending.metadata)).toBe(true);
});

describe("canvas generation failure consumers", () => {
    test("copied diagnostics hide mounted and UNC paths and label configuration honestly", () => {
        for (const path of ["/Volumes/PrivateDrive/customer-A/image.png", "/Volumes/External Work/customer-A/image.png", String.raw`C:\Private User\customer-A\image.png`, String.raw`\\Private Server\Private Share\customer-A\image.png`, "/mnt/PrivateDrive/customer-A/image.png", String.raw`\\PrivateServer\PrivateShare\customer-A\image.png`]) {
            const copied = formatGenerationDiagnostics(explainGenerationError(new Error(`open ${path}: permission denied`)), { failureDiagnostics: { source: "local_result", summary: `open ${path}: permission denied`, input: { size: "auto", quality: "2k", count: "3", promptChars: 1, imageCount: 0, videoCount: 0, audioCount: 0 } } });
            expect(copied).not.toContain("Private");
            expect(copied).not.toContain("customer-A");
            expect(copied).toContain("任务配置（协议可能转换或省略）");
            expect(copied).not.toContain("提交参数");
        }
    });
    test("completed generation evidence survives a later canvas application failure", () => {
        const completed: GenerationTask = { ...task, status: "succeeded", failureDiagnostics: { source: "unknown", version: "1.5.9", platform: "windows/amd64", executionResult: "completed", requests: [{ operation: "image_edit", method: "POST", dispatched: true, outcome: "response_received", httpStatus: 200, requestId: "req-success-123", startedAt: "2026-09-30T15:39:23+08:00", durationMs: 48000, receivedBytes: 5672372 }], input: { size: "2048x2048", count: "1", promptChars: 20, imageCount: 3, videoCount: 0, audioCount: 0, maxImages: 2 } } };
        const metadata = canvasTaskFailureMetadata(completed, undefined, new Error("cannot apply result /Users/PRIVATE/image.png"));
        const copied = formatGenerationDiagnostics(explainGenerationError(metadata.errorDetails), { failureDiagnostics: metadata.taskFailureDiagnostics });
        expect(copied).toContain("错误来源：画布应用结果");
        expect(copied).toContain("生成执行：完成");
        expect(copied).toContain("收到响应（业务结果另判）");
        expect(copied).toContain("req-success-123");
        expect(copied).toContain("1.5.9 (windows/amd64)");
        expect(copied).toContain("尺寸=2048x2048");
        expect(copied).toContain("数量=1");
        expect(copied).toContain("5672372");
        expect(copied).not.toContain("PRIVATE");
    });
    test("task diagnostic survives canvas restore and is cleared before retry", () => {
        const diagnosticTask: GenerationTask = { ...task, errorCode: "invalid_params", failureDiagnostics: { source: "local_validation", summary: "当前图片模型最多支持 2 张参考图", stage: "校验输入" } };
        const metadata = { ...generationTaskMetadata(diagnosticTask), ...canvasTaskFailureMetadata(diagnosticTask) };
        const copied = formatGenerationDiagnostics(explainGenerationError(metadata.errorDetails), { taskId: metadata.taskId, failureDiagnostics: metadata.taskFailureDiagnostics });
        expect(copied).toContain("当前图片模型最多支持 2 张参考图");
        expect(copied).toContain("错误来源：本地参数校验");
        expect(resetGenerationTaskMetadata(metadata).taskFailureDiagnostics).toBeUndefined();
        expect(resetGenerationTaskMetadata(metadata).generationErrorSummary).toBeUndefined();
    });
    test("task cards and restored canvas retain specific moderation guidance", () => {
        for (const fixture of moderationFixtures) {
            const error = `${fixture.reason}。${fixture.action}。排查编号：请求 req_moderation_123。`;
            const failedTask = { ...task, error, errorCode: fixture.category };
            expect(taskAttentionReason(failedTask)).toContain(fixture.reason);
            expect(taskAttentionReason(failedTask)).toContain(fixture.action);
            expect(canvasTaskFailureMetadata(failedTask).errorDetails).toBe(error);
            expect(readTaskOutcome(failedTask)?.regenerate).toBe("confirm");
        }
    });
    test("actual connected reference, rather than the source image itself, controls moderation retry", () => {
        const source = image("source", "resource:source");
        const first = image("reference-a", "resource:a");
        const second = image("reference-b", "resource:b");
        const nodes = [source, first, second];
        const context = (referenceId: string) => buildNodeGenerationContext(source.id, nodes, [{ id: "input", fromNodeId: referenceId, toNodeId: source.id }], "redraw @图片1", []);
        const submitted = context(first.id);
        const failure = canvasGenerationFailureMetadata(rejection, submitted);
        expect(submitted.referenceImages.map((reference) => reference.id)).toEqual([first.id]);
        expect(unchangedModeratedPrompt(failure, submitted.prompt, submitted.referenceImages)).toBe(true);
        expect(unchangedModeratedPrompt(failure, context(second.id).prompt, context(second.id).referenceImages)).toBe(false);
        expect(unchangedModeratedPrompt(failure, "different drawing", submitted.referenceImages)).toBe(false);
    });

    test("stable resources ignore preview URL rotation but detect content replacement", () => {
        const input = { prompt: "draw", referenceImages: [{ id: "ref", storageKey: "resource:old", url: "blob:old" }] };
        const failure = canvasGenerationFailureMetadata(rejection, input);
        expect(unchangedModeratedPrompt(failure, "draw", [{ storageKey: "resource:old" }])).toBe(true);
        expect(unchangedModeratedPrompt(failure, "draw", [{ storageKey: "resource:new" }])).toBe(false);
        const raw = { prompt: "draw", referenceImages: [{ id: "ref", dataUrl: "data:image/png;base64,a" }] };
        expect(unchangedModeratedPrompt(canvasGenerationFailureMetadata(rejection, raw), "draw", [{ url: "data:image/png;base64,b" }])).toBe(false);
    });

    test("video, audio and masks are part of the submitted moderation input", () => {
        const input = { prompt: "draw", referenceVideos: [{ id: "video", storageKey: "resource:video" }], referenceAudios: [{ id: "audio", storageKey: "resource:audio" }], mask: { id: "mask", dataUrl: "mask-a" } };
        const failure = canvasGenerationFailureMetadata(rejection, input);
        expect(unchangedModeratedPrompt(failure, "draw", [{ storageKey: "resource:video" }, { storageKey: "resource:audio" }, { url: "mask-a" }])).toBe(true);
        expect(unchangedModeratedPrompt(failure, "draw", [{ storageKey: "resource:video" }, { url: "mask-a" }])).toBe(false);
        expect(unchangedModeratedPrompt(failure, "draw", [{ storageKey: "resource:video" }, { storageKey: "resource:audio" }, { url: "mask-b" }])).toBe(false);
        const imageOnly = { ...input, mode: "image" as const };
        expect(unchangedModeratedPrompt(canvasGenerationFailureMetadata(rejection, imageOnly), "draw", [{ url: "mask-a" }])).toBe(true);
    });

    test("stored references survive a deleted source without pretending to be new input", async () => {
        const input = { prompt: "draw", referenceImages: [{ id: "deleted-source", url: "https://example.test/reference.png" }] };
        const failure = canvasGenerationFailureMetadata(rejection, input);
        const recovered = await resolveMetadataReferences({ generationType: "edit", references: ["https://example.test/reference.png"] });
        expect(recovered).not.toBeNull();
        expect(recovered).toHaveLength(1);
        expect(unchangedModeratedPrompt(failure, "draw", recovered!.map((ref) => ({ url: ref.url })))).toBe(true);
        expect(await resolveMetadataReferences({ generationType: "edit", references: [] })).toBeNull();
    });

    test("retrievable and input-rejected outcomes map to blocked or confirm regenerate modes", () => {
        for (const generationErrorCode of ["submission_uncertain", "download_failed"]) {
            expect(isNodeRegenerateBlocked({ generationErrorCode, errorDetails: "opaque" })).toBe(true);
        }
        for (const generationErrorCode of ["invalid_params", "moderation_reference"]) {
            expect(isNodeRegenerateConfirm({ generationErrorCode, errorDetails: "opaque" })).toBe(true);
        }
        expect(isNodeRegenerateBlocked({ generationErrorCode: "throttled", errorDetails: "opaque" })).toBe(false);
        expect(isNodeRegenerateBlocked({ generationErrorCode: "auth", errorDetails: "opaque" })).toBe(false);
    });

    test("task recovery uses the original submitted references and structured error code", () => {
        const submitted = { prompt: "draw", referenceImages: [{ id: "ref", storageKey: "resource:old" }] };
        const failure = canvasTaskFailureMetadata({ ...task, inputJson: JSON.stringify(submitted) });
        expect(unchangedModeratedPrompt(failure, "draw", [{ storageKey: "resource:old" }])).toBe(true);
        expect(unchangedModeratedPrompt(failure, "draw", [{ storageKey: "resource:new" }])).toBe(false);
        const restored = canvasTaskFailureMetadata(task, { ...failure, taskId: task.id });
        expect(restored.failedInputFingerprint).toBe(failure.failedInputFingerprint);
    });

    test("task cards never expose raw nested JSON in the visible reason or tooltip", () => {
        const raw = { ...task, error: '{"error":{"code":"400","message":"Height must be between 300px and 6000px"}}', errorCode: "invalid_params" };
        const reason = taskAttentionReason(raw);
        expect(reason).not.toContain("{");
        // 后端只下发整理过的文案；收到原始 JSON 时只显示类别文案，不外露 JSON。
        expect(reason).toContain("模型不接受当前参数");
        const backend = taskAttentionReason({ ...task, error: "参考素材高度不符合模型要求。请将高度调整为 300–6000 像素后重新提交。", errorCode: "invalid_params" });
        expect(backend).toContain("高度");
        expect(backend).toContain("300–6000");
    });

    test("task cards preserve a machine-readable failure code alongside an opaque message", () => {
        expect(taskAttentionReason({ ...task, error: undefined, errorCode: "moderation_reference" })).toContain("参考素材");
        expect(isTaskRegenerateBlocked({ ...task, errorCode: "download_failed" })).toBe(true);
        expect(readTaskOutcome({ ...task, errorCode: "invalid_params" })?.regenerate).toBe("confirm");
        expect(isTaskRegenerateBlocked({ ...task, errorCode: "throttled" })).toBe(false);
        expect(isTaskRegenerateBlocked({ ...task, errorCode: "throttled", stage: "submission_unknown" })).toBe(true);
    });

    test("canvas batch items and creation recovery preserve errorCode and classify via structured { code, message }", async () => {
        const { isContentModerationError, generationErrorMessage } = await import("../src/lib/generation-error");
        const { recoverCreationTextTask } = await import("../src/services/creation-text-task-recovery");
        const { reconcileCreationTaskMessages } = await import("../src/pages/create/creation-conversations");
        const { isGenerationSubmissionUncertainError } = await import("../src/lib/canvas/canvas-generation-batch");

        const batchItem = {
            id: "batch-item-1",
            rowId: "row-1",
            nodeId: "node-1",
            status: "failed" as const,
            retryCount: 0,
            errorDetails: "第 1 张参考图片疑似包含真人形象，该模型拒绝生成。请检查并更换参考图片后重新生成。",
            errorCode: "moderation_reference",
        };
        const batchErrorInput = { code: batchItem.errorCode, message: batchItem.errorDetails };
        expect(isContentModerationError(batchErrorInput)).toBe(true);
        expect(explainGenerationError(batchErrorInput).blockManualRetry).toBe(true);
        expect(generationErrorMessage(batchErrorInput)).toBe(batchItem.errorDetails);
        expect(isGenerationSubmissionUncertainError({ code: "submission_uncertain", message: "普通错误描述" })).toBe(true);

        const textRecovery = recoverCreationTextTask(
            { mode: "text", status: "pending", content: "", taskIds: ["text-task-1"] },
            [{ ...task, id: "text-task-1", type: "canvas_text", status: "failed", errorCode: "quota_user", error: "当前账号可用额度不足。请检查账号余额。" }],
        );
        expect(textRecovery).toMatchObject({
            status: "error",
            error: "当前账号可用额度不足。请检查账号余额。",
            generationErrorCode: "quota_user",
        });

        const reconciled = reconcileCreationTaskMessages(
            { recoverCreationTextTask } as unknown as Parameters<typeof reconcileCreationTaskMessages>[0],
            [{
                id: "conv-1",
                title: "测试",
                updatedAt: "2026-10-01T00:00:00Z",
                messages: [{ id: "msg-1", role: "assistant", mode: "video", status: "pending", content: "", createdAt: "2026-10-01T00:00:00Z", taskIds: ["video-task-1"] }],
            }],
            [{ ...task, id: "video-task-1", type: "canvas_video", status: "failed", errorCode: "moderation_output", error: "生成视频未通过内容安全审核。请调整提示词或参考素材后重新生成。" }],
        );
        const failedMsg = reconciled[0]?.messages[0];
        expect(failedMsg?.status).toBe("error");
        expect(failedMsg?.generationErrorCode).toBe("moderation_output");
        expect(explainGenerationError({ code: failedMsg?.generationErrorCode, message: failedMsg?.error }).category).toBe("moderation_output");
        expect(explainGenerationError({ code: failedMsg?.generationErrorCode, message: failedMsg?.error }).blockManualRetry).toBe(true);
    });
});

test("an unrecoverable result keeps the backend conclusion when applying it fails", () => {
    const task = { id: "lost-result", type: "canvas_video", status: "succeeded", stage: "任务完成", outcome: { phase: "failed", regenerate: "confirm", reason: "result_unrecoverable" } } as GenerationTask;
    const metadata = canvasTaskFailureMetadata(task, undefined, new Error("下载结果失败"));
    expect(metadata.taskOutcome).toEqual({ phase: "failed", regenerate: "confirm", reason: "result_unrecoverable" });
    expect(isNodeRegenerateBlocked(metadata)).toBe(false);
    expect(metadata.errorDetails).not.toContain("继续取回");
    expect(metadata.generationErrorCode).toBeUndefined();
    const retained = canvasTaskFailureMetadata({ ...task, outcome: undefined }, undefined, new Error("下载结果失败"));
    expect(retained.taskOutcome).toEqual({ phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" });
});
