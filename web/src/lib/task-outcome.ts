export type TaskOutcomePhase = "running" | "fetching" | "ready" | "retrievable" | "failed";

export type TaskOutcomeRegenerate = "allowed" | "confirm" | "blocked";

export type TaskOutcome = {
    phase: TaskOutcomePhase;
    regenerate: TaskOutcomeRegenerate;
    reason: string;
    reconcileDeadline?: string;
};

export type TaskOutcomeCopy = {
    badge: string;
    reason: string;
    action: string;
    message: string;
    confirmTitle?: string;
    confirmContent?: string;
};

export type TaskOutcomeSource = {
    outcome?: TaskOutcome | null;
    status?: string;
    stage?: string;
    errorCode?: string;
    error?: string;
    providerRequestId?: string;
    outputs?: Array<{
        materializedAssetId?: string;
        materializationErrorCode?: string;
    }>;
};

export type CanvasNodeOutcomeMetadata = {
    taskOutcome?: TaskOutcome | null;
    taskId?: string;
    taskClientOperationId?: string;
    generationSubmissionState?: string;
    taskStatus?: string;
    taskStage?: string;
    status?: string;
    content?: string;
    storageKey?: string;
    generationErrorCode?: string;
    errorDetails?: string;
    batchRootId?: string;
    batchChildIds?: string[];
    generatedFromNodeId?: string;
};

const VALID_PHASES = new Set<TaskOutcomePhase>(["running", "fetching", "ready", "retrievable", "failed"]);
const VALID_REGENERATE = new Set<TaskOutcomeRegenerate>(["allowed", "confirm", "blocked"]);

const LEGACY_RETRIEVABLE_ERROR_CODES = new Set([
    "canvas_conflict",
    "download_failed",
    "result_apply_failed",
    "delivery_failed",
    "submission_uncertain",
    "results_missing",
]);

const LEGACY_INPUT_REJECTED_ERROR_CODES = new Set([
    "moderation_input",
    "moderation_reference",
    "moderation_output",
    "invalid_params",
    "context_too_long",
    "input_inaccessible",
    "input_too_large",
    "content_policy_violation",
    "sensitive_words_detected",
]);

export function isTaskOutcomePhase(value: unknown): value is TaskOutcomePhase {
    return typeof value === "string" && VALID_PHASES.has(value as TaskOutcomePhase);
}

export function isTaskOutcomeRegenerate(value: unknown): value is TaskOutcomeRegenerate {
    return typeof value === "string" && VALID_REGENERATE.has(value as TaskOutcomeRegenerate);
}

export function normalizeTaskOutcome(value: unknown): TaskOutcome | undefined {
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as Record<string, unknown>;
    if (!isTaskOutcomePhase(candidate.phase) || !isTaskOutcomeRegenerate(candidate.regenerate)) {
        return undefined;
    }
    const reason = typeof candidate.reason === "string" && candidate.reason.trim() ? candidate.reason.trim() : defaultReasonForPhase(candidate.phase);
    const reconcileDeadline = typeof candidate.reconcileDeadline === "string" && candidate.reconcileDeadline.trim() ? candidate.reconcileDeadline.trim() : undefined;
    return reconcileDeadline
        ? { phase: candidate.phase, regenerate: candidate.regenerate, reason, reconcileDeadline }
        : { phase: candidate.phase, regenerate: candidate.regenerate, reason };
}

function defaultReasonForPhase(phase: TaskOutcomePhase): string {
    switch (phase) {
        case "running":
            return "task_running";
        case "fetching":
            return "result_fetching";
        case "ready":
            return "result_ready";
        case "retrievable":
            return "delivery_pending";
        case "failed":
            return "task_failed";
    }
}

/**
 * 读取任务的 `outcome`。
 * 一旦 `outcome` 存在，完全以 `outcome` 为准，绝不参考 `status`、`stage`、`errorCode` 或错误文案。
 * 仅在历史数据尚未携带 `outcome` 时提供最小回退。
 */
export function readTaskOutcome(source?: TaskOutcome | TaskOutcomeSource | null): TaskOutcome | undefined {
    if (!source) return undefined;
    const direct = normalizeTaskOutcome(source);
    if (direct) return direct;
    const record = source as TaskOutcomeSource;
    const embedded = normalizeTaskOutcome(record.outcome);
    if (embedded) return embedded;

    const status = typeof record.status === "string" ? record.status.trim() : "";
    const stage = typeof record.stage === "string" ? record.stage.trim() : "";
    const errorCode = typeof record.errorCode === "string" ? record.errorCode.trim() : "";

    if (status === "queued" || status === "running") {
        if (stage === "正在取回生成结果") {
            return { phase: "fetching", regenerate: "blocked", reason: "result_fetching" };
        }
        return { phase: "running", regenerate: "blocked", reason: "task_running" };
    }
    if (status === "succeeded") {
        const outputs = Array.isArray(record.outputs) ? record.outputs : [];
        const allMaterialized = outputs.length > 0 && outputs.every((item) => Boolean(item?.materializedAssetId?.trim()));
        const pausedOutput = outputs.some((item) => item?.materializationErrorCode === "delivery_paused" || item?.materializationErrorCode === "delivery_timed_out");
        if (!allMaterialized && (stage === "delivery_paused" || stage === "delivery_timed_out" || pausedOutput)) {
            return { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" };
        }
        return { phase: "ready", regenerate: "allowed", reason: "result_ready" };
    }
    if (status === "failed" || status === "cancelled" || errorCode || record.error) {
        if (errorCode === "result_target_unavailable") {
            return { phase: "failed", regenerate: "blocked", reason: "result_target_unavailable" };
        }
        if (stage === "submission_unknown") {
            return { phase: "retrievable", regenerate: "blocked", reason: "submission_unknown" };
        }
        if (stage === "delivery_paused" || stage === "delivery_timed_out" || LEGACY_RETRIEVABLE_ERROR_CODES.has(errorCode)) {
            return { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" };
        }
        if (LEGACY_INPUT_REJECTED_ERROR_CODES.has(errorCode)) {
            return { phase: "failed", regenerate: "confirm", reason: "input_rejected" };
        }
        // 与后端 ComputeOutcome 一致：已有上游任务号的失败任务先免费查询原任务。
        if (status === "failed" && typeof record.providerRequestId === "string" && record.providerRequestId.trim()) {
            return { phase: "retrievable", regenerate: "blocked", reason: "provider_result_pending" };
        }
        if (errorCode === "request_not_sent" || status === "cancelled") {
            return { phase: "failed", regenerate: "allowed", reason: "not_charged" };
        }
        return { phase: "failed", regenerate: "allowed", reason: "task_failed" };
    }
    return undefined;
}

/**
 * 读取画布节点的 `taskOutcome`。
 * 一旦 `metadata.taskOutcome` 存在，完全以 `taskOutcome` 为准，绝不参考 `taskStatus`、`taskStage`、`generationErrorCode` 或错误文案。
 * 仅在首次向后端查询前的遗留节点缺少 `taskOutcome` 时提供最小回退。
 */
export function readNodeTaskOutcome(metadata?: CanvasNodeOutcomeMetadata | null): TaskOutcome | undefined {
    if (!metadata) return undefined;
    const explicit = normalizeTaskOutcome(metadata.taskOutcome);
    if (explicit) return explicit;

    if (metadata.generationSubmissionState === "unknown" || metadata.taskStage === "submission_unknown") {
        return { phase: "retrievable", regenerate: "blocked", reason: "submission_unknown" };
    }
    if (metadata.status === "success" && Boolean(metadata.content || metadata.storageKey)) {
        return { phase: "ready", regenerate: "allowed", reason: "result_ready" };
    }
    if (metadata.status === "loading" || metadata.taskStatus === "queued" || metadata.taskStatus === "running") {
        if (metadata.taskStatus === "succeeded" || metadata.taskStage === "正在取回生成结果") {
            return { phase: "fetching", regenerate: "blocked", reason: "result_fetching" };
        }
        return { phase: "running", regenerate: "blocked", reason: "task_running" };
    }
    const errorCode = typeof metadata.generationErrorCode === "string" ? metadata.generationErrorCode.trim() : "";
    if (metadata.status === "error" || metadata.taskStatus === "failed" || metadata.taskStatus === "cancelled" || errorCode || metadata.errorDetails) {
        if (errorCode === "result_target_unavailable") {
            return { phase: "failed", regenerate: "blocked", reason: "result_target_unavailable" };
        }
        if (LEGACY_RETRIEVABLE_ERROR_CODES.has(errorCode)) {
            return { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" };
        }
        if (LEGACY_INPUT_REJECTED_ERROR_CODES.has(errorCode)) {
            return { phase: "failed", regenerate: "confirm", reason: "input_rejected" };
        }
        if (errorCode === "request_not_sent" || metadata.taskStatus === "cancelled") {
            return { phase: "failed", regenerate: "allowed", reason: "not_charged" };
        }
        return { phase: "failed", regenerate: "allowed", reason: "task_failed" };
    }
    if (metadata.taskStatus === "succeeded") {
        return { phase: "fetching", regenerate: "blocked", reason: "result_fetching" };
    }
    return undefined;
}

export function isTaskOutcomeWorking(outcome?: TaskOutcome | null): boolean {
    if (!outcome) return false;
    return outcome.phase === "running" || outcome.phase === "fetching" || outcome.phase === "retrievable";
}

export function isTaskOutcomeRunningOrFetching(outcome?: TaskOutcome | null): boolean {
    if (!outcome) return false;
    return outcome.phase === "running" || outcome.phase === "fetching";
}

export function isTaskOutcomeRetrievable(outcome?: TaskOutcome | null): boolean {
    return outcome?.phase === "retrievable";
}

export function isTaskOutcomeReady(outcome?: TaskOutcome | null): boolean {
    return outcome?.phase === "ready";
}

export function isTaskOutcomeFailed(outcome?: TaskOutcome | null): boolean {
    return outcome?.phase === "failed";
}

export function isRegenerateBlocked(outcome?: TaskOutcome | null): boolean {
    if (!outcome) return false;
    if (outcome.regenerate === "blocked") return true;
    return outcome.phase === "running" || outcome.phase === "fetching" || outcome.phase === "retrievable";
}

export function isRegenerateConfirm(outcome?: TaskOutcome | null): boolean {
    if (!outcome || isRegenerateBlocked(outcome)) return false;
    return outcome.regenerate === "confirm";
}

export function isRegenerateAllowed(outcome?: TaskOutcome | null): boolean {
    if (!outcome || isRegenerateBlocked(outcome)) return false;
    return outcome.regenerate === "allowed";
}

export function canRegenerateTaskOutcome(outcome?: TaskOutcome | null): boolean {
    if (!outcome || isRegenerateBlocked(outcome)) return false;
    return outcome.regenerate === "allowed" || outcome.regenerate === "confirm";
}

export function canRecoverTaskOutcome(outcome?: TaskOutcome | null): boolean {
    return outcome?.phase === "retrievable";
}

export function isTaskRegenerateBlocked(source?: TaskOutcome | TaskOutcomeSource | null): boolean {
    return isRegenerateBlocked(readTaskOutcome(source));
}

export function isNodeRegenerateBlocked(metadata?: CanvasNodeOutcomeMetadata | null): boolean {
    return isRegenerateBlocked(readNodeTaskOutcome(metadata));
}

export function isNodeRegenerateConfirm(metadata?: CanvasNodeOutcomeMetadata | null): boolean {
    return isRegenerateConfirm(readNodeTaskOutcome(metadata));
}

function extractNodeMetadata(target?: { metadata?: CanvasNodeOutcomeMetadata | null } | CanvasNodeOutcomeMetadata | null): CanvasNodeOutcomeMetadata | undefined {
    if (!target) return undefined;
    if ("metadata" in target && target.metadata && typeof target.metadata === "object") {
        return target.metadata;
    }
    return target as CanvasNodeOutcomeMetadata;
}

/**
 * 判断节点是否允许走免费取回（`/recover` 或重新落盘）。
 * 批量图子节点不再暴露手动“继续取回”按钮。
 */
export function canReloadCanvasNodeResource(target?: { metadata?: CanvasNodeOutcomeMetadata | null } | CanvasNodeOutcomeMetadata | null): boolean {
    const metadata = extractNodeMetadata(target);
    if (!metadata || metadata.batchRootId) return false;
    if (!metadata.taskId) return false;
    const outcome = readNodeTaskOutcome(metadata);
    if (!outcome) return false;
    if (normalizeTaskOutcome(metadata.taskOutcome)) {
        return outcome.phase === "retrievable";
    }
    if (metadata.generationErrorCode === "result_target_unavailable") return false;
    return outcome.phase === "retrievable";
}

/**
 * 判断节点或其批量子节点是否存在待取回的结果（`outcome.phase === "retrievable"` 或结果已保存在历史但目标节点不可用）。
 */
export function canvasNodeHasPendingOutcomeResult(
    node?: { id: string; metadata?: CanvasNodeOutcomeMetadata | null } | null,
    allNodes: Array<{ id: string; metadata?: CanvasNodeOutcomeMetadata | null }> = [],
): boolean {
    if (!node) return false;
    const childIds = new Set(node.metadata?.batchChildIds || []);
    const related = allNodes.filter((item) => childIds.has(item.id) || item.metadata?.generatedFromNodeId === node.id);
    const targets = related.length ? [node, ...related] : [node];
    return targets.some((target) => {
        const outcome = readNodeTaskOutcome(target.metadata);
        return outcome?.phase === "retrievable" || outcome?.reason === "result_target_unavailable";
    });
}

function formatClockTime(timestampMs: number): string {
    const date = new Date(timestampMs);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
}

export function formatReconcileDeadlineCopy(reconcileDeadline?: string, nowMs = Date.now()): string {
    if (!reconcileDeadline?.trim()) {
        return "BeefTV 正在核对上次提交，请稍候";
    }
    const deadlineMs = Date.parse(reconcileDeadline);
    if (Number.isNaN(deadlineMs)) {
        return "BeefTV 正在核对上次提交，请稍候";
    }
    if (deadlineMs <= nowMs) {
        return "BeefTV 正在核对，已超过预计时间，可联系客服";
    }
    return `BeefTV 正在核对上次提交，预计 ${formatClockTime(deadlineMs)} 前有结论`;
}

/**
 * 根据 `TaskOutcome` 生成面向用户的中文状态、提示与确认弹窗文案。
 * 严格遵守不泄露上游平台内部名（如 BeefAPI）、渠道 ID 或内部字段名。
 */
export function taskOutcomeCopy(outcome?: TaskOutcome | null, nowMs = Date.now()): TaskOutcomeCopy {
    if (!outcome) {
        return {
            badge: "生成失败",
            reason: "上次生成未完成，可以直接重新生成",
            action: "可以直接重新生成",
            message: "上次生成未完成，可以直接重新生成。",
        };
    }

    if (outcome.reason === "settlement_pending" || outcome.reason === "billing_pending" || outcome.reason === "reconcile_pending") {
        const reason = formatReconcileDeadlineCopy(outcome.reconcileDeadline, nowMs);
        const action = "核对完成前请勿重新生成";
        return {
            badge: "正在核对",
            reason,
            action,
            message: `${reason}。${action}。`,
        };
    }

    switch (outcome.phase) {
        case "running": {
            const reason = "任务正在生成中";
            const action = "请等待当前任务完成";
            return {
                badge: "生成中",
                reason,
                action,
                message: `${reason}，${action}。`,
            };
        }
        case "fetching": {
            const reason = "生成已完成，正在取回结果";
            const action = "系统正在自动保存，无需重新生成";
            return {
                badge: "正在取回结果",
                reason,
                action,
                message: `${reason}，${action}。`,
            };
        }
        case "ready": {
            const reason = "生成结果已就绪";
            const action = "可直接查看或重新生成新版本";
            return {
                badge: "已完成",
                reason,
                action,
                message: `${reason}，${action}。`,
            };
        }
        case "retrievable": {
            let reason = "上次生成结果已保留，系统正在自动取回";
            if (outcome.reason === "image_recovery_pending") {
                reason = "正在查询并取回上次生成的图片结果";
            } else if (outcome.reason === "provider_result_pending") {
                reason = "上次任务仍在处理，系统正在自动取回结果";
            } else if (outcome.reason === "evidence_unavailable") {
                reason = "正在核实并取回上次生成结果";
            }
            const action = "请等待取回完成，不要重复生成";
            return {
                badge: "正在取回结果",
                reason,
                action,
                message: `${reason}，${action}。`,
            };
        }
        case "failed": {
            if (outcome.regenerate === "blocked") {
                if (outcome.reason === "result_target_unavailable") {
                    const reason = "生成结果已保存在生成历史，当前目标节点已变更";
                    const action = "请从生成历史查看结果，请勿重复生成";
                    return {
                        badge: "结果已保存",
                        reason,
                        action,
                        message: `${reason}。${action}。`,
                    };
                }
                const reason = outcome.reconcileDeadline
                    ? formatReconcileDeadlineCopy(outcome.reconcileDeadline, nowMs)
                    : "BeefTV 正在核对上次提交，请稍候";
                const action = "核对完成前请勿重新生成";
                return {
                    badge: "正在核对",
                    reason,
                    action,
                    message: `${reason}。${action}。`,
                };
            }
            if (outcome.regenerate === "confirm") {
                if (outcome.reason === "charged_result_unrecoverable") {
                    const reason = "上次已扣费，但结果拿不回，重新生成会再扣一次";
                    const action = "确认后将创建新任务重新生成";
                    return {
                        badge: "结果无法取回",
                        reason,
                        action,
                        message: `${reason}。${action}。`,
                        confirmTitle: "确认重新生成？",
                        confirmContent: "上次已扣费，但结果拿不回，重新生成会再扣一次。",
                    };
                }
                if (outcome.reason === "input_rejected") {
                    const reason = "提示词、参考素材或参数未通过校验";
                    const action = "请调整输入后重新生成；继续提交可能会再次产生费用";
                    return {
                        badge: "需调整输入",
                        reason,
                        action,
                        message: `${reason}。${action}。`,
                        confirmTitle: "确认重新生成？",
                        confirmContent: "上次输入未通过校验，重新生成可能会再扣一次。建议先修改提示词或参考素材。",
                    };
                }
                if (outcome.reason === "result_unrecoverable") {
                    const reason = "无法确认上次是否已扣费，可先到模型服务后台查看使用记录";
                    const action = "重新生成可能会再扣一次，确认后创建新任务";
                    return {
                        badge: "结果无法取回",
                        reason,
                        action,
                        message: `${reason}。${action}。`,
                        confirmTitle: "确认重新生成？",
                        confirmContent: "无法确认上次是否已扣费，可先到模型服务后台查看使用记录。重新生成可能会再扣一次。",
                    };
                }
                const reason = "这个渠道无法确认上次是否已扣费，重新生成可能会再扣一次";
                const action = "确认后可重新生成";
                return {
                    badge: "生成未完成",
                    reason,
                    action,
                    message: `${reason}。${action}。`,
                    confirmTitle: "确认重新生成？",
                    confirmContent: "这个渠道无法确认上次是否已扣费，重新生成可能会再扣一次。",
                };
            }
            // regenerate === "allowed"
            let reason = "上次生成未完成，可以直接重新生成";
            if (outcome.reason === "refunded") {
                reason = "上次生成未完成，费用已退回，可以直接重新生成";
            } else if (outcome.reason === "not_charged" || outcome.reason === "request_not_sent") {
                reason = "上次请求未扣费，可以直接重新生成";
            }
            const action = "可以直接重新生成";
            return {
                badge: "生成失败",
                reason,
                action,
                message: `${reason}。`,
            };
        }
    }
}
