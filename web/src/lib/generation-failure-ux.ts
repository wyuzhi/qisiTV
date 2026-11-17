import {
    INPUT_REJECTED_ERROR_CATEGORIES,
    type GenerationErrorCategory,
    type GenerationFailureExplanation,
} from "@/lib/generation-error";
import { isRegenerateBlocked, isRegenerateConfirm, taskOutcomeCopy, type TaskOutcome } from "@/lib/task-outcome";

export type FailureBillingBadge = {
    label: string;
    tone: "safe";
};

export type FailureReferenceTarget = {
    nodeId: string;
    kind: "image" | "video" | "audio";
    badgeLabel: string;
    title: string;
    previewUrl?: string;
    storageKey?: string;
    exact?: boolean;
};

type BillingBadgeInput = {
    explanation: GenerationFailureExplanation;
    outcome?: TaskOutcome;
    taskId?: string;
    isLocalTool?: boolean;
};

const CONFIRM_UNCHANGED_MODERATION_CATEGORIES: ReadonlySet<GenerationErrorCategory> = new Set([
    "moderation_input",
    "moderation_reference",
]);

const LOCAL_UNSENT_CATEGORIES: ReadonlySet<GenerationErrorCategory> = new Set([
    "request_not_sent",
    "local_storage",
    "local_disk_full",
    "local_credential",
]);

export function isCreativeInputFailureCategory(category: GenerationErrorCategory): boolean {
    return INPUT_REJECTED_ERROR_CATEGORIES.has(category);
}

export function shouldConfirmUnchangedModerationRetry(category: GenerationErrorCategory): boolean {
    return CONFIRM_UNCHANGED_MODERATION_CATEGORIES.has(category);
}

type UnchangedModerationConfirmOptions = {
    onEditInput?: () => void;
    costWarning?: string;
};

export function buildUnchangedModerationConfirmDialog({
    onEditInput,
    costWarning,
}: UnchangedModerationConfirmOptions = {}) {
    const baseContent =
        "上次因提示词或参考素材未通过审核被拦截，未修改直接重试大概率仍会失败。建议先修改提示词或更换问题素材。";
    const extraWarning = costWarning?.trim();
    return {
        title: "输入尚未修改，确认直接重试？",
        content: extraWarning ? `${baseContent}\n\n${extraWarning}` : baseContent,
        okText: "仍要重试",
        cancelText: onEditInput ? "去修改输入" : "取消",
        centered: true,
    };
}

type ConfirmCreationRetryOptions = {
    category: GenerationErrorCategory;
    outcome?: TaskOutcome;
    modalConfirm?: (config: {
        title?: string;
        content?: string;
        okText?: string;
        cancelText?: string;
        centered?: boolean;
        onOk?: () => void;
        onCancel?: () => void;
        afterClose?: () => void;
    }) => unknown;
    onEditDraft?: () => void;
};

export function confirmCreationRetryIfNeeded({
    category,
    outcome,
    modalConfirm,
    onEditDraft,
}: ConfirmCreationRetryOptions): Promise<boolean> {
    if (isRegenerateBlocked(outcome)) return Promise.resolve(false);
    const unchangedModeration = shouldConfirmUnchangedModerationRetry(category);
    const needsOutcomeConfirm = isRegenerateConfirm(outcome);
    if ((!unchangedModeration && !needsOutcomeConfirm) || !modalConfirm) {
        return Promise.resolve(true);
    }
    const copy = taskOutcomeCopy(outcome);
    const costWarning = needsOutcomeConfirm ? copy.confirmContent || copy.message : undefined;
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (accepted: boolean) => {
            if (settled) return;
            settled = true;
            resolve(accepted);
        };
        const dialogConfig = unchangedModeration
            ? buildUnchangedModerationConfirmDialog({ onEditInput: onEditDraft, costWarning })
            : {
                  title: copy.confirmTitle || "确认重新生成？",
                  content: copy.confirmContent || copy.message,
                  okText: "确认重新生成",
                  cancelText: "取消",
                  centered: true,
              };
        modalConfirm({
            ...dialogConfig,
            onOk: () => finish(true),
            onCancel: () => {
                if (!settled && unchangedModeration) onEditDraft?.();
                finish(false);
            },
            afterClose: () => finish(false),
        });
    });
}

export function resolveFailureBillingBadge({
    explanation,
    outcome,
    taskId,
    isLocalTool = false,
}: BillingBadgeInput): FailureBillingBadge | undefined {
    if (isLocalTool) return undefined;
    const hasTask = Boolean(taskId?.trim() || explanation.taskId?.trim());
    if (outcome) {
        if (outcome.phase !== "failed" || outcome.regenerate !== "allowed") return undefined;
        if (
            outcome.reason === "request_not_sent" ||
            outcome.reason === "not_charged" ||
            explanation.category === "request_not_sent" ||
            !hasTask
        ) {
            return { label: "本次未扣费", tone: "safe" };
        }
        return { label: "未扣费 · 已自动退回", tone: "safe" };
    }
    if (!hasTask && LOCAL_UNSENT_CATEGORIES.has(explanation.category)) {
        return { label: "本次未扣费", tone: "safe" };
    }
    return undefined;
}

export function resolveModerationStageHint(explanation: GenerationFailureExplanation): string | undefined {
    if (explanation.category === "moderation_output") {
        return "已通过前置检查，仅成片画面触发审核；微调描述或直接重试即可";
    }
    return undefined;
}
