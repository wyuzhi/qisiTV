import { isRegenerateBlocked, isTaskOutcomeWorking } from "@/lib/task-outcome";
import { authoritativeNodeOutcome } from "@/lib/canvas/canvas-node-failure-state";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";

// A stopped observer says nothing about the paid task's execution state.
export const UPSCALE_OBSERVATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function isAIUpscaleTask(task: Pick<GenerationTask, "type" | "model">): boolean {
    return (task.type === "canvas_image" && ["topaz-standard-v2", "topaz-wonder-3.5", "huoshan_image_super_resolution"].includes(task.model || "")) ||
        (task.type === "canvas_video" && ["topaz-proteus", "topaz-starlight-fast-2", "tengxun_video_super_resolution"].includes(task.model || ""));
}

export function hasPendingUpscaleTask(metadata?: CanvasNodeMetadata): boolean {
    if (!metadata) return false;
    // 成功任务的结果已经落到节点上时，旧的「待取回」结论不再有效。
    if (metadata.taskStatus === "succeeded" && (metadata.content || metadata.storageKey)) return false;
    const explicitOutcome = authoritativeNodeOutcome(metadata);
    if (explicitOutcome) {
        if (explicitOutcome.phase === "ready") return !metadata.content && !metadata.storageKey;
        return isTaskOutcomeWorking(explicitOutcome) || isRegenerateBlocked(explicitOutcome) || Boolean(metadata.taskId);
    }
    // Only a failure before calling the task API proves that no paid task exists.
    if (metadata.generationSubmissionState === "rejected" && !metadata.taskId) return false;
    if (metadata.taskStatus === "succeeded") return !metadata.content && !metadata.storageKey;
    if (metadata.taskId || metadata.taskClientOperationId) return true;
    return metadata.generationSubmissionState === "unknown" || metadata.generationSubmissionState === "submitting";
}

export function upscaleObservationFailureMetadata(task: Pick<GenerationTask, "id" | "status" | "outcome">, errorDetails: string): Partial<CanvasNodeMetadata> {
    const terminal = task.status === "failed" || task.status === "cancelled" || task.status === "succeeded";
    return {
        taskId: task.id,
        taskOutcome: task.outcome ?? (task.status === "succeeded" ? { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" } : undefined),
        taskStatus: task.status,
        status: terminal ? "error" : "loading",
        ...(terminal ? {
            errorDetails: task.status === "succeeded" ? `云端已完成，结果暂未载入。请从任务详情取回结果，或重新打开画布恢复。${errorDetails}` : `请先在任务详情核对原任务与扣费状态，暂勿重复提交。${errorDetails}`,
        } : {
            processingLabel: "超分任务状态待确认",
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
