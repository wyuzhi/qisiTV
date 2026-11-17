import { Download } from "lucide-react";
import { useContext, useMemo } from "react";

import { GenerationFailureNotice, type FailureReferenceTargetAction } from "@/components/generation/generation-failure-notice";
import { canRecoverManagedToolNode, isVideoSubtitleEraseNode } from "@/lib/canvas/canvas-ai-upscale-task";
import { canRecoverOrRetryDepthCapture } from "@/lib/canvas/canvas-depth-capture";
import { applyPrimaryImageHistoryItem, resolveCanvasNodeImageHistory } from "@/lib/canvas/canvas-image-history";
import { authoritativeNodeOutcome } from "@/lib/canvas/canvas-node-failure-state";
import { canvasNodeFailureView } from "@/lib/canvas/canvas-node-failure-view";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { formatUpstreamFailureDetail } from "@/lib/generation-error";
import { matchFailureReferenceTargets } from "@/lib/canvas/canvas-generation-failure-ux";
import {
    isCreativeInputFailureCategory,
    resolveFailureBillingBadge,
    resolveModerationStageHint,
} from "@/lib/generation-failure-ux";
import { canvasNodeDiagnosticContext } from "@/services/diagnostics/canvas-media-diagnostics";
import { useAssetStore } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useCanvasNodeActions } from "./canvas-node-action-context";
import { CanvasNodeGraphContext } from "./canvas-node-graph-context";
import { CanvasHistoryRestoreAction } from "./canvas-node-history-stack";

export type CanvasNodeErrorContentProps = {
    node: CanvasNodeData;
    theme: CanvasTheme;
    readOnly?: boolean;
    mentionReferences?: CanvasResourceReference[];
    onRetry?: (node: CanvasNodeData) => void;
    onReloadResource?: (node: CanvasNodeData) => void;
    onOpenTaskDetails?: (node: CanvasNodeData) => void;
};

const EMPTY_NODES: CanvasNodeData[] = [];
const EMPTY_REFERENCES: CanvasResourceReference[] = [];

export function CanvasNodeErrorContent({
    node,
    theme,
    readOnly = false,
    mentionReferences = EMPTY_REFERENCES,
    onRetry,
    onReloadResource,
    onOpenTaskDetails,
}: CanvasNodeErrorContentProps) {
    const { updateNode, restorePreviousHistoryImage, duplicate, focusNode, editGenerationInput, canEditGenerationInput } = useCanvasNodeActions();
    const { getUpstreamNodes, getNode } = useContext(CanvasNodeGraphContext);
    const failureView = canvasNodeFailureView(node);
    const explanation = failureView.explanation;
    const batchChild = Boolean(node.metadata?.batchRootId);
    const localDepthAction = canRecoverOrRetryDepthCapture(node);
    const subtitleEraseNode = isVideoSubtitleEraseNode(node);
    const managedToolAction = Boolean(node.metadata?.workflowOperation?.id.endsWith(".ai-upscale") || subtitleEraseNode);
    const managedToolQueryOnly = canRecoverManagedToolNode(node);
    const canReload = !readOnly && failureView.canReload;
    const retryBlocked = managedToolQueryOnly ? false : failureView.retryBlocked;
    const submissionUncertain = failureView.cardSubmissionUncertain;

    const diagnosticContext = useMemo(
        () => ({
            ...canvasNodeDiagnosticContext(node),
            model: node.metadata?.model,
            createdAt: node.metadata?.taskCreatedAt,
            stage: node.metadata?.taskStage,
            providerRequestId: node.metadata?.taskProviderRequestId,
            failureDiagnostics: node.metadata?.taskFailureDiagnostics,
            errorSummary: node.metadata?.generationErrorSummary,
            providerCode: node.metadata?.generationProviderCode,
            completedAt: node.metadata?.taskCompletedAt,
            updatedAt: node.metadata?.taskUpdatedAt,
        }),
        [node],
    );

    const directUpstream = getUpstreamNodes?.(node.id) ?? EMPTY_NODES;
    const originId = node.metadata?.generatedFromNodeId;
    const originNode = originId ? getNode?.(originId) : undefined;
    const originUpstream = originId && originId !== node.id ? getUpstreamNodes?.(originId) ?? EMPTY_NODES : EMPTY_NODES;
    const candidateUpstream = useMemo(() => {
        const list = [...directUpstream, ...originUpstream];
        if (
            originNode &&
            (originNode.type === CanvasNodeType.Image || originNode.type === CanvasNodeType.Video || originNode.type === CanvasNodeType.Audio) &&
            !list.some((item) => item.id === originNode.id)
        ) {
            list.push(originNode);
        }
        return list;
    }, [directUpstream, originNode, originUpstream]);

    const billingBadge = useMemo(
        () =>
            resolveFailureBillingBadge({
                explanation,
                outcome: authoritativeNodeOutcome(node.metadata),
                taskId: node.metadata?.taskId,
                isLocalTool: localDepthAction || managedToolAction,
            }),
        [explanation, localDepthAction, managedToolAction, node.metadata],
    );

    const stageHint = useMemo(() => resolveModerationStageHint(explanation), [explanation]);

    const upstreamDetail = useMemo(
        () => (batchChild ? "" : formatUpstreamFailureDetail(explanation, diagnosticContext)),
        [batchChild, diagnosticContext, explanation],
    );

    const referenceTargets = useMemo<FailureReferenceTargetAction[] | undefined>(() => {
        if (batchChild || submissionUncertain || !focusNode) return undefined;
        const matched = matchFailureReferenceTargets({
            explanation,
            upstreamDetail,
            mentionReferences,
            upstreamNodes: candidateUpstream,
        });
        if (!matched.length) return undefined;
        return matched.map((target) => ({
            ...target,
            onLocate: () => focusNode(target.nodeId),
        }));
    }, [batchChild, candidateUpstream, explanation, focusNode, mentionReferences, submissionUncertain, upstreamDetail]);

    const canOfferInputActions =
        !readOnly &&
        !batchChild &&
        !canReload &&
        !submissionUncertain &&
        !localDepthAction &&
        !managedToolAction &&
        isCreativeInputFailureCategory(explanation.category);

    const canEditPrompt = canEditGenerationInput ? canEditGenerationInput(node) : true;
    const primaryAction = canOfferInputActions && editGenerationInput && canEditPrompt
        ? { label: "修改提示词", onClick: () => editGenerationInput(node) }
        : undefined;
    const branchAction = canOfferInputActions && duplicate
        ? { label: "复制分支", onClick: () => duplicate(node) }
        : undefined;

    return (
        <div
            data-canvas-no-zoom
            data-canvas-wheel-scroll
            data-canvas-live-scale
            className="canvas-node-error-content flex max-w-[320px] flex-col items-center gap-2 overflow-y-auto px-3 pb-3 pt-7 text-center"
            style={{
                boxSizing: "border-box",
                width: `min(320px, calc(${Math.max(1, node.width)}px * var(--canvas-live-scale, 1)))`,
                maxHeight: `calc(${Math.max(1, node.height)}px * var(--canvas-live-scale, 1))`,
                transform: "scale(var(--canvas-live-inverse-scale, 1))",
                transformOrigin: "center center",
            }}
        >
            <div className="w-full" style={{ color: theme.node.text }}>
                <GenerationFailureNotice
                    compact
                    summaryOnly={batchChild}
                    explanation={explanation}
                    context={diagnosticContext}
                    billingBadge={billingBadge}
                    stageHint={stageHint}
                    referenceTargets={referenceTargets}
                    primaryAction={primaryAction}
                    branchAction={branchAction}
                    onOpenDetails={node.metadata?.taskId && onOpenTaskDetails ? () => onOpenTaskDetails(node) : undefined}
                    retryDisabled={retryBlocked}
                    onRetry={!readOnly && !retryBlocked && onRetry ? () => onRetry(node) : undefined}
                    retryLabel={
                        failureView.recoveryRoute === "history"
                            ? "生成历史"
                            : managedToolQueryOnly
                              ? "取回原结果"
                              : managedToolAction
                                ? subtitleEraseNode
                                    ? "重新配置"
                                    : "重试未提交项"
                                : localDepthAction && node.metadata?.taskStatus === "succeeded"
                                  ? "恢复结果"
                                  : node.metadata?.isBatchRoot
                                    ? "重新生成失败项"
                                    : "重新生成"
                    }
                />
            </div>
            {canReload ? (
                <button
                    type="button"
                    className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-md)] px-3 text-xs font-medium transition-colors"
                    style={{ background: theme.accent.primary, color: theme.accent.onPrimary }}
                    onClick={(event) => {
                        event.stopPropagation();
                        onReloadResource?.(node);
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    <Download className="size-3.5" />
                    继续取回
                </button>
            ) : !readOnly ? (
                <CanvasHistoryRestoreAction
                    node={node}
                    theme={theme}
                    onRestore={
                        restorePreviousHistoryImage
                            ? (target) => {
                                  void restorePreviousHistoryImage(target.id);
                              }
                            : updateNode
                              ? (target) =>
                                    updateNode(target.id, (current) => {
                                        const list = resolveCanvasNodeImageHistory(current);
                                        const latest = list[list.length - 1];
                                        return latest ? applyPrimaryImageHistoryItem(current, latest, useAssetStore.getState().assets) : current;
                                    })
                              : undefined
                    }
                />
            ) : null}
        </div>
    );
}
