import { explainGenerationError, generationFailureMetadata, INPUT_REJECTED_ERROR_CATEGORIES, type GenerationErrorCategory, type GenerationFailureExplanation } from "@/lib/generation-error";
import { deliveryPendingTaskOutcome, isTaskOutcomeReconciling, isTaskOutcomeSubmissionUncertain, readTaskOutcome, taskOutcomeCopy, type TaskOutcome } from "@/lib/task-outcome";
import { CanvasGenerationDurableAckError } from "@/services/canvas-generation-errors";
import type { GenerationTask } from "@/services/api/task-center";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { authoritativeNodeOutcome, nodeFailureExplanation } from "@/lib/canvas/canvas-node-failure-state";
import { isInFlightGenerationTelemetryState, normalizeGenerationTaskProgress } from "@/lib/canvas/canvas-node-metadata-contract";
import { publishGenerationTaskTelemetry } from "@/stores/use-generation-task-telemetry";

export function isDepthCaptureResultNode(node: CanvasNodeData) {
    return Boolean(node.metadata?.depthSourceNodeId) && (!node.metadata?.taskType || node.metadata.taskType === "depth_capture");
}

export function canRecoverOrRetryDepthCapture(node: CanvasNodeData) {
    if (!isDepthCaptureResultNode(node)) return false;
    const explicit = authoritativeNodeOutcome(node.metadata);
    if (explicit) return explicit.phase === "failed" || explicit.phase === "retrievable" || explicit.phase === "ready";
    return ["failed", "cancelled", "succeeded"].includes(node.metadata?.taskStatus || "");
}

export function findDepthCaptureSourceNode(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const sourceNodeId = node.metadata?.depthSourceNodeId;
    return sourceNodeId ? nodes.find((candidate) => candidate.id === sourceNodeId) : undefined;
}

export function depthCaptureTaskMetadata(task: GenerationTask): CanvasNodeMetadata {
    publishGenerationTaskTelemetry(task);
    const outcome = readTaskOutcome(task);
    const active = outcome ? outcome.phase === "running" || outcome.phase === "fetching" : task.status === "queued" || task.status === "running";
    const inFlight = isInFlightGenerationTelemetryState(task);
    return {
        taskId: task.id,
        taskType: task.type,
        taskOutcome: task.outcome,
        taskOutcomeSource: undefined,
        taskStatus: task.status,
        taskStage: inFlight ? undefined : task.stage,
        taskProgress: inFlight ? undefined : normalizeGenerationTaskProgress(task.progress, task.status),
        taskProvider: task.provider,
        taskErrorCode: task.errorCode,
        taskOfficialStatus: inFlight ? undefined : task.officialStatus,
        generationErrorCode: undefined,
        model: task.model,
        taskProviderRequestId: inFlight ? undefined : task.providerRequestId,
        taskFailureDiagnostics: task.failureDiagnostics,
        taskCreatedAt: task.createdAt,
        taskUpdatedAt: inFlight ? undefined : task.updatedAt,
        taskCompletedAt: inFlight ? undefined : task.completedAt,
        generationErrorSummary: task.error,
        processingLabel: inFlight ? undefined : (task.stage || (task.type === "depth_capture" ? "正在生成深度视频" : "正在生成视频")),
        ...(active ? { status: "loading", errorDetails: undefined } : {}),
    };
}

export function depthCaptureWaitFailureMetadata(error: unknown, observed?: GenerationTask | string): CanvasNodeMetadata {
    const task = typeof observed === "object" ? observed : undefined;
    if (typeof observed === "string" || task?.status === "queued" || task?.status === "running") {
        return { status: "loading", errorDetails: undefined, generationErrorSummary: undefined, generationProviderCode: undefined, taskFailureDiagnostics: undefined, taskClientOperationTerminal: undefined, processingLabel: "暂时无法同步进度，请重新打开画布查看任务状态" };
    }
    if (task?.status === "succeeded") {
        const cause = error instanceof CanvasGenerationDurableAckError ? error.cause : error;
        const explanation = explainGenerationError(cause);
        return {
            ...generationFailureMetadata(new CanvasGenerationDurableAckError(cause), ""),
            taskOutcome: deliveryPendingTaskOutcome(),
            status: "error", taskStage: "画布应用结果", taskClientOperationTerminal: false,
            generationErrorSummary: explanation.summary,
            taskFailureDiagnostics: {
                ...task.failureDiagnostics, source: "client_result", executionResult: "completed",
                stage: "画布应用结果", summary: explanation.summary, requestId: explanation.requestId,
                httpStatus: explanation.httpStatus, capturedAt: new Date().toISOString(),
            },
        };
    }
    return { status: "error", taskOutcome: task?.outcome, errorDetails: task?.error || (error instanceof Error ? error.message : typeof error === "string" ? error : "深度处理失败"), generationErrorSummary: undefined, generationProviderCode: undefined, taskFailureDiagnostics: task?.failureDiagnostics, taskClientOperationTerminal: task?.status === "failed" || task?.status === "cancelled" };
}

const DELIVERY_PENDING_EXPLANATION_CATEGORIES: ReadonlySet<GenerationErrorCategory> = new Set([
    "canvas_conflict",
    "download_failed",
    "result_apply_failed",
    "delivery_failed",
]);

const ALLOWED_FAILURE_EXPLANATION_CATEGORIES: ReadonlySet<GenerationErrorCategory> = new Set([
    "request_not_sent",
    "cancelled",
    "auth",
    "permission",
    "quota_user",
    "quota_upstream",
    "quota_unknown",
    "quota_limit",
    "throttled",
    "concurrency",
    "model_missing",
    "provider_unavailable",
    "network",
    "async_failed",
    "malformed_response",
]);

// 节点存在权威 taskOutcome 时，主标题与操作指引默认以 taskOutcomeCopy 为准；
// 仅当 errorDetails 提供了结构化「原因 + 下一步」且错误分类与当前权威阶段/原因严格同属一类时（如参数/审核具体提示或网关下发的下载失败指引），保留细化文案。
function explanationMatchesAuthoritativeOutcome(outcome: TaskOutcome, explanation: GenerationFailureExplanation): boolean {
    if (!explanation.action || explanation.category === "unknown") return false;
    if (outcome.reason === "result_target_unavailable") {
        return explanation.category === "result_target_unavailable";
    }
    if (isTaskOutcomeReconciling(outcome)) return false;
    if (outcome.phase === "running" || outcome.phase === "fetching" || outcome.phase === "ready") return false;
    if (outcome.phase === "retrievable") {
        if (outcome.reason === "delivery_pending") return DELIVERY_PENDING_EXPLANATION_CATEGORIES.has(explanation.category);
        if (outcome.reason === "submission_unknown") return explanation.category === "submission_uncertain";
        return false;
    }
    if (
        outcome.regenerate === "blocked" ||
        outcome.reason === "charged_result_unrecoverable" ||
        outcome.reason === "result_unrecoverable"
    ) {
        return false;
    }
    if (outcome.reason === "input_rejected") {
        return INPUT_REJECTED_ERROR_CATEGORIES.has(explanation.category);
    }
    if (outcome.reason !== "task_failed" && INPUT_REJECTED_ERROR_CATEGORIES.has(explanation.category)) {
        return true;
    }
    if (outcome.regenerate === "confirm") {
        return false;
    }
    return ALLOWED_FAILURE_EXPLANATION_CATEGORIES.has(explanation.category);
}

export function canvasNodeFailureExplanation(node: CanvasNodeData) {
    const explicitOutcome = authoritativeNodeOutcome(node.metadata);
    const explanation = nodeFailureExplanation(node.metadata);
    // This action opens saved history; it must never dispatch another generation.
    if (explicitOutcome?.reason === "result_target_unavailable" || (!explicitOutcome && explanation.category === "result_target_unavailable")) {
        const copy = explicitOutcome ? taskOutcomeCopy(explicitOutcome) : undefined;
        return {
            ...explanation,
            ...(copy && !explanationMatchesAuthoritativeOutcome(explicitOutcome!, explanation) ? { reason: copy.reason, action: copy.action } : {}),
            uncertain: false,
            blockManualRetry: false,
        };
    }
    if (!canRecoverOrRetryDepthCapture(node)) {
        if (!explicitOutcome) return explanation;
        const copy = taskOutcomeCopy(explicitOutcome);
        const uncertain = isTaskOutcomeSubmissionUncertain(explicitOutcome);
        const keepRefinedCopy = explanationMatchesAuthoritativeOutcome(explicitOutcome, explanation);
        return {
            ...explanation,
            ...(keepRefinedCopy
                ? {}
                : {
                      reason: copy.reason,
                      action: copy.action,
                  }),
            uncertain,
            blockManualRetry: explicitOutcome.regenerate === "blocked",
        };
    }
    if (node.metadata?.taskStage === "已暂停，等待手动继续") {
        return { ...explanation, reason: "深度捕捉已暂停", action: "确认组件已安装后，点击重试继续", uncertain: false, retryable: true, blockAutomaticRetry: false, blockManualRetry: false };
    }
    if (explicitOutcome ? explicitOutcome.phase === "retrievable" || explicitOutcome.phase === "ready" : node.metadata?.taskStatus === "succeeded") {
        return { ...explanation, reason: "深度视频已生成，暂时未能显示在画布上", action: "点击「恢复结果」重新加载原任务", uncertain: false, retryable: true, blockAutomaticRetry: false, blockManualRetry: false };
    }
    return {
        ...explanation,
        ...(["unknown", "download_failed", "submission_uncertain"].includes(explanation.category) ? { reason: "深度处理失败", action: "请查看详情，检查深度组件和网络后重试" } : {}),
        uncertain: false,
        retryable: true,
        blockAutomaticRetry: false,
        blockManualRetry: false,
    };
}
