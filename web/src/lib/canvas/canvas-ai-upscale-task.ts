import { deliveryPendingTaskOutcome, isRegenerateBlocked, isTaskOutcomeWorking } from "@/lib/task-outcome";
import { authoritativeNodeOutcome } from "@/lib/canvas/canvas-node-failure-state";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { ApiError, getTransportFailureKind } from "@/services/api/request";
import type { GenerationTask } from "@/services/api/task-center";
import { SMART_ERASE_TASK_OPERATIONS } from "@/services/api/video-subtitle-erase";

// A stopped observer says nothing about the paid task's execution state.
export const UPSCALE_OBSERVATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function isAIUpscaleTask(task: Pick<GenerationTask, "type" | "model" | "operation">): boolean {
    if (task.operation?.startsWith("media.upscale.")) return true;
    return (task.type === "canvas_image" && ["topaz-standard-v2", "topaz-wonder-3.5"].includes(task.model || "")) ||
        (task.type === "canvas_video" && ["topaz-proteus", "topaz-starlight-fast-2"].includes(task.model || ""));
}

export function isVideoSubtitleEraseTask(task: Pick<GenerationTask, "operation">): boolean {
    return Boolean(task.operation && SMART_ERASE_TASK_OPERATIONS.includes(task.operation));
}

export function isVideoSubtitleEraseNode(node?: CanvasNodeData): boolean {
    return Boolean(node?.metadata?.videoSubtitleEraseSourceNodeId);
}

export function canRecoverManagedToolNode(node?: CanvasNodeData): boolean {
    const metadata = node?.metadata;
    const op = metadata?.workflowOperation?.id;
    if (!metadata || (!op?.endsWith(".ai-upscale") && !isVideoSubtitleEraseNode(node))) return false;
    const explicitOutcome = authoritativeNodeOutcome(metadata);
    if (explicitOutcome) {
        return explicitOutcome.phase === "retrievable"
            || (explicitOutcome.phase === "ready" && !metadata.content && !metadata.storageKey);
    }
    if (metadata.generationSubmissionState === "rejected" && !metadata.taskId) return false;
    return Boolean(metadata.taskId || metadata.taskClientOperationId);
}

export function isDefinitePreAdmissionClientReject(error: unknown): boolean {
    return error instanceof ApiError
        && error.status !== undefined
        && error.status >= 400
        && error.status < 500
        && error.status !== 408
        && error.status !== 429
        && !getTransportFailureKind(error);
}

export function unknownSubmissionMetadata(reasonText: string): Partial<CanvasNodeMetadata> {
    const detail = reasonText ? `（${reasonText}）` : "";
    return {
        status: "error",
        generationSubmissionState: "unknown",
        errorDetails: `提交回执待确认，请点击「取回原结果」查询任务状态，暂勿重复提交${detail}`,
    };
}

export function hasPendingUpscaleTask(metadata?: CanvasNodeMetadata): boolean {
    if (!metadata) return false;
    // 成功任务的结果已经落到节点上时，旧的「待取回」结论不再有效。
    if (metadata.taskStatus === "succeeded" && (metadata.content || metadata.storageKey)) return false;
    const explicitOutcome = authoritativeNodeOutcome(metadata);
    if (explicitOutcome) {
        if (explicitOutcome.phase === "ready") return !metadata.content && !metadata.storageKey;
        return isTaskOutcomeWorking(explicitOutcome) || isRegenerateBlocked(explicitOutcome);
    }
    // Only a failure before calling the task API proves that no paid task exists.
    if (metadata.generationSubmissionState === "rejected" && !metadata.taskId) return false;
    if (metadata.taskStatus === "succeeded") return !metadata.content && !metadata.storageKey;
    if (metadata.taskId || metadata.taskClientOperationId) return true;
    return metadata.generationSubmissionState === "unknown" || metadata.generationSubmissionState === "submitting";
}

export function upscaleObservationFailureMetadata(task: Pick<GenerationTask, "id" | "status" | "outcome" | "operation">, errorDetails: string): Partial<CanvasNodeMetadata> {
    const terminal = task.status === "failed" || task.status === "cancelled" || task.status === "succeeded";
    const resolvedOutcome = task.outcome ?? (task.status === "succeeded" ? deliveryPendingTaskOutcome() : undefined);
    const terminalFailureDetails = resolvedOutcome && !isRegenerateBlocked(resolvedOutcome)
        ? errorDetails
        : `请先在任务详情核对原任务与扣费状态，暂勿重复提交。${errorDetails}`;
    return {
        taskId: task.id,
        taskOutcome: resolvedOutcome,
        taskStatus: task.status,
        status: terminal ? "error" : "loading",
        ...(terminal ? {
            errorDetails: task.status === "succeeded" ? `云端已完成，结果暂未载入。请从任务详情取回结果，或重新打开画布恢复。${errorDetails}` : terminalFailureDetails,
        } : {
            processingLabel: isVideoSubtitleEraseTask(task) ? "视频处理任务状态待确认" : "超分任务状态待确认",
            taskStage: "状态同步中断，请重新打开画布查询",
            errorDetails: "暂时无法同步进度，云端任务可能仍在处理。请重新打开画布查询，暂勿重复提交。",
        }),
    };
}

export function canRecoverUpscaleNode(node: CanvasNodeData): boolean {
    const metadata = node.metadata;
    if (!metadata?.workflowOperation?.id.endsWith(".ai-upscale") || !metadata.taskId) return false;
    const explicitOutcome = authoritativeNodeOutcome(metadata);
    if (explicitOutcome) {
        return explicitOutcome.phase === "retrievable" || explicitOutcome.phase === "failed" || (explicitOutcome.phase === "ready" && !metadata.content && !metadata.storageKey);
    }
    return metadata.status === "error" || metadata.taskStatus === "failed" || (metadata.taskStatus === "succeeded" && !metadata.content && !metadata.storageKey);
}
