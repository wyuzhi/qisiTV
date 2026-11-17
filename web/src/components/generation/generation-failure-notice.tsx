import { ArrowUpRight, CheckCircle2, Copy, CopyPlus, Eye, Image as ImageIcon, Music2, Pencil, RefreshCw, Video } from "lucide-react";
import { useState } from "react";

import { CachedResourceImage } from "@/components/cached-resource-image";
import { formatGenerationDiagnostics, formatUpstreamFailureDetail, type GenerationFailureContext, type GenerationFailureExplanation } from "@/lib/generation-error";
import type { FailureBillingBadge, FailureReferenceTarget } from "@/lib/generation-failure-ux";
import { getDiagnosticTraceId } from "@/services/diagnostics/client-diagnostics";

export type FailureReferenceTargetAction = FailureReferenceTarget & {
    onLocate: () => void;
};

export type FailureNoticeAction = {
    label: string;
    onClick: () => void;
};

type GenerationFailureNoticeProps = {
    explanation: GenerationFailureExplanation;
    context?: GenerationFailureContext;
    compact?: boolean;
    onRetry?: () => void;
    retryLabel?: string;
    onOpenDetails?: () => void;
    retryDisabled?: boolean;
    summaryOnly?: boolean;
    billingBadge?: FailureBillingBadge;
    stageHint?: string;
    referenceTargets?: FailureReferenceTargetAction[];
    primaryAction?: FailureNoticeAction;
    branchAction?: FailureNoticeAction;
};

export function GenerationFailureNotice({
    explanation,
    context,
    compact,
    onRetry,
    retryLabel,
    onOpenDetails,
    retryDisabled,
    summaryOnly,
    billingBadge,
    stageHint,
    referenceTargets,
    primaryAction,
    branchAction,
}: GenerationFailureNoticeProps) {
    const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
    const diagnostics = formatGenerationDiagnostics(explanation, { ...context, traceId: context?.traceId || getDiagnosticTraceId(context?.taskId || explanation.taskId) });
    const upstreamDetail =
        summaryOnly || (compact && Boolean(onOpenDetails) && explanation.moderation)
            ? ""
            : formatUpstreamFailureDetail(explanation, context);
    const showRetry = Boolean(onRetry) && !explanation.blockManualRetry && !retryDisabled;
    const showInlineCopyDiagnostics = !summaryOnly && Boolean(diagnostics) && !(compact && Boolean(onOpenDetails));
    const retryIsPrimary = showRetry && !primaryAction && !explanation.uncertain;
    const copyDiagnostics = async () => {
        try {
            if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(diagnostics);
            } else {
                const copied = fallbackCopy(diagnostics);
                if (!copied) throw new Error("copy failed");
            }
            setCopyState("copied");
            window.setTimeout(() => setCopyState("idle"), 1600);
        } catch {
            setCopyState("failed");
            window.setTimeout(() => setCopyState("idle"), 2200);
        }
    };
    return (
        <div className={`generation-failure-notice${compact ? " is-compact" : ""}${explanation.uncertain ? " is-uncertain" : ""}`}>
            {!summaryOnly && billingBadge ? (
                <div className="generation-failure-meta">
                    <span className="generation-failure-billing-pill">
                        <CheckCircle2 className="size-3 shrink-0" aria-hidden />
                        <span>{billingBadge.label}</span>
                    </span>
                </div>
            ) : null}
            <p className="generation-failure-reason">{explanation.reason}</p>
            {!summaryOnly && explanation.action ? <p className="generation-failure-action">{explanation.action}</p> : null}
            {!summaryOnly && stageHint ? <p className="generation-failure-stage-hint">{stageHint}</p> : null}
            {!summaryOnly && referenceTargets?.length ? (
                <div className="generation-failure-ref-list">
                    {referenceTargets.map((target) => {
                        const badgeText = target.badgeLabel.replace(/^@/, "");
                        const cleanTitle = target.title.replace(/^@/, "").trim();
                        const showTitle = Boolean(cleanTitle && cleanTitle !== badgeText);
                        const kindIcon =
                            target.kind === "video" ? (
                                <Video className="size-3 shrink-0" aria-hidden />
                            ) : target.kind === "audio" ? (
                                <Music2 className="size-3 shrink-0" aria-hidden />
                            ) : (
                                <ImageIcon className="size-3 shrink-0" aria-hidden />
                            );
                            const actionVerb = target.exact === false ? "排查" : "定位";
                            return (
                            <button
                                key={target.nodeId}
                                type="button"
                                className="generation-failure-ref-chip"
                                title={target.exact === false ? `排查关联素材 @${badgeText}${showTitle ? ` · ${cleanTitle}` : ""}` : `定位到 @${badgeText}${showTitle ? ` · ${cleanTitle}` : ""}`}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    target.onLocate();
                                }}
                                onMouseDown={(event) => event.stopPropagation()}
                            >
                                <span className="generation-failure-ref-thumb" aria-hidden>
                                    {target.kind !== "audio" && (target.storageKey || target.previewUrl) ? (
                                        <CachedResourceImage
                                            storageKey={target.storageKey}
                                            src={target.previewUrl}
                                            previewSize={128}
                                            eager
                                            alt=""
                                            className="size-full object-cover"
                                            fallback={kindIcon}
                                        />
                                    ) : (
                                        kindIcon
                                    )}
                                </span>
                                <span className="generation-failure-ref-label">
                                    <span>{actionVerb} @{badgeText}</span>
                                    {showTitle ? <span className="generation-failure-ref-title"> · {cleanTitle}</span> : null}
                                </span>
                                <ArrowUpRight className="size-3 shrink-0 opacity-65" aria-hidden />
                            </button>
                        );
                    })}
                </div>
            ) : null}
            {upstreamDetail ? <p className="generation-failure-upstream">{upstreamDetail}</p> : null}
            <div className="generation-failure-actions">
                {primaryAction ? (
                    <button
                        type="button"
                        className="generation-failure-button is-primary"
                        style={{
                            background: "var(--control-check-bg)",
                            color: "var(--control-check-fg)",
                        }}
                        onClick={(event) => {
                            event.stopPropagation();
                            primaryAction.onClick();
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <Pencil className="size-3.5 shrink-0" aria-hidden />
                        {primaryAction.label}
                    </button>
                ) : null}
                {showRetry ? (
                    <button
                        type="button"
                        className={`generation-failure-button${retryIsPrimary ? " is-primary" : ""}`}
                        style={
                            retryIsPrimary
                                ? {
                                      background: "var(--control-check-bg)",
                                      color: "var(--control-check-fg)",
                                  }
                                : undefined
                        }
                        onClick={(event) => {
                            event.stopPropagation();
                            onRetry?.();
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <RefreshCw className="size-3.5 shrink-0" aria-hidden />
                        {retryLabel || "重新生成"}
                    </button>
                ) : null}
                {branchAction ? (
                    <button
                        type="button"
                        className="generation-failure-button"
                        onClick={(event) => {
                            event.stopPropagation();
                            branchAction.onClick();
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <CopyPlus className="size-3.5 shrink-0" aria-hidden />
                        {branchAction.label}
                    </button>
                ) : null}
                {onOpenDetails ? (
                    <button
                        type="button"
                        className="generation-failure-button"
                        onClick={(event) => {
                            event.stopPropagation();
                            onOpenDetails();
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <Eye className="size-3.5 shrink-0" aria-hidden />
                        {explanation.uncertain ? "查看原任务" : "查看详情"}
                    </button>
                ) : null}
                {showInlineCopyDiagnostics ? (
                    <button
                        type="button"
                        className="generation-failure-button"
                        onClick={(event) => {
                            event.stopPropagation();
                            void copyDiagnostics();
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <Copy className="size-3.5 shrink-0" aria-hidden />
                        {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制排查信息"}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

function fallbackCopy(value: string) {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
}
