package task

import (
	"reflect"
	"testing"
	"time"

	"qisitv/backend/internal/model"
)

func TestComputeOutcome(t *testing.T) {
	noResult, unrecoverable := RecoveryNoResult, RecoveryUnrecoverable
	failed := model.Task{Type: "canvas_image", Status: model.TaskStatusFailed}
	with := func(change func(*model.Task)) model.Task { copy := failed; change(&copy); return copy }
	want := func(phase, regenerate, reason string) Outcome {
		return Outcome{Phase: phase, Regenerate: regenerate, Reason: reason}
	}
	cases := []struct {
		name  string
		task  model.Task
		state string
		facts OutcomeFacts
		want  Outcome
	}{
		{"排队", with(func(t *model.Task) { t.Status = model.TaskStatusQueued }), "", OutcomeFacts{}, want("running", "blocked", "task_running")},
		{"重启后过期租约仍在运行", with(func(t *model.Task) {
			t.Status = model.TaskStatusRunning
			past := time.Now().Add(-time.Hour)
			t.LeaseExpiresAt = &past
		}), "", OutcomeFacts{}, want("running", "blocked", "task_running")},
		{"所有输出入库", with(func(t *model.Task) { t.Status = model.TaskStatusSucceeded }), ResultStateReady, OutcomeFacts{}, want("ready", "allowed", "result_ready")},
		{"部分输出未入库", with(func(t *model.Task) { t.Status = model.TaskStatusSucceeded }), ResultStatePendingMaterialization, OutcomeFacts{}, want("fetching", "blocked", "result_fetching")},
		{"下载暂时失败", with(func(t *model.Task) { t.Status = model.TaskStatusSucceeded }), ResultStateFailedRetryable, OutcomeFacts{}, want("retrievable", "blocked", "delivery_pending")},
		{"入库确定失败", with(func(t *model.Task) { t.Status = model.TaskStatusSucceeded }), ResultStateFailedPermanent, OutcomeFacts{}, want("failed", "confirm", "result_unrecoverable")},
		{"尚未派发", failed, "", OutcomeFacts{DispatchState: "not_sent"}, want("failed", "allowed", "task_failed")},
		{"本地准备失败", failed, "", OutcomeFacts{RequestNotSent: true}, want("failed", "allowed", "task_failed")},
		{"阶段文字不参与判断", with(func(t *model.Task) { t.Stage = "请求尚未提交" }), "", OutcomeFacts{}, want("failed", "confirm", "task_failed")},
		{"未发出但上游已有任务号", with(func(t *model.Task) { t.ProviderRequestID = "upstream" }), "", OutcomeFacts{RequestNotSent: true}, want("retrievable", "blocked", "provider_result_pending")},
		{"未发出阶段被接受证据推翻", failed, "", OutcomeFacts{RequestNotSent: true, DispatchState: "accepted"}, want("retrievable", "blocked", "image_recovery_pending")},
		{"明确没建任务", with(func(t *model.Task) { t.RecoveryOutcome = &noResult }), "", OutcomeFacts{DispatchState: "rejected_no_job"}, want("failed", "allowed", "no_result")},
		{"明确拒绝未建任务但已有POST调用日志", failed, "", OutcomeFacts{HasImageReceipt: true, DispatchState: "rejected_no_job"}, want("failed", "allowed", "task_failed")},
		{"明确失败不代表退款", with(func(t *model.Task) { t.RecoveryOutcome = &noResult }), "", OutcomeFacts{DispatchState: "accepted"}, want("failed", "confirm", "no_result")},
		{"旧回执没有路由", failed, "", OutcomeFacts{HasImageReceipt: true}, want("retrievable", "blocked", "image_recovery_pending")},
		{"已接受", failed, "", OutcomeFacts{DispatchState: "accepted"}, want("retrievable", "blocked", "image_recovery_pending")},
		{"同键待重发", failed, "", OutcomeFacts{DispatchState: "submission_unknown", SafeImageReplay: true}, want("retrievable", "blocked", "image_recovery_pending")},
		{"旧提交未确认等待扫描", with(func(t *model.Task) { t.Stage = "submission_unknown" }), "", OutcomeFacts{}, want("retrievable", "blocked", "image_recovery_pending")},
		{"确认取不回", with(func(t *model.Task) { t.RecoveryOutcome = &unrecoverable }), "", OutcomeFacts{HasImageReceipt: true}, want("failed", "confirm", "result_unrecoverable")},
		{"读证据失败不是没结果", failed, "", OutcomeFacts{Unreadable: true}, want("retrievable", "blocked", "evidence_unavailable")},
		{"审核失败确认后可重新生成", with(func(t *model.Task) {
			t.FailureDiagnostics = &model.TaskFailureDiagnostics{ProviderCode: "SAFETY.INPUT.TEXT"}
		}), "", OutcomeFacts{}, want("failed", "confirm", "input_rejected")},
		{"内容审核失败不当成没扣钱", with(func(t *model.Task) {
			t.FailureDiagnostics = &model.TaskFailureDiagnostics{ProviderCode: "content_policy_violation"}
		}), "", OutcomeFacts{DispatchState: "not_sent"}, want("failed", "confirm", "input_rejected")},
		{"深度本地不收费", with(func(t *model.Task) { t.Type = model.TaskTypeDepthCapture }), "", OutcomeFacts{}, want("failed", "allowed", "task_failed")},
		{"计费不明", failed, "", OutcomeFacts{}, want("failed", "confirm", "task_failed")},
		{"接受证据覆盖旧未发出阶段", with(func(t *model.Task) { t.Stage = "request_not_sent"; t.RecoveryOutcome = &noResult }), "", OutcomeFacts{DispatchState: "accepted", ImageResponseAccepted: true}, want("failed", "confirm", "no_result")},
		{"视频沿用原任务查询", with(func(t *model.Task) { t.Type = "canvas_video"; t.ProviderRequestID = "original" }), "", OutcomeFacts{}, want("retrievable", "blocked", "provider_result_pending")},
		{"视频确认上游失败", with(func(t *model.Task) {
			t.Type = "canvas_video"
			t.ProviderRequestID = "original"
			t.RecoveryOutcome = &noResult
		}), "", OutcomeFacts{}, want("failed", "confirm", "no_result")},
		{"视频过保或无法取回", with(func(t *model.Task) {
			t.Type = "canvas_video"
			t.ProviderRequestID = "original"
			t.RecoveryOutcome = &unrecoverable
		}), "", OutcomeFacts{}, want("failed", "confirm", "result_unrecoverable")},
		{"图片超分沿用上游查询", with(func(t *model.Task) {
			t.Type = "canvas_image"
			t.Model = "topaz-standard-v2"
			t.ProviderRequestID = "upscale-req-1"
		}), "", OutcomeFacts{}, want("retrievable", "blocked", "provider_result_pending")},
		{"图片超分确认无结果", with(func(t *model.Task) {
			t.Type = "canvas_image"
			t.Model = "topaz-standard-v2"
			t.ProviderRequestID = "upscale-req-1"
			t.RecoveryOutcome = &noResult
		}), "", OutcomeFacts{}, want("failed", "confirm", "no_result")},
		{"图片超分确认取不回", with(func(t *model.Task) {
			t.Type = "canvas_image"
			t.Model = "topaz-standard-v2"
			t.ProviderRequestID = "upscale-req-1"
			t.RecoveryOutcome = &unrecoverable
		}), "", OutcomeFacts{}, want("failed", "confirm", "result_unrecoverable")},
		{"BeefTV视频已结算失败允许直接重生成", with(func(t *model.Task) {
			u := "failed"
			t.Type = "canvas_video"
			t.ProviderRequestID = "vid-failed"
			t.RecoveryOutcome = &noResult
			t.BeefUsageState = &u
		}), "", OutcomeFacts{}, want("failed", "allowed", "no_result")},
		{"BeefTV视频待结算阻塞重生成并透传截止时间", with(func(t *model.Task) {
			u := "pending"
			dl := "2026-04-20T12:00:00Z"
			t.Type = "canvas_video"
			t.ProviderRequestID = "vid-pending"
			t.RecoveryOutcome = &noResult
			t.BeefUsageState = &u
			t.BeefReconcileDeadline = &dl
		}), "", OutcomeFacts{}, Outcome{Phase: "failed", Regenerate: "blocked", Reason: "settlement_pending", ReconcileDeadline: "2026-04-20T12:00:00Z"}},
		{"BeefTV视频已扣费可取回阶段阻塞重生成", with(func(t *model.Task) {
			u := "completed"
			t.Type = "canvas_video"
			t.ProviderRequestID = "vid-completed"
			t.BeefUsageState = &u
		}), "", OutcomeFacts{}, want("retrievable", "blocked", "provider_result_pending")},
		{"BeefTV视频已扣费但结果无法取回需确认重生成", with(func(t *model.Task) {
			u := "completed"
			t.Type = "canvas_video"
			t.ProviderRequestID = "vid-completed"
			t.RecoveryOutcome = &unrecoverable
			t.BeefUsageState = &u
		}), "", OutcomeFacts{}, want("failed", "confirm", "charged_result_unrecoverable")},
		{"BeefTV图片已退款允许直接重生成", with(func(t *model.Task) {
			b := "refunded"
			t.ImageJobID = "img-job-1"
			t.RecoveryOutcome = &noResult
			t.BeefBillingState = &b
		}), "", OutcomeFacts{DispatchState: "accepted"}, want("failed", "allowed", "no_result")},
		{"BeefTV图片已扣费可取回阶段阻塞重生成", with(func(t *model.Task) {
			b := "settled"
			t.ImageJobID = "img-job-2"
			t.BeefBillingState = &b
		}), "", OutcomeFacts{DispatchState: "accepted"}, want("retrievable", "blocked", "image_recovery_pending")},
		{"BeefTV图片已扣费但结果无法取回需确认重生成", with(func(t *model.Task) {
			b := "settled"
			t.ImageJobID = "img-job-2"
			t.RecoveryOutcome = &noResult
			t.BeefBillingState = &b
		}), "", OutcomeFacts{DispatchState: "accepted"}, want("failed", "confirm", "charged_result_unrecoverable")},
		{"BeefTV图片待结算空串阻塞重生成并透传截止时间", with(func(t *model.Task) {
			b := ""
			dl := "2026-04-20T12:30:00Z"
			t.ImageJobID = "img-job-3"
			t.RecoveryOutcome = &noResult
			t.BeefBillingState = &b
			t.BeefReconcileDeadline = &dl
		}), "", OutcomeFacts{DispatchState: "accepted"}, Outcome{Phase: "failed", Regenerate: "blocked", Reason: "settlement_pending", ReconcileDeadline: "2026-04-20T12:30:00Z"}},
		{"BeefTV图片缺失billing_state键按第三方兜底需确认", with(func(t *model.Task) {
			t.ImageJobID = "img-job-no-billing-key"
			t.RecoveryOutcome = &unrecoverable
			t.BeefBillingState = nil
		}), "", OutcomeFacts{DispatchState: "accepted"}, want("failed", "confirm", "result_unrecoverable")},
		{"BeefTV图片无job_id且未发出按第三方兜底允许重生成", with(func(t *model.Task) {
			t.BeefBillingState = nil
		}), "", OutcomeFacts{DispatchState: "not_sent"}, want("failed", "allowed", "task_failed")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := tc.task
			if got := ComputeOutcome(tc.task, tc.state, tc.facts); got != tc.want {
				t.Fatalf("got=%+v want=%+v", got, tc.want)
			}
			if !reflect.DeepEqual(before, tc.task) {
				t.Fatal("只读投影修改了任务")
			}
			tc.task.Error = "content policy violated: context deadline exceeded 已退款"
			if got := ComputeOutcome(tc.task, tc.state, tc.facts); got != tc.want {
				t.Fatalf("投影解析了错误文案: %+v", got)
			}
		})
	}
}
