import { authoritativeNodeOutcome } from "@/lib/canvas/canvas-node-failure-state";
import { isTaskOutcomeWorking, readNodeTaskOutcome } from "@/lib/task-outcome";
import type { CanvasNodeData } from "@/types/canvas";

/** A historical taskId is not a lock. Only live task states / submission are. */
export function isCanvasNodeGenerating(node: CanvasNodeData | undefined, runningNodeId?: string | null) {
    if (!node) return false;
    if (runningNodeId === node.id) return true;
    const meta = node.metadata;
    if (meta?.status === "error") return false;
    // A locally derived outcome only repeats old display rules; it is not a live task.
    const outcome = authoritativeNodeOutcome(meta);
    if (outcome) {
        if (outcome.phase === "running" || outcome.phase === "fetching") return true;
        if (outcome.phase === "ready") return !meta?.content && !meta?.storageKey && meta?.status !== "success";
        return false;
    }
    if (meta?.taskId && (meta.taskStatus === "queued" || meta.taskStatus === "running")) return true;
    if (meta?.taskStatus === "succeeded" && !meta.content && !meta.storageKey) return true;
    if (["succeeded", "failed", "cancelled"].includes(meta?.taskStatus || "")) return false;
    return meta?.status === "loading" || Boolean(meta?.taskId && meta.status !== "success");
}

export function hasCancellableCanvasNodeTask(node: CanvasNodeData | undefined) {
    if (!node) return false;
    if (isCanvasNodeGenerating(node)) return true;
    const meta = node.metadata;
    if (isTaskOutcomeWorking(authoritativeNodeOutcome(meta))) return true;
    return Boolean(meta?.taskId && isTaskOutcomeWorking(readNodeTaskOutcome(meta)));
}
