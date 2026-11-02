import { afterEach, describe, expect, test } from "bun:test";

import { canvasNodeFailureView, type CanvasNodeFailureView } from "@/lib/canvas/canvas-node-failure-view";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import { persistCanvasNodeFailure } from "@/lib/canvas/canvas-node-failure-state";

/**
 * 这些期望值是在 d3b3d773 上跑原来的判断函数得到的，不是手写推断。
 * 时钟钉在 2026-04-20T06:00:00.000Z。测试进程时区是 UTC，所以截止时间显示 06:15。
 */
const NOW_MS = Date.parse("2026-04-20T06:00:00.000Z");
const FUTURE_DEADLINE = new Date(NOW_MS + 15 * 60_000).toISOString();
const realNow = Date.now;

const RETRIEVABLE = ["canvas_conflict", "download_failed", "result_apply_failed", "delivery_failed", "submission_uncertain", "results_missing"] as const;
const INPUT_REJECTED = ["moderation_input", "moderation_reference", "moderation_output", "invalid_params", "context_too_long", "input_inaccessible", "input_too_large", "content_policy_violation", "sensitive_words_detected"] as const;

type Fixture = { name: string; node: CanvasNodeData; allNodes?: CanvasNodeData[] };

function node(name: string, metadata: CanvasNodeMetadata, type: CanvasNodeData["type"] = CanvasNodeType.Image): CanvasNodeData {
    return { id: name, type, title: name, position: { x: 0, y: 0 }, width: 320, height: 180, metadata };
}

function fixtures(): Fixture[] {
    const list: Fixture[] = [];
    const add = (name: string, metadata: CanvasNodeMetadata, type?: CanvasNodeData["type"]) => {
        list.push({ name, node: node(name, metadata, type) });
    };
    add("running-task", { status: "loading", taskStatus: "running", taskId: "task-running" });
    add("succeeded-with-content", { status: "success", taskStatus: "succeeded", content: "image:ok", taskId: "task-ready" });
    add("succeeded-without-content", { status: "success", taskStatus: "succeeded", taskId: "task-fetch" });
    add("submission-unknown-state", { generationSubmissionState: "unknown", status: "error", taskId: "task-sub" });
    add("submission-unknown-stage", { taskStage: "submission_unknown", status: "error", taskId: "task-stage" });
    for (const code of RETRIEVABLE) add(`legacy-retrievable-${code}`, { status: "error", generationErrorCode: code, errorDetails: "opaque", taskId: "task-legacy" });
    for (const code of INPUT_REJECTED) add(`legacy-input-${code}`, { status: "error", generationErrorCode: code, errorDetails: "opaque", taskId: "task-input" });
    add("request-not-sent", { status: "error", generationErrorCode: "request_not_sent", errorDetails: "未能连接服务", taskId: "task-not-sent" });
    add("cancelled", { status: "error", taskStatus: "cancelled", errorDetails: "任务已取消", taskId: "task-cancel" });
    add("text-auth", { status: "error", errorDetails: "invalid api key" });
    add("text-throttled", { status: "error", errorDetails: "too many requests" });
    add("text-network", { status: "error", errorDetails: "Failed to fetch" });
    add("target-unavailable-with-task", { status: "error", generationErrorCode: "result_target_unavailable", errorDetails: "生成结果已保存，无法放回原节点", taskId: "task-target" });
    add("target-unavailable-without-task", { status: "error", generationErrorCode: "result_target_unavailable", errorDetails: "生成结果已保存，无法放回原节点" });
    const explicit = [
        ["explicit-running", { phase: "running", regenerate: "blocked", reason: "task_running" }],
        ["explicit-fetching", { phase: "fetching", regenerate: "blocked", reason: "result_fetching" }],
        ["explicit-ready", { phase: "ready", regenerate: "allowed", reason: "result_ready" }],
        ["explicit-retrievable", { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" }],
        ["explicit-failed-allowed", { phase: "failed", regenerate: "allowed", reason: "task_failed" }],
        ["explicit-settlement-pending", { phase: "failed", regenerate: "blocked", reason: "settlement_pending", reconcileDeadline: FUTURE_DEADLINE }],
        ["explicit-charged-unrecoverable", { phase: "failed", regenerate: "confirm", reason: "charged_result_unrecoverable" }],
        ["explicit-input-rejected", { phase: "failed", regenerate: "confirm", reason: "input_rejected" }],
    ] as const;
    for (const [name, outcome] of explicit) {
        add(name, { status: "error", taskId: "task-explicit", taskOutcome: outcome, generationErrorCode: "download_failed", errorDetails: "opaque", generationSubmissionState: "unknown", taskStage: "submission_unknown" });
    }
    add("overwrite-retrievable-then-network-text", {
        status: "error",
        taskId: "task-overwrite",
        taskOutcome: { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" },
        errorDetails: "Failed to fetch",
    });
    add("moderation-text-only", { status: "error", errorDetails: "提示词或参考素材未通过内容安全审核", taskId: "task-mod-text" });
    add("moderation-with-code", { status: "error", generationErrorCode: "sensitive_words_detected", errorDetails: "opaque", taskId: "task-mod-code" });
    add("moderation-content-code", { status: "error", generationErrorCode: "sensitive_words_detected", errorDetails: "含敏感词", taskId: "task-mod-const" });
    add("batch-child", { status: "error", batchRootId: "root", taskId: "task-child", generationErrorCode: "download_failed", errorDetails: "下载失败" });
    add("depth-capture-result", { status: "error", depthSourceNodeId: "source", taskType: "depth_capture", taskId: "depth-task", taskStatus: "failed", generationErrorCode: "download_failed", errorDetails: "下载生成结果失败" }, CanvasNodeType.Video);
    return list;
}

const EXPECTED: Array<{ name: string } & CanvasNodeFailureView> = [
    {
        "name": "running-task",
        "outcome": {
            "phase": "running",
            "regenerate": "blocked",
            "reason": "task_running"
        },
        "copy": {
            "badge": "生成中",
            "reason": "任务正在生成中",
            "action": "请等待当前任务完成",
            "message": "任务正在生成中，请等待当前任务完成。"
        },
        "explanation": {
            "category": "unknown",
            "summary": "",
            "reason": "生成失败",
            "action": "请查看详情后再决定是否重试",
            "message": "生成失败。请查看详情后再决定是否重试。",
            "errorCode": "unknown",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "succeeded-with-content",
        "outcome": {
            "phase": "ready",
            "regenerate": "allowed",
            "reason": "result_ready"
        },
        "copy": {
            "badge": "已完成",
            "reason": "生成结果已就绪",
            "action": "可直接查看或重新生成新版本",
            "message": "生成结果已就绪，可直接查看或重新生成新版本。"
        },
        "explanation": {
            "category": "unknown",
            "summary": "",
            "reason": "生成失败",
            "action": "请查看详情后再决定是否重试",
            "message": "生成失败。请查看详情后再决定是否重试。",
            "errorCode": "unknown",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": false,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "succeeded-without-content",
        "outcome": {
            "phase": "fetching",
            "regenerate": "blocked",
            "reason": "result_fetching"
        },
        "copy": {
            "badge": "正在取回结果",
            "reason": "生成已完成，正在取回结果",
            "action": "系统正在自动保存，无需重新生成",
            "message": "生成已完成，正在取回结果，系统正在自动保存，无需重新生成。"
        },
        "explanation": {
            "category": "unknown",
            "summary": "",
            "reason": "生成失败",
            "action": "请查看详情后再决定是否重试",
            "message": "生成失败。请查看详情后再决定是否重试。",
            "errorCode": "unknown",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "submission-unknown-state",
        "outcome": {
            "phase": "retrievable",
            "regenerate": "blocked",
            "reason": "submission_unknown"
        },
        "copy": {
            "badge": "正在取回结果",
            "reason": "上次生成结果已保留，系统正在自动取回",
            "action": "请等待取回完成，不要重复生成",
            "message": "上次生成结果已保留，系统正在自动取回，请等待取回完成，不要重复生成。"
        },
        "explanation": {
            "category": "unknown",
            "summary": "",
            "reason": "生成失败",
            "action": "请查看详情后再决定是否重试",
            "message": "生成失败。请查看详情后再决定是否重试。",
            "errorCode": "unknown",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": true,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": true,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "submission-unknown-stage",
        "outcome": {
            "phase": "retrievable",
            "regenerate": "blocked",
            "reason": "submission_unknown"
        },
        "copy": {
            "badge": "正在取回结果",
            "reason": "上次生成结果已保留，系统正在自动取回",
            "action": "请等待取回完成，不要重复生成",
            "message": "上次生成结果已保留，系统正在自动取回，请等待取回完成，不要重复生成。"
        },
        "explanation": {
            "category": "submission_uncertain",
            "summary": "",
            "reason": "提交结果尚未确认，上游任务可能仍在执行",
            "action": "请先查询原任务状态，不要立即重新提交",
            "message": "提交结果尚未确认，上游任务可能仍在执行。请先查询原任务状态，不要立即重新提交。",
            "errorCode": "submission_uncertain",
            "retryable": false,
            "uncertain": true,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": true,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": true,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": true,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "legacy-retrievable-canvas_conflict",
        "outcome": {
            "phase": "retrievable",
            "regenerate": "blocked",
            "reason": "delivery_pending"
        },
        "copy": {
            "badge": "正在取回结果",
            "reason": "上次生成结果已保留，系统正在自动取回",
            "action": "请等待取回完成，不要重复生成",
            "message": "上次生成结果已保留，系统正在自动取回，请等待取回完成，不要重复生成。"
        },
        "explanation": {
            "category": "canvas_conflict",
            "summary": "opaque",
            "reason": "生成结果已保留，画布尚未更新",
            "action": "请点击「继续取回」，不要重新生成",
            "message": "生成结果已保留，画布尚未更新。请点击「继续取回」，不要重新生成。",
            "errorCode": "canvas_conflict",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": true,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": true,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "legacy-retrievable-download_failed",
        "outcome": {
            "phase": "retrievable",
            "regenerate": "blocked",
            "reason": "delivery_pending"
        },
        "copy": {
            "badge": "正在取回结果",
            "reason": "上次生成结果已保留，系统正在自动取回",
            "action": "请等待取回完成，不要重复生成",
            "message": "上次生成结果已保留，系统正在自动取回，请等待取回完成，不要重复生成。"
        },
        "explanation": {
            "category": "download_failed",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "download_failed",
            "retryable": false,
            "uncertain": true,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": true,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": true,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": true,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "legacy-retrievable-result_apply_failed",
        "outcome": {
            "phase": "retrievable",
            "regenerate": "blocked",
            "reason": "delivery_pending"
        },
        "copy": {
            "badge": "正在取回结果",
            "reason": "上次生成结果已保留，系统正在自动取回",
            "action": "请等待取回完成，不要重复生成",
            "message": "上次生成结果已保留，系统正在自动取回，请等待取回完成，不要重复生成。"
        },
        "explanation": {
            "category": "result_apply_failed",
            "summary": "opaque",
            "reason": "生成结果已保留，还没放回画布",
            "action": "请点击「继续取回」，不要重新生成",
            "message": "生成结果已保留，还没放回画布。请点击「继续取回」，不要重新生成。",
            "errorCode": "result_apply_failed",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": true,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": true,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "legacy-retrievable-delivery_failed",
        "outcome": {
            "phase": "retrievable",
            "regenerate": "blocked",
            "reason": "delivery_pending"
        },
        "copy": {
            "badge": "正在取回结果",
            "reason": "上次生成结果已保留，系统正在自动取回",
            "action": "请等待取回完成，不要重复生成",
            "message": "上次生成结果已保留，系统正在自动取回，请等待取回完成，不要重复生成。"
        },
        "explanation": {
            "category": "delivery_failed",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "delivery_failed",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": true,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": true,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "legacy-retrievable-submission_uncertain",
        "outcome": {
            "phase": "retrievable",
            "regenerate": "blocked",
            "reason": "delivery_pending"
        },
        "copy": {
            "badge": "正在取回结果",
            "reason": "上次生成结果已保留，系统正在自动取回",
            "action": "请等待取回完成，不要重复生成",
            "message": "上次生成结果已保留，系统正在自动取回，请等待取回完成，不要重复生成。"
        },
        "explanation": {
            "category": "submission_uncertain",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "submission_uncertain",
            "retryable": false,
            "uncertain": true,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": true,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": true,
        "batchSubmissionUncertain": true,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": true,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "legacy-retrievable-results_missing",
        "outcome": {
            "phase": "retrievable",
            "regenerate": "blocked",
            "reason": "delivery_pending"
        },
        "copy": {
            "badge": "正在取回结果",
            "reason": "上次生成结果已保留，系统正在自动取回",
            "action": "请等待取回完成，不要重复生成",
            "message": "上次生成结果已保留，系统正在自动取回，请等待取回完成，不要重复生成。"
        },
        "explanation": {
            "category": "results_missing",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "results_missing",
            "retryable": false,
            "uncertain": true,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": true,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": true,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": true,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "legacy-input-moderation_input",
        "outcome": {
            "phase": "failed",
            "regenerate": "confirm",
            "reason": "input_rejected"
        },
        "copy": {
            "badge": "需调整输入",
            "reason": "提示词、参考素材或参数未通过校验",
            "action": "请调整输入后重新生成；继续提交可能会再次产生费用",
            "message": "提示词、参考素材或参数未通过校验。请调整输入后重新生成；继续提交可能会再次产生费用。",
            "confirmTitle": "确认重新生成？",
            "confirmContent": "上次输入未通过校验，重新生成可能会再扣一次。建议先修改提示词或参考素材。"
        },
        "explanation": {
            "category": "moderation_input",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "moderation_input",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": true
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": true,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": true,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "legacy-input-moderation_reference",
        "outcome": {
            "phase": "failed",
            "regenerate": "confirm",
            "reason": "input_rejected"
        },
        "copy": {
            "badge": "需调整输入",
            "reason": "提示词、参考素材或参数未通过校验",
            "action": "请调整输入后重新生成；继续提交可能会再次产生费用",
            "message": "提示词、参考素材或参数未通过校验。请调整输入后重新生成；继续提交可能会再次产生费用。",
            "confirmTitle": "确认重新生成？",
            "confirmContent": "上次输入未通过校验，重新生成可能会再扣一次。建议先修改提示词或参考素材。"
        },
        "explanation": {
            "category": "moderation_reference",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "moderation_reference",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": true
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": true,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": true,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "legacy-input-moderation_output",
        "outcome": {
            "phase": "failed",
            "regenerate": "confirm",
            "reason": "input_rejected"
        },
        "copy": {
            "badge": "需调整输入",
            "reason": "提示词、参考素材或参数未通过校验",
            "action": "请调整输入后重新生成；继续提交可能会再次产生费用",
            "message": "提示词、参考素材或参数未通过校验。请调整输入后重新生成；继续提交可能会再次产生费用。",
            "confirmTitle": "确认重新生成？",
            "confirmContent": "上次输入未通过校验，重新生成可能会再扣一次。建议先修改提示词或参考素材。"
        },
        "explanation": {
            "category": "moderation_output",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "moderation_output",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": true
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": true,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": true,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "legacy-input-invalid_params",
        "outcome": {
            "phase": "failed",
            "regenerate": "confirm",
            "reason": "input_rejected"
        },
        "copy": {
            "badge": "需调整输入",
            "reason": "提示词、参考素材或参数未通过校验",
            "action": "请调整输入后重新生成；继续提交可能会再次产生费用",
            "message": "提示词、参考素材或参数未通过校验。请调整输入后重新生成；继续提交可能会再次产生费用。",
            "confirmTitle": "确认重新生成？",
            "confirmContent": "上次输入未通过校验，重新生成可能会再扣一次。建议先修改提示词或参考素材。"
        },
        "explanation": {
            "category": "invalid_params",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "invalid_params",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": true,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "legacy-input-context_too_long",
        "outcome": {
            "phase": "failed",
            "regenerate": "confirm",
            "reason": "input_rejected"
        },
        "copy": {
            "badge": "需调整输入",
            "reason": "提示词、参考素材或参数未通过校验",
            "action": "请调整输入后重新生成；继续提交可能会再次产生费用",
            "message": "提示词、参考素材或参数未通过校验。请调整输入后重新生成；继续提交可能会再次产生费用。",
            "confirmTitle": "确认重新生成？",
            "confirmContent": "上次输入未通过校验，重新生成可能会再扣一次。建议先修改提示词或参考素材。"
        },
        "explanation": {
            "category": "context_too_long",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "context_too_long",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": true,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "legacy-input-input_inaccessible",
        "outcome": {
            "phase": "failed",
            "regenerate": "confirm",
            "reason": "input_rejected"
        },
        "copy": {
            "badge": "需调整输入",
            "reason": "提示词、参考素材或参数未通过校验",
            "action": "请调整输入后重新生成；继续提交可能会再次产生费用",
            "message": "提示词、参考素材或参数未通过校验。请调整输入后重新生成；继续提交可能会再次产生费用。",
            "confirmTitle": "确认重新生成？",
            "confirmContent": "上次输入未通过校验，重新生成可能会再扣一次。建议先修改提示词或参考素材。"
        },
        "explanation": {
            "category": "input_inaccessible",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "input_inaccessible",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": true,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "legacy-input-input_too_large",
        "outcome": {
            "phase": "failed",
            "regenerate": "confirm",
            "reason": "input_rejected"
        },
        "copy": {
            "badge": "需调整输入",
            "reason": "提示词、参考素材或参数未通过校验",
            "action": "请调整输入后重新生成；继续提交可能会再次产生费用",
            "message": "提示词、参考素材或参数未通过校验。请调整输入后重新生成；继续提交可能会再次产生费用。",
            "confirmTitle": "确认重新生成？",
            "confirmContent": "上次输入未通过校验，重新生成可能会再扣一次。建议先修改提示词或参考素材。"
        },
        "explanation": {
            "category": "input_too_large",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "input_too_large",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": true,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "legacy-input-content_policy_violation",
        "outcome": {
            "phase": "failed",
            "regenerate": "confirm",
            "reason": "input_rejected"
        },
        "copy": {
            "badge": "需调整输入",
            "reason": "提示词、参考素材或参数未通过校验",
            "action": "请调整输入后重新生成；继续提交可能会再次产生费用",
            "message": "提示词、参考素材或参数未通过校验。请调整输入后重新生成；继续提交可能会再次产生费用。",
            "confirmTitle": "确认重新生成？",
            "confirmContent": "上次输入未通过校验，重新生成可能会再扣一次。建议先修改提示词或参考素材。"
        },
        "explanation": {
            "category": "moderation_input",
            "summary": "opaque",
            "reason": "提示词或参考素材未通过内容安全审核",
            "action": "请调整提示词或参考素材后重新生成",
            "message": "提示词或参考素材未通过内容安全审核。请调整提示词或参考素材后重新生成。",
            "errorCode": "moderation_input",
            "providerCode": "content_policy_violation",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": true
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": true,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": true,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "legacy-input-sensitive_words_detected",
        "outcome": {
            "phase": "failed",
            "regenerate": "confirm",
            "reason": "input_rejected"
        },
        "copy": {
            "badge": "需调整输入",
            "reason": "提示词、参考素材或参数未通过校验",
            "action": "请调整输入后重新生成；继续提交可能会再次产生费用",
            "message": "提示词、参考素材或参数未通过校验。请调整输入后重新生成；继续提交可能会再次产生费用。",
            "confirmTitle": "确认重新生成？",
            "confirmContent": "上次输入未通过校验，重新生成可能会再扣一次。建议先修改提示词或参考素材。"
        },
        "explanation": {
            "category": "moderation_input",
            "summary": "opaque",
            "reason": "提示词或参考素材未通过内容安全审核",
            "action": "请调整提示词或参考素材后重新生成",
            "message": "提示词或参考素材未通过内容安全审核。请调整提示词或参考素材后重新生成。",
            "errorCode": "moderation_input",
            "providerCode": "sensitive_words_detected",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": true
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": true,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": true,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "request-not-sent",
        "outcome": {
            "phase": "failed",
            "regenerate": "allowed",
            "reason": "not_charged"
        },
        "copy": {
            "badge": "生成失败",
            "reason": "上次请求未扣费，可以直接重新生成",
            "action": "可以直接重新生成",
            "message": "上次请求未扣费，可以直接重新生成。"
        },
        "explanation": {
            "category": "request_not_sent",
            "summary": "未能连接服务",
            "reason": "未能连接服务",
            "action": "",
            "message": "未能连接服务",
            "errorCode": "request_not_sent",
            "retryable": true,
            "uncertain": false,
            "blockAutomaticRetry": false,
            "blockManualRetry": false,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "cancelled",
        "outcome": {
            "phase": "failed",
            "regenerate": "allowed",
            "reason": "not_charged"
        },
        "copy": {
            "badge": "生成失败",
            "reason": "上次请求未扣费，可以直接重新生成",
            "action": "可以直接重新生成",
            "message": "上次请求未扣费，可以直接重新生成。"
        },
        "explanation": {
            "category": "cancelled",
            "summary": "任务已取消",
            "reason": "任务已取消",
            "action": "可按原输入重新提交",
            "message": "任务已取消。可按原输入重新提交。",
            "errorCode": "cancelled",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": false,
            "blockManualRetry": false,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "text-auth",
        "outcome": {
            "phase": "failed",
            "regenerate": "allowed",
            "reason": "task_failed"
        },
        "copy": {
            "badge": "生成失败",
            "reason": "上次生成未完成，可以直接重新生成",
            "action": "可以直接重新生成",
            "message": "上次生成未完成，可以直接重新生成。"
        },
        "explanation": {
            "category": "auth",
            "summary": "invalid api key",
            "reason": "模型服务鉴权失败",
            "action": "请检查 API Key 后重试",
            "message": "模型服务鉴权失败。请检查 API Key 后重试。",
            "errorCode": "auth",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": false,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "text-throttled",
        "outcome": {
            "phase": "failed",
            "regenerate": "allowed",
            "reason": "task_failed"
        },
        "copy": {
            "badge": "生成失败",
            "reason": "上次生成未完成，可以直接重新生成",
            "action": "可以直接重新生成",
            "message": "上次生成未完成，可以直接重新生成。"
        },
        "explanation": {
            "category": "throttled",
            "summary": "too many requests",
            "reason": "请求过于频繁",
            "action": "请稍后再试",
            "message": "请求过于频繁。请稍后再试。",
            "errorCode": "throttled",
            "retryable": true,
            "uncertain": false,
            "blockAutomaticRetry": false,
            "blockManualRetry": false,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": false,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "text-network",
        "outcome": {
            "phase": "failed",
            "regenerate": "allowed",
            "reason": "task_failed"
        },
        "copy": {
            "badge": "生成失败",
            "reason": "上次生成未完成，可以直接重新生成",
            "action": "可以直接重新生成",
            "message": "上次生成未完成，可以直接重新生成。"
        },
        "explanation": {
            "category": "network",
            "summary": "Failed to fetch",
            "reason": "网络连接失败",
            "action": "请检查网络并核对原任务状态后，再决定是否重新生成",
            "message": "网络连接失败。请检查网络并核对原任务状态后，再决定是否重新生成。",
            "errorCode": "network",
            "retryable": true,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": false,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "target-unavailable-with-task",
        "outcome": {
            "phase": "failed",
            "regenerate": "blocked",
            "reason": "result_target_unavailable"
        },
        "copy": {
            "badge": "结果已保存",
            "reason": "生成结果已保存在生成历史，当前目标节点已变更",
            "action": "请从生成历史查看结果，请勿重复生成",
            "message": "生成结果已保存在生成历史，当前目标节点已变更。请从生成历史查看结果，请勿重复生成。"
        },
        "explanation": {
            "category": "result_target_unavailable",
            "summary": "生成结果已保存，无法放回原节点",
            "reason": "生成结果已保存，无法放回原节点",
            "action": "从「生成历史」取回，无需重新生成",
            "message": "生成结果已保存，无法放回原节点。从「生成历史」取回，无需重新生成。",
            "errorCode": "result_target_unavailable",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": false,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": false,
        "recoveryRoute": "history",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": true,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "target-unavailable-without-task",
        "outcome": {
            "phase": "failed",
            "regenerate": "blocked",
            "reason": "result_target_unavailable"
        },
        "copy": {
            "badge": "结果已保存",
            "reason": "生成结果已保存在生成历史，当前目标节点已变更",
            "action": "请从生成历史查看结果，请勿重复生成",
            "message": "生成结果已保存在生成历史，当前目标节点已变更。请从生成历史查看结果，请勿重复生成。"
        },
        "explanation": {
            "category": "result_target_unavailable",
            "summary": "生成结果已保存，无法放回原节点",
            "reason": "生成结果已保存，无法放回原节点",
            "action": "从「生成历史」取回，无需重新生成",
            "message": "生成结果已保存，无法放回原节点。从「生成历史」取回，无需重新生成。",
            "errorCode": "result_target_unavailable",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": false,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": false,
        "recoveryRoute": "history",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": true,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "explicit-running",
        "outcome": {
            "phase": "running",
            "regenerate": "blocked",
            "reason": "task_running"
        },
        "copy": {
            "badge": "生成中",
            "reason": "任务正在生成中",
            "action": "请等待当前任务完成",
            "message": "任务正在生成中，请等待当前任务完成。"
        },
        "explanation": {
            "category": "download_failed",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "download_failed",
            "retryable": false,
            "uncertain": true,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": true,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "explicit-fetching",
        "outcome": {
            "phase": "fetching",
            "regenerate": "blocked",
            "reason": "result_fetching"
        },
        "copy": {
            "badge": "正在取回结果",
            "reason": "生成已完成，正在取回结果",
            "action": "系统正在自动保存，无需重新生成",
            "message": "生成已完成，正在取回结果，系统正在自动保存，无需重新生成。"
        },
        "explanation": {
            "category": "download_failed",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "download_failed",
            "retryable": false,
            "uncertain": true,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": true,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "explicit-ready",
        "outcome": {
            "phase": "ready",
            "regenerate": "allowed",
            "reason": "result_ready"
        },
        "copy": {
            "badge": "已完成",
            "reason": "生成结果已就绪",
            "action": "可直接查看或重新生成新版本",
            "message": "生成结果已就绪，可直接查看或重新生成新版本。"
        },
        "explanation": {
            "category": "download_failed",
            "summary": "opaque",
            "reason": "生成结果已就绪",
            "action": "可直接查看或重新生成新版本",
            "message": "opaque",
            "errorCode": "download_failed",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": false,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "explicit-retrievable",
        "outcome": {
            "phase": "retrievable",
            "regenerate": "blocked",
            "reason": "delivery_pending"
        },
        "copy": {
            "badge": "正在取回结果",
            "reason": "上次生成结果已保留，系统正在自动取回",
            "action": "请等待取回完成，不要重复生成",
            "message": "上次生成结果已保留，系统正在自动取回，请等待取回完成，不要重复生成。"
        },
        "explanation": {
            "category": "download_failed",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "download_failed",
            "retryable": false,
            "uncertain": true,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": true,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": true,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": true,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "explicit-failed-allowed",
        "outcome": {
            "phase": "failed",
            "regenerate": "allowed",
            "reason": "task_failed"
        },
        "copy": {
            "badge": "生成失败",
            "reason": "上次生成未完成，可以直接重新生成",
            "action": "可以直接重新生成",
            "message": "上次生成未完成，可以直接重新生成。"
        },
        "explanation": {
            "category": "download_failed",
            "summary": "opaque",
            "reason": "上次生成未完成，可以直接重新生成",
            "action": "可以直接重新生成",
            "message": "opaque",
            "errorCode": "download_failed",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": false,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "explicit-settlement-pending",
        "outcome": {
            "phase": "failed",
            "regenerate": "blocked",
            "reason": "settlement_pending",
            "reconcileDeadline": "2026-04-20T06:15:00.000Z"
        },
        "copy": {
            "badge": "正在核对",
            "reason": "BeefTV 正在核对上次提交，预计 06:15 前有结论",
            "action": "核对完成前请勿重新生成",
            "message": "BeefTV 正在核对上次提交，预计 06:15 前有结论。核对完成前请勿重新生成。"
        },
        "explanation": {
            "category": "download_failed",
            "summary": "opaque",
            "reason": "BeefTV 正在核对上次提交，预计 06:15 前有结论",
            "action": "核对完成前请勿重新生成",
            "message": "opaque",
            "errorCode": "download_failed",
            "retryable": false,
            "uncertain": true,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": true,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "explicit-charged-unrecoverable",
        "outcome": {
            "phase": "failed",
            "regenerate": "confirm",
            "reason": "charged_result_unrecoverable"
        },
        "copy": {
            "badge": "结果无法取回",
            "reason": "上次已扣费，但结果拿不回，重新生成会再扣一次",
            "action": "确认后将创建新任务重新生成",
            "message": "上次已扣费，但结果拿不回，重新生成会再扣一次。确认后将创建新任务重新生成。",
            "confirmTitle": "确认重新生成？",
            "confirmContent": "上次已扣费，但结果拿不回，重新生成会再扣一次。"
        },
        "explanation": {
            "category": "download_failed",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "download_failed",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": false,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": true,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "explicit-input-rejected",
        "outcome": {
            "phase": "failed",
            "regenerate": "confirm",
            "reason": "input_rejected"
        },
        "copy": {
            "badge": "需调整输入",
            "reason": "提示词、参考素材或参数未通过校验",
            "action": "请调整输入后重新生成；继续提交可能会再次产生费用",
            "message": "提示词、参考素材或参数未通过校验。请调整输入后重新生成；继续提交可能会再次产生费用。",
            "confirmTitle": "确认重新生成？",
            "confirmContent": "上次输入未通过校验，重新生成可能会再扣一次。建议先修改提示词或参考素材。"
        },
        "explanation": {
            "category": "download_failed",
            "summary": "opaque",
            "reason": "opaque",
            "action": "",
            "message": "opaque",
            "errorCode": "download_failed",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": false,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": true,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "overwrite-retrievable-then-network-text",
        "outcome": {
            "phase": "retrievable",
            "regenerate": "blocked",
            "reason": "delivery_pending"
        },
        "copy": {
            "badge": "正在取回结果",
            "reason": "上次生成结果已保留，系统正在自动取回",
            "action": "请等待取回完成，不要重复生成",
            "message": "上次生成结果已保留，系统正在自动取回，请等待取回完成，不要重复生成。"
        },
        "explanation": {
            "category": "network",
            "summary": "Failed to fetch",
            "reason": "网络连接失败",
            "action": "请检查网络并核对原任务状态后，再决定是否重新生成",
            "message": "网络连接失败。请检查网络并核对原任务状态后，再决定是否重新生成。",
            "errorCode": "network",
            "retryable": true,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": true,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": true,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "moderation-text-only",
        "outcome": {
            "phase": "failed",
            "regenerate": "allowed",
            "reason": "task_failed"
        },
        "copy": {
            "badge": "生成失败",
            "reason": "上次生成未完成，可以直接重新生成",
            "action": "可以直接重新生成",
            "message": "上次生成未完成，可以直接重新生成。"
        },
        "explanation": {
            "category": "unknown",
            "summary": "提示词或参考素材未通过内容安全审核",
            "reason": "提示词或参考素材未通过内容安全审核",
            "action": "",
            "message": "提示词或参考素材未通过内容安全审核",
            "errorCode": "unknown",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "moderation-with-code",
        "outcome": {
            "phase": "failed",
            "regenerate": "confirm",
            "reason": "input_rejected"
        },
        "copy": {
            "badge": "需调整输入",
            "reason": "提示词、参考素材或参数未通过校验",
            "action": "请调整输入后重新生成；继续提交可能会再次产生费用",
            "message": "提示词、参考素材或参数未通过校验。请调整输入后重新生成；继续提交可能会再次产生费用。",
            "confirmTitle": "确认重新生成？",
            "confirmContent": "上次输入未通过校验，重新生成可能会再扣一次。建议先修改提示词或参考素材。"
        },
        "explanation": {
            "category": "moderation_input",
            "summary": "opaque",
            "reason": "提示词或参考素材未通过内容安全审核",
            "action": "请调整提示词或参考素材后重新生成",
            "message": "提示词或参考素材未通过内容安全审核。请调整提示词或参考素材后重新生成。",
            "errorCode": "moderation_input",
            "providerCode": "sensitive_words_detected",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": true
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": true,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": true,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "moderation-content-code",
        "outcome": {
            "phase": "failed",
            "regenerate": "confirm",
            "reason": "input_rejected"
        },
        "copy": {
            "badge": "需调整输入",
            "reason": "提示词、参考素材或参数未通过校验",
            "action": "请调整输入后重新生成；继续提交可能会再次产生费用",
            "message": "提示词、参考素材或参数未通过校验。请调整输入后重新生成；继续提交可能会再次产生费用。",
            "confirmTitle": "确认重新生成？",
            "confirmContent": "上次输入未通过校验，重新生成可能会再扣一次。建议先修改提示词或参考素材。"
        },
        "explanation": {
            "category": "moderation_input",
            "summary": "含敏感词",
            "reason": "提示词或参考素材未通过内容安全审核",
            "action": "请调整提示词或参考素材后重新生成",
            "message": "提示词或参考素材未通过内容安全审核。请调整提示词或参考素材后重新生成。",
            "errorCode": "moderation_input",
            "providerCode": "sensitive_words_detected",
            "retryable": false,
            "uncertain": false,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": true
        },
        "retryBlocked": false,
        "regenerateBlocked": false,
        "regenerateConfirm": true,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": true,
        "pendingOutcome": false,
        "depthResult": false,
        "batchRegenerateVisible": true
    },
    {
        "name": "batch-child",
        "outcome": {
            "phase": "retrievable",
            "regenerate": "blocked",
            "reason": "delivery_pending"
        },
        "copy": {
            "badge": "正在取回结果",
            "reason": "上次生成结果已保留，系统正在自动取回",
            "action": "请等待取回完成，不要重复生成",
            "message": "上次生成结果已保留，系统正在自动取回，请等待取回完成，不要重复生成。"
        },
        "explanation": {
            "category": "download_failed",
            "summary": "下载失败",
            "reason": "下载失败",
            "action": "",
            "message": "下载失败",
            "errorCode": "download_failed",
            "retryable": false,
            "uncertain": true,
            "blockAutomaticRetry": true,
            "blockManualRetry": true,
            "moderation": false
        },
        "retryBlocked": true,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": false,
        "needsRecovery": true,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": true,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": true,
        "depthResult": false,
        "batchRegenerateVisible": false
    },
    {
        "name": "depth-capture-result",
        "outcome": {
            "phase": "retrievable",
            "regenerate": "blocked",
            "reason": "delivery_pending"
        },
        "copy": {
            "badge": "正在取回结果",
            "reason": "上次生成结果已保留，系统正在自动取回",
            "action": "请等待取回完成，不要重复生成",
            "message": "上次生成结果已保留，系统正在自动取回，请等待取回完成，不要重复生成。"
        },
        "explanation": {
            "category": "download_failed",
            "summary": "下载生成结果失败",
            "reason": "深度处理失败",
            "action": "请查看详情，检查深度组件和网络后重试",
            "message": "下载生成结果失败。排查编号：任务 depth-task。",
            "errorCode": "download_failed",
            "taskId": "depth-task",
            "retryable": true,
            "uncertain": false,
            "blockAutomaticRetry": false,
            "blockManualRetry": false,
            "moderation": false
        },
        "retryBlocked": false,
        "regenerateBlocked": true,
        "regenerateConfirm": false,
        "canReload": true,
        "needsRecovery": false,
        "recoveryRoute": "single",
        "cardSubmissionUncertain": false,
        "batchSubmissionUncertain": false,
        "moderationResetOnPromptEdit": false,
        "pendingOutcome": true,
        "depthResult": true,
        "batchRegenerateVisible": false
    }
] as Array<{ name: string } & CanvasNodeFailureView>;

describe("canvasNodeFailureView", () => {
    test("reads and caches only the requested field", () => {
        const item = node("lazy", { status: "error", taskOutcome: { phase: "failed", regenerate: "allowed", reason: "task_failed" } });
        let reads = 0;
        Object.defineProperty(item.metadata, "errorDetails", { get() { reads++; return "opaque"; } });
        const view = canvasNodeFailureView(item);
        expect(view.regenerateBlocked).toBe(false);
        expect(reads).toBe(0);
        const explanation = view.explanation;
        const afterFirstRead = reads;
        expect(afterFirstRead).toBeGreaterThan(0);
        expect(view.explanation).toBe(explanation);
        expect(reads).toBe(afterFirstRead);
    });

    test("locks today's display and action decisions for every recorded node", () => {
        Date.now = () => NOW_MS;
        try {
            const built = fixtures();
            expect(built.map((item) => item.name)).toEqual(EXPECTED.map((item) => item.name));
            for (const [index, fixture] of built.entries()) {
                const expected = EXPECTED[index];
                const view = canvasNodeFailureView(fixture.node, { nowMs: NOW_MS, allNodes: fixture.allNodes });
                const expectedView = {
                    outcome: expected.outcome ?? undefined,
                    copy: expected.copy,
                    explanation: expected.explanation,
                    retryBlocked: expected.retryBlocked,
                    regenerateBlocked: expected.regenerateBlocked,
                    regenerateConfirm: expected.regenerateConfirm,
                    canReload: expected.canReload,
                    needsRecovery: expected.needsRecovery,
                    recoveryRoute: expected.recoveryRoute,
                    cardSubmissionUncertain: expected.cardSubmissionUncertain,
                    batchSubmissionUncertain: expected.batchSubmissionUncertain,
                    moderationResetOnPromptEdit: expected.moderationResetOnPromptEdit,
                    pendingOutcome: expected.pendingOutcome,
                    depthResult: expected.depthResult,
                    batchRegenerateVisible: expected.batchRegenerateVisible,
                };
                // Read every public field, including lazily computed getters.
                const actual = Object.fromEntries((Object.keys(expectedView) as Array<keyof CanvasNodeFailureView>).map((key) => [key, view[key]]));
                expect(actual, fixture.name).toEqual(expectedView);
                const restored = JSON.parse(JSON.stringify(persistCanvasNodeFailure(fixture.node))) as CanvasNodeData;
                const reopened = canvasNodeFailureView(restored, { nowMs: NOW_MS, allNodes: fixture.allNodes });
                const savedView = Object.fromEntries((Object.keys(expectedView) as Array<keyof CanvasNodeFailureView>).map(key => [key, reopened[key]]));
                expect(savedView, `${fixture.name} saved and reopened`).toEqual(expectedView);
            }
        } finally {
            Date.now = realNow;
        }
    });
});

afterEach(() => {
    Date.now = realNow;
});
