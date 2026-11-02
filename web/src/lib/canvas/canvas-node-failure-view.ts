import { canvasNodeFailureExplanation, canRecoverOrRetryDepthCapture, isDepthCaptureResultNode } from "@/lib/canvas/canvas-depth-capture";
import { isGenerationSubmissionUncertainError } from "@/lib/canvas/canvas-generation-batch";
import { CONTENT_MODERATION_ERROR_CODE, isContentModerationError, type GenerationFailureExplanation } from "@/lib/generation-error";
import { isGenerationTaskSubmissionUncertain } from "@/lib/generation-task-display";
import {
    canReloadCanvasNodeResource,
    canvasNodeHasPendingOutcomeResult,
    isNodeRegenerateBlocked,
    isNodeRegenerateConfirm,
    readNodeTaskOutcome,
    taskOutcomeCopy,
    type TaskOutcome,
    type TaskOutcomeCopy,
} from "@/lib/task-outcome";
import type { CanvasNodeData } from "@/types/canvas";
import { authoritativeNodeOutcome } from "@/lib/canvas/canvas-node-failure-state";
import type { GenerationTask } from "@/services/api/task-center";

/**
 * 一个节点今天会怎么显示失败、用户能做什么。
 * 每个字段都直接调用原来那一处的判断，不重新推导。
 * 字段之间可以互相矛盾：那是各处今天的差异，收进来是为了以后只改这一处。
 */
export type CanvasNodeFailureView = {
    outcome?: TaskOutcome;
    /** `taskOutcomeCopy(outcome)`，给确认弹窗和状态徽章用。 */
    copy: TaskOutcomeCopy;
    /** `canvasNodeFailureExplanation` 的完整结果。卡片文案、按钮和复制排查信息都读它。 */
    explanation: GenerationFailureExplanation;
    /** 错误卡片是否隐藏「重新生成」。深度结果和「去生成历史」除外。 */
    retryBlocked: boolean;
    /** 悬停重试、批量子项「重新生成」用的拦截。 */
    regenerateBlocked: boolean;
    /** 单独重试前要先确认，批量重试会跳过。 */
    regenerateConfirm: boolean;
    /** 是否显示「继续取回」。批量子项永远是 false。 */
    canReload: boolean;
    /** 打开画布时是否还要和任务中心对账。 */
    needsRecovery: boolean;
    /**
     * 手动重试的第一条分岔，只区分「去生成历史」和「继续按节点类型走」。
     * 深度、分镜、批量根的后续分岔仍由 `canvasNodeRetryPlan` 决定。
     */
    recoveryRoute: "single" | "history";
    /** 错误卡片把这次失败画成「提交未确认」。 */
    cardSubmissionUncertain: boolean;
    /** 批次对账写在批次项上的「提交未确认」。和卡片不是同一条规则。 */
    batchSubmissionUncertain: boolean;
    /** 改提示词时是否清掉任务绑定。只认审核失败。 */
    moderationResetOnPromptEdit: boolean;
    /** 节点自己或批量子项还有待取回的结果。 */
    pendingOutcome: boolean;
    depthResult: boolean;
    /** 批量子项在失败状态下是否显示「重新生成」。 */
    batchRegenerateVisible: boolean;
};

const LEGACY_INTERRUPTED_GENERATION_DETAILS = "页面刷新后生成已中断，请重新生成。";

function nodeNeedsGenerationRecovery(node: CanvasNodeData) {
    const metadata = node.metadata;
    if (!metadata || metadata.generationErrorCode === "result_target_unavailable" || metadata.fileUpload === "uploading" || isDepthCaptureResultNode(node)) return false;
    const pendingAgentContinuation = metadata.agentGenerationContinuation?.status === "pending";
    const aggregateBatchRoot = metadata.isBatchRoot && metadata.batchChildIds?.length && !metadata.taskId;
    if (aggregateBatchRoot && !pendingAgentContinuation) return false;
    return pendingAgentContinuation || ["submitting", "unknown"].includes(metadata.generationSubmissionState || "") || metadata.status === "loading" || metadata.errorDetails === LEGACY_INTERRUPTED_GENERATION_DETAILS || Boolean(metadata.taskId && (metadata.status !== "success" || (metadata.taskStatus === "succeeded" && !metadata.content && !metadata.storageKey)));
}

export function canvasNodeFailureView(
    node: CanvasNodeData,
    options?: { nowMs?: number; allNodes?: CanvasNodeData[] },
): CanvasNodeFailureView {
    return new NodeFailureView(node, options);
}

// A hot caller reading one flag must not classify text or scan batch children.
// Cache only within this view; a new node snapshot always gets a fresh view.
class NodeFailureView implements CanvasNodeFailureView {
    private cache: Partial<CanvasNodeFailureView> = {};

    constructor(
        private node: CanvasNodeData,
        private options?: { nowMs?: number; allNodes?: CanvasNodeData[] },
    ) {}

    private read<K extends keyof CanvasNodeFailureView>(key: K, compute: () => CanvasNodeFailureView[K]): CanvasNodeFailureView[K] {
        if (!(key in this.cache)) this.cache[key] = compute();
        return this.cache[key] as CanvasNodeFailureView[K];
    }

    get outcome() { return this.read("outcome", () => readNodeTaskOutcome(this.node.metadata)); }
    get copy() { return this.read("copy", () => taskOutcomeCopy(this.outcome, this.options?.nowMs)); }
    get explanation() { return this.read("explanation", () => canvasNodeFailureExplanation(this.node)); }
    get regenerateBlocked() { return this.read("regenerateBlocked", () => isNodeRegenerateBlocked(this.node.metadata)); }
    get regenerateConfirm() { return this.read("regenerateConfirm", () => isNodeRegenerateConfirm(this.node.metadata)); }
    get canReload() { return this.read("canReload", () => canReloadCanvasNodeResource(this.node)); }
    get needsRecovery() { return this.read("needsRecovery", () => nodeNeedsGenerationRecovery(this.node)); }
    get depthResult() { return this.read("depthResult", () => isDepthCaptureResultNode(this.node)); }
    get pendingOutcome() { return this.read("pendingOutcome", () => canvasNodeHasPendingOutcomeResult(this.node, this.options?.allNodes ?? [])); }
    get retryBlocked() {
        return this.read("retryBlocked", () => !canRecoverOrRetryDepthCapture(this.node) && this.explanation.category !== "result_target_unavailable" && (this.canReload || this.regenerateBlocked));
    }
    get recoveryRoute() {
        return this.read("recoveryRoute", () => this.outcome?.reason === "result_target_unavailable" || this.explanation.category === "result_target_unavailable" ? "history" : "single");
    }
    get cardSubmissionUncertain() {
        return this.read("cardSubmissionUncertain", () => {
            const metadata = this.node.metadata;
            const task = {
                outcome: authoritativeNodeOutcome(metadata), provider: metadata?.taskProvider,
                status: (metadata?.taskStatus || "failed") as GenerationTask["status"],
                stage: metadata?.taskStage, officialStatus: metadata?.taskOfficialStatus,
                errorCode: metadata?.taskErrorCode || metadata?.generationErrorCode,
            };
            return isGenerationTaskSubmissionUncertain(task) || this.explanation.uncertain;
        });
    }
    get batchSubmissionUncertain() {
        return this.read("batchSubmissionUncertain", () => {
            const metadata = this.node.metadata;
            const errorCode = metadata?.generationErrorCode || metadata?.taskErrorCode;
            const errorDetails = metadata?.errorDetails || "";
            return errorCode === "submission_uncertain" || isGenerationSubmissionUncertainError(errorCode ? { code: errorCode, message: errorDetails } : new Error(errorDetails));
        });
    }
    get moderationResetOnPromptEdit() {
        return this.read("moderationResetOnPromptEdit", () => {
            const metadata = this.node.metadata;
            const errorCode = metadata?.generationErrorCode || metadata?.taskErrorCode;
            return metadata?.generationErrorCode === CONTENT_MODERATION_ERROR_CODE || isContentModerationError(errorCode ? { code: errorCode, message: metadata?.errorDetails } : metadata?.errorDetails);
        });
    }
    get batchRegenerateVisible() { return this.read("batchRegenerateVisible", () => this.node.metadata?.status === "error" && !this.regenerateBlocked); }
}
