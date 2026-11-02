import { describe, expect, it } from "bun:test";
import {
    canRecoverTaskOutcome,
    canRegenerateTaskOutcome,
    canReloadCanvasNodeResource,
    canvasNodeHasPendingOutcomeResult,
    formatReconcileDeadlineCopy,
    isNodeRegenerateBlocked,
    isNodeRegenerateConfirm,
    isRegenerateAllowed,
    isRegenerateBlocked,
    isRegenerateConfirm,
    isTaskOutcomeFailed,
    isTaskOutcomeReady,
    isTaskOutcomeRetrievable,
    isTaskOutcomeRunningOrFetching,
    isTaskOutcomeWorking,
    isTaskRegenerateBlocked,
    normalizeTaskOutcome,
    readNodeTaskOutcome,
    readTaskOutcome,
    taskOutcomeCopy,
    type TaskOutcome,
    type TaskOutcomePhase,
    type TaskOutcomeRegenerate,
} from "@/lib/task-outcome";

describe("task-outcome", () => {
    it("recognizes all 5 phase values and 3 regenerate values", () => {
        const phases: TaskOutcomePhase[] = ["running", "fetching", "ready", "retrievable", "failed"];
        const regenerates: TaskOutcomeRegenerate[] = ["allowed", "confirm", "blocked"];

        for (const phase of phases) {
            for (const regenerate of regenerates) {
                const outcome = normalizeTaskOutcome({
                    phase,
                    regenerate,
                    reason: `${phase}_${regenerate}`,
                });
                expect(outcome).toEqual({
                    phase,
                    regenerate,
                    reason: `${phase}_${regenerate}`,
                });
            }
        }

        expect(isTaskOutcomeWorking({ phase: "running", regenerate: "blocked", reason: "task_running" })).toBe(true);
        expect(isTaskOutcomeWorking({ phase: "fetching", regenerate: "blocked", reason: "result_fetching" })).toBe(true);
        expect(isTaskOutcomeWorking({ phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" })).toBe(true);
        expect(isTaskOutcomeWorking({ phase: "ready", regenerate: "allowed", reason: "result_ready" })).toBe(false);
        expect(isTaskOutcomeWorking({ phase: "failed", regenerate: "allowed", reason: "no_result" })).toBe(false);

        expect(isTaskOutcomeRunningOrFetching({ phase: "running", regenerate: "blocked", reason: "task_running" })).toBe(true);
        expect(isTaskOutcomeRunningOrFetching({ phase: "fetching", regenerate: "blocked", reason: "result_fetching" })).toBe(true);
        expect(isTaskOutcomeRunningOrFetching({ phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" })).toBe(false);

        expect(isTaskOutcomeRetrievable({ phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" })).toBe(true);
        expect(isTaskOutcomeReady({ phase: "ready", regenerate: "allowed", reason: "result_ready" })).toBe(true);
        expect(isTaskOutcomeFailed({ phase: "failed", regenerate: "allowed", reason: "no_result" })).toBe(true);
    });

    it("ignores conflicting status/stage/errorCode/error text when task.outcome or metadata.taskOutcome is present", () => {
        // Task has status=failed & stage=submission_unknown & errorCode=download_failed,
        // but backend outcome says failed + allowed -> must strictly follow outcome
        const allowedOutcome: TaskOutcome = {
            phase: "failed",
            regenerate: "allowed",
            reason: "not_charged",
        };
        const taskWithAllowedOutcome = {
            status: "failed",
            stage: "submission_unknown",
            errorCode: "download_failed",
            error: "下载超时，结果仍保留在服务器",
            outcome: allowedOutcome,
        };
        expect(readTaskOutcome(taskWithAllowedOutcome)).toEqual(allowedOutcome);
        expect(isTaskRegenerateBlocked(taskWithAllowedOutcome)).toBe(false);
        expect(isRegenerateAllowed(readTaskOutcome(taskWithAllowedOutcome))).toBe(true);

        // Task has status=succeeded, but backend outcome says retrievable + blocked -> must follow outcome
        const retrievableOutcome: TaskOutcome = {
            phase: "retrievable",
            regenerate: "blocked",
            reason: "delivery_pending",
        };
        const taskWithRetrievableOutcome = {
            status: "succeeded",
            stage: "done",
            outcome: retrievableOutcome,
        };
        expect(readTaskOutcome(taskWithRetrievableOutcome)).toEqual(retrievableOutcome);
        expect(isTaskRegenerateBlocked(taskWithRetrievableOutcome)).toBe(true);
        expect(canRecoverTaskOutcome(readTaskOutcome(taskWithRetrievableOutcome))).toBe(true);

        // Canvas node has generationErrorCode=download_failed & generationSubmissionState=unknown,
        // but metadata.taskOutcome says failed + confirm -> must strictly follow metadata.taskOutcome
        const confirmOutcome: TaskOutcome = {
            phase: "failed",
            regenerate: "confirm",
            reason: "result_unrecoverable",
        };
        const nodeMetadata = {
            taskId: "task_123",
            taskStatus: "running",
            taskStage: "submission_unknown",
            generationSubmissionState: "unknown",
            generationErrorCode: "download_failed",
            errorDetails: "画布版本冲突，结果未写回",
            taskOutcome: confirmOutcome,
        };
        expect(readNodeTaskOutcome(nodeMetadata)).toEqual(confirmOutcome);
        expect(isNodeRegenerateBlocked(nodeMetadata)).toBe(false);
        expect(isNodeRegenerateConfirm(nodeMetadata)).toBe(true);
        expect(canReloadCanvasNodeResource(nodeMetadata)).toBe(false);
    });

    it("evaluates regenerate permissions and node resource reload eligibility from outcome", () => {
        const blockedOutcome: TaskOutcome = {
            phase: "failed",
            regenerate: "blocked",
            reason: "settlement_pending",
            reconcileDeadline: "2026-04-20T14:35:00.000Z",
        };
        expect(isRegenerateBlocked(blockedOutcome)).toBe(true);
        expect(isRegenerateConfirm(blockedOutcome)).toBe(false);
        expect(isRegenerateAllowed(blockedOutcome)).toBe(false);
        expect(canRegenerateTaskOutcome(blockedOutcome)).toBe(false);

        const confirmOutcome: TaskOutcome = {
            phase: "failed",
            regenerate: "confirm",
            reason: "charged_result_unrecoverable",
        };
        expect(isRegenerateBlocked(confirmOutcome)).toBe(false);
        expect(isRegenerateConfirm(confirmOutcome)).toBe(true);
        expect(isRegenerateAllowed(confirmOutcome)).toBe(false);
        expect(canRegenerateTaskOutcome(confirmOutcome)).toBe(true);

        const allowedOutcome: TaskOutcome = {
            phase: "failed",
            regenerate: "allowed",
            reason: "no_result",
        };
        expect(isRegenerateBlocked(allowedOutcome)).toBe(false);
        expect(isRegenerateConfirm(allowedOutcome)).toBe(false);
        expect(isRegenerateAllowed(allowedOutcome)).toBe(true);
        expect(canRegenerateTaskOutcome(allowedOutcome)).toBe(true);

        // Standalone node with retrievable outcome can reload resource
        expect(
            canReloadCanvasNodeResource({
                taskId: "task_recover_1",
                taskOutcome: {
                    phase: "retrievable",
                    regenerate: "blocked",
                    reason: "delivery_pending",
                },
            }),
        ).toBe(true);

        // Batch child node with batchRootId must not expose manual reload button
        expect(
            canReloadCanvasNodeResource({
                taskId: "task_recover_child",
                batchRootId: "node_batch_root",
                taskOutcome: {
                    phase: "retrievable",
                    regenerate: "blocked",
                    reason: "delivery_pending",
                },
            }),
        ).toBe(false);

        // Parent node detects pending outcome result on batch child
        const rootNode = {
            id: "node_batch_root",
            metadata: {
                batchChildIds: ["node_child_1"],
                taskOutcome: {
                    phase: "ready" as const,
                    regenerate: "allowed" as const,
                    reason: "result_ready",
                },
            },
        };
        const childNode = {
            id: "node_child_1",
            metadata: {
                batchRootId: "node_batch_root",
                taskOutcome: {
                    phase: "retrievable" as const,
                    regenerate: "blocked" as const,
                    reason: "image_recovery_pending",
                },
            },
        };
        expect(canvasNodeHasPendingOutcomeResult(rootNode, [rootNode, childNode])).toBe(true);
    });

    it("formats reconcileDeadline copy for future and expired deadlines and never leaks internal tokens", () => {
        const nowMs = Date.parse("2026-04-20T06:00:00.000Z");
        const futureIso = new Date(nowMs + 15 * 60_000).toISOString();
        const expiredIso = new Date(nowMs - 60_000).toISOString();

        const futureCopy = formatReconcileDeadlineCopy(futureIso, nowMs);
        expect(futureCopy).toMatch(/^BeefTV 正在核对上次提交，预计 \d{2}:\d{2} 前有结论$/);

        const expiredCopy = formatReconcileDeadlineCopy(expiredIso, nowMs);
        expect(expiredCopy).toBe("BeefTV 正在核对，已超过预计时间，可联系客服");

        const confirmUncertain = taskOutcomeCopy(
            {
                phase: "failed",
                regenerate: "confirm",
                reason: "result_unrecoverable",
            },
            nowMs,
        );
        expect(confirmUncertain.reason).toBe("无法确认上次是否已扣费，可先到模型服务后台查看使用记录");
        expect(confirmUncertain.confirmContent).toContain("重新生成可能会再扣一次");

        const confirmCharged = taskOutcomeCopy(
            {
                phase: "failed",
                regenerate: "confirm",
                reason: "charged_result_unrecoverable",
            },
            nowMs,
        );
        expect(confirmCharged.reason).toBe("上次已扣费，但结果拿不回，重新生成会再扣一次");

        const forbiddenTokens = [
            "BeefAPI",
            "beefapi",
            "usage_state",
            "billing_state",
            "reconcile_deadline",
            "pending",
            "settled",
            "refunded",
            "routeRun",
            "operationId",
            "no_result",
            "unrecoverable",
        ];

        const sampleOutcomes: TaskOutcome[] = [
            { phase: "running", regenerate: "blocked", reason: "task_running" },
            { phase: "fetching", regenerate: "blocked", reason: "result_fetching" },
            { phase: "ready", regenerate: "allowed", reason: "result_ready" },
            { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" },
            { phase: "retrievable", regenerate: "blocked", reason: "image_recovery_pending" },
            { phase: "retrievable", regenerate: "blocked", reason: "provider_result_pending" },
            { phase: "retrievable", regenerate: "blocked", reason: "evidence_unavailable" },
            { phase: "failed", regenerate: "blocked", reason: "settlement_pending", reconcileDeadline: futureIso },
            { phase: "failed", regenerate: "blocked", reason: "billing_pending", reconcileDeadline: expiredIso },
            { phase: "failed", regenerate: "blocked", reason: "reconcile_pending" },
            { phase: "failed", regenerate: "blocked", reason: "result_target_unavailable" },
            { phase: "failed", regenerate: "confirm", reason: "result_unrecoverable" },
            { phase: "failed", regenerate: "confirm", reason: "charged_result_unrecoverable" },
            { phase: "failed", regenerate: "confirm", reason: "input_rejected" },
            { phase: "failed", regenerate: "allowed", reason: "no_result" },
            { phase: "failed", regenerate: "allowed", reason: "refunded" },
            { phase: "failed", regenerate: "allowed", reason: "not_charged" },
            { phase: "failed", regenerate: "allowed", reason: "task_failed" },
        ];

        for (const outcome of sampleOutcomes) {
            const copy = taskOutcomeCopy(outcome, nowMs);
            const combined = [copy.badge, copy.reason, copy.action, copy.message, copy.confirmTitle ?? "", copy.confirmContent ?? ""].join(" ");
            for (const token of forbiddenTokens) {
                expect(combined).not.toContain(token);
            }
        }
    });
});
