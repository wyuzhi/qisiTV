import { explainGenerationError, generationFailureMetadata } from "@/lib/generation-error";
import { normalizeTaskOutcome, readTaskOutcome, taskOutcomeCopy } from "@/lib/task-outcome";
import { CanvasGenerationDurableAckError } from "@/services/canvas-generation-errors";
import type { GenerationTask } from "@/services/api/task-center";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { authoritativeNodeOutcome, nodeFailureExplanation } from "@/lib/canvas/canvas-node-failure-state";

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
    const outcome = readTaskOutcome(task);
    const active = outcome ? outcome.phase === "running" || outcome.phase === "fetching" : task.status === "queued" || task.status === "running";
    return {
        taskId: task.id,
        taskType: task.type,
        taskOutcome: task.outcome,
        taskOutcomeSource: undefined,
        taskStatus: task.status,
        taskStage: task.stage,
        taskProgress: task.progress,
        taskProvider: task.provider,
        taskErrorCode: task.errorCode,
        taskOfficialStatus: task.officialStatus,
        generationErrorCode: undefined,
        model: task.model,
        taskProviderRequestId: task.providerRequestId,
        taskFailureDiagnostics: task.failureDiagnostics,
        taskCreatedAt: task.createdAt,
        taskUpdatedAt: task.updatedAt,
        taskCompletedAt: task.completedAt,
        generationErrorSummary: task.error,
        processingLabel: task.stage || (task.type === "depth_capture" ? "正在生成深度视频" : "正在生成视频"),
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
            taskOutcome: { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" },
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

export function canvasNodeFailureExplanation(node: CanvasNodeData) {
    const explicitOutcome = authoritativeNodeOutcome(node.metadata);
    const explanation = nodeFailureExplanation(node.metadata);
    // This action opens saved history; it must never dispatch another generation.
    if (explanation.category === "result_target_unavailable") return { ...explanation, blockManualRetry: false };
    if (!canRecoverOrRetryDepthCapture(node)) {
        if (!explicitOutcome) return explanation;
        const copy = taskOutcomeCopy(explicitOutcome);
        const isReconcileOutcome =
            explicitOutcome.reason === "settlement_pending" ||
            explicitOutcome.reason === "billing_pending" ||
            explicitOutcome.reason === "reconcile_pending";
        const useOutcomeCopy =
            isReconcileOutcome ||
            (explicitOutcome.phase === "retrievable" && explanation.category === "unknown") ||
            (explicitOutcome.regenerate === "confirm" && explanation.category === "unknown") ||
            (explicitOutcome.regenerate === "blocked" && explicitOutcome.phase !== "retrievable" && !explanation.uncertain) ||
            (explicitOutcome.regenerate === "allowed" && explanation.uncertain) ||
            (!node.metadata?.errorDetails && !node.metadata?.generationErrorCode && !node.metadata?.taskErrorCode);
        const uncertain = explicitOutcome.regenerate === "blocked" && explicitOutcome.phase !== "retrievable";
        return {
            ...explanation,
            ...(useOutcomeCopy
                ? {
                      reason: copy.reason,
                      action: copy.action,
                  }
                : {}),
            uncertain: uncertain || (explicitOutcome.phase === "retrievable" && explanation.uncertain),
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
