import {
    hasConfirmedGeneratedMediaEvidence,
    hasSettledFileUploadMedia,
    hasStaleSettledFileUploadFlag,
    isFileUploadOverlayActive,
    isNonEmptyMediaRef,
} from "@/lib/canvas/canvas-node-metadata-contract";
import type { CanvasGenerationMode, CanvasNodeData } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";

export function generationTaskInput(task: GenerationTask) {
    if (!task.inputJson) return null;
    try {
        return JSON.parse(task.inputJson) as { mode?: CanvasGenerationMode; metadata?: { nodeId?: string; sourceNodeId?: string; domainProjectId?: string }; prompt?: string };
    } catch {
        return null;
    }
}

export function generationTaskNodeId(task: GenerationTask) {
    return task.clientContext?.nodeId || generationTaskInput(task)?.metadata?.nodeId || "";
}

export function resolveEffectiveCanvasNodeOrigin(meta: CanvasNodeData["metadata"]) {
    const rawOrigin = meta?.resultOrigin;
    if (rawOrigin && rawOrigin !== "unknown") return rawOrigin;
    if (meta?.fileUploadAttemptId || hasStaleSettledFileUploadFlag(meta)) return "upload";
    return undefined;
}

/**
 * 判断画布节点是否允许接收该生成任务的状态同步或结果写回。
 * 若节点正在本地上传、已由本地/素材库替换完成，或已绑定到其他生成任务，则拒绝旧任务按 nodeId 覆盖。
 */
export function canCanvasNodeAcceptGenerationTask(
    node: CanvasNodeData | undefined,
    task: Pick<GenerationTask, "id" | "clientOperationId"> & Partial<Pick<GenerationTask, "status" | "outcome">>,
): boolean {
    if (!node) return false;
    const taskId = task.id?.trim() || "";
    if (!taskId) return false;
    const meta = node.metadata;
    if (isFileUploadOverlayActive(meta)) return false;

    const effectiveOrigin = resolveEffectiveCanvasNodeOrigin(meta);

    // 非生成来源（本地上传、素材库、外部导入）绝不允许被任何生成任务按 nodeId 写回；
    // 只有显式重置为 generator（清空 resultOrigin）或新建的 generated/derived 节点才能接收生成任务。
    if (effectiveOrigin === "upload" || effectiveOrigin === "library" || effectiveOrigin === "imported") {
        return false;
    }

    const hasGenerationIntent = meta?.status === "loading"
        || meta?.generationSubmissionState === "submitting"
        || meta?.generationSubmissionState === "unknown"
        || typeof meta?.taskOutputIndex === "number"
        || meta?.agentGenerationContinuation?.status === "pending";

    const nodeOpId = meta?.taskClientOperationId?.trim() || "";
    const taskOpId = task.clientOperationId?.trim() || "";
    const matchesOperationId = Boolean(nodeOpId && taskOpId && nodeOpId === taskOpId);

    const nodeTaskId = meta?.taskId?.trim() || "";
    if (nodeTaskId) {
        if (nodeTaskId !== taskId) return false;
        if (!hasGenerationIntent && hasSettledFileUploadMedia(meta) && !effectiveOrigin) {
            if (!hasConfirmedGeneratedMediaEvidence(meta) && !matchesOperationId) {
                return false;
            }
            if (
                task.status === "failed"
                || task.status === "cancelled"
                || task.outcome?.phase === "failed"
            ) {
                return false;
            }
        }
        return true;
    }

    const continuationTaskId = meta?.agentGenerationContinuation?.taskId?.trim() || "";
    if (continuationTaskId) {
        return continuationTaskId === taskId;
    }

    if (nodeOpId) {
        return matchesOperationId;
    }

    if (effectiveOrigin === "derived" && meta?.status !== "loading") {
        return false;
    }

    const hasSettledNonGenerationContent = meta?.status === "success"
        && (isNonEmptyMediaRef(meta.content) || isNonEmptyMediaRef(meta.storageKey) || isNonEmptyMediaRef(meta.assetId));
    if (!hasGenerationIntent && hasSettledNonGenerationContent) {
        return false;
    }

    return true;
}

/**
 * 判断 bindBackendCanvasGenerationResult 是否允许对该节点发起或应用绑定回执。
 * 缺失节点一律拒绝；除满足 canCanvasNodeAcceptGenerationTask 的节点外，仅保留“节点已切到另一条生成 taskId”时的幂等重放投影路径
 *（由服务端返回 bindingStatus="replaced" 确认快照）；任何上传中、非生成来源或不匹配当前任务的 derived/完成媒体均在此拦截。
 */
export function canCanvasNodeEnterGenerationBind(
    node: CanvasNodeData | undefined,
    task: Pick<GenerationTask, "id" | "clientOperationId"> & Partial<Pick<GenerationTask, "status" | "outcome">>,
): boolean {
    if (!node) return false;
    if (canCanvasNodeAcceptGenerationTask(node, task)) return true;
    const meta = node.metadata;
    const effectiveOrigin = resolveEffectiveCanvasNodeOrigin(meta);
    if (isFileUploadOverlayActive(meta)) return false;
    if (
        effectiveOrigin === "upload"
        || effectiveOrigin === "library"
        || effectiveOrigin === "imported"
        || effectiveOrigin === "derived"
    ) {
        return false;
    }
    return Boolean(meta?.taskId?.trim());
}
