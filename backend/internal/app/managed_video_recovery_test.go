package app

import (
	"context"
	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
	"testing"
	"time"
)

func TestManagedVideoDoesNotInferSettlementOrExpiry(t *testing.T) {
	task := model.Task{ID: "managed-no-receipt", UserID: "user", Type: "canvas_video", Status: model.TaskStatusFailed, CreatedAt: time.Now().Add(-48 * time.Hour), InputJSON: `{"mode":"video","config":{"credentialRef":"beeftv","apiKey":"enc:unread"}}`}
	if videoTaskPastRetentionWindow(task, time.Now()) {
		t.Fatal("local clock expired an API task")
	}
	for _, cause := range []error{providerHTTPError{StatusCode: 404}, context.DeadlineExceeded, context.Canceled} {
		if outcome := classifyFailedVideoQueryOutcome(task, "", cause); outcome != "" {
			t.Fatalf("unknown query inferred %s", outcome)
		}
	}
	if outcome := classifyFailedVideoQueryOutcome(task, "failed", providerHTTPError{StatusCode: 500}); outcome != "" {
		t.Fatal("missing settlement was treated as a known outcome")
	}
	svc, db, _, _ := creationTestService(t)
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	svc.recordMissingVideoReceiptOutcome(&task, task.UserID)
	stored, err := svc.repo.Task(task.ID)
	if err != nil || stored.RecoveryOutcome != nil || stored.NextPollAt == nil {
		t.Fatalf("unknown receipt was closed: %+v err=%v", stored, err)
	}
	task.InputJSON = `{"mode":"video","config":{"channelId":"beeftv","apiKey":"enc:unread"}}`
	if videoTaskPastRetentionWindow(task, time.Now()) {
		t.Fatal("historical built-in channel expired locally")
	}
	task.InputJSON = `{"mode":"video","config":{"baseUrl":"https://beeftv.app","apiKey":"enc:third-party-key"}}`
	if !videoTaskPastRetentionWindow(task, time.Now()) {
		t.Fatal("BYOK retention behavior changed")
	}
}

// 重构前的托管视频任务从未收到结算状态；一个月后 BeefTV 和上游都不会再给结果，
// 本地应结束它，允许确认后重新生成，而不是每 2 分钟查一次、永远停在「继续取回」。
func TestManagedVideoUnreportedForAWeekEndsLocally(t *testing.T) {
	old := model.Task{ID: "managed-september", UserID: "user", Type: "canvas_video", Status: model.TaskStatusFailed, CreatedAt: time.Now().Add(-30 * 24 * time.Hour), ProviderRequestID: "task_old", InputJSON: `{"mode":"video","config":{"channelId":"beeftv","apiKey":"enc:unread"}}`}
	if !videoTaskPastRetentionWindow(old, time.Now()) {
		t.Fatal("month-old unreported task never expires")
	}
	if outcome := classifyFailedVideoQueryOutcome(old, "", providerHTTPError{StatusCode: 500}); outcome != localtask.RecoveryUnrecoverable {
		t.Fatalf("outcome=%q", outcome)
	}
	reserved := "reserved"
	reported := old
	reported.BeefBillingState = &reserved
	if videoTaskPastRetentionWindow(reported, time.Now()) || classifyFailedVideoQueryOutcome(reported, "", providerHTTPError{StatusCode: 400}) != "" {
		t.Fatal("task with API settlement facts was concluded locally")
	}
	recent := old
	recent.ID = "managed-recent"
	recent.CreatedAt = time.Now().Add(-48 * time.Hour)
	if videoTaskPastRetentionWindow(recent, time.Now()) {
		t.Fatal("recent API task expired on the local clock")
	}
	if outcome := classifyFailedVideoQueryOutcome(recent, "failed", &beeftv.MediaTaskError{Code: "media_submission_rejected"}); outcome != localtask.RecoveryNoResult {
		t.Fatalf("rejected submission outcome=%q, want %q", outcome, localtask.RecoveryNoResult)
	}
	if outcome := classifyFailedVideoQueryOutcome(recent, "", providerHTTPError{StatusCode: 400, Body: `{"error":{"message":"invalid_video_request"}}`}); outcome != localtask.RecoveryNoResult {
		t.Fatalf("unreported 400 query outcome=%q, want %q", outcome, localtask.RecoveryNoResult)
	}
	for _, status := range []string{"completed", "succeeded"} {
		if outcome := classifyFailedVideoQueryOutcome(recent, status, providerHTTPError{StatusCode: 400}); outcome != "" {
			t.Fatalf("download 400 after %s misclassified as %q", status, outcome)
		}
	}
	svc, db, _, _ := creationTestService(t)
	if err := db.Create(&recent).Error; err != nil {
		t.Fatal(err)
	}
	noResult := classifyFailedVideoQueryOutcome(recent, "", providerHTTPError{StatusCode: 400})
	if err := svc.repo.FinishFailedVideoRecovery(recent, &noResult, nil); err != nil {
		t.Fatal(err)
	}
	recentStored, err := svc.repo.Task(recent.ID)
	if err != nil || recentStored.RecoveryOutcome == nil || *recentStored.RecoveryOutcome != localtask.RecoveryNoResult || recentStored.NextPollAt != nil || videoRecoveryNeedsPolling(*recentStored) {
		t.Fatalf("recent 400 task still polled: %+v err=%v", recentStored, err)
	}
	if err := db.Create(&old).Error; err != nil {
		t.Fatal(err)
	}
	svc.recordUnrecoverableVideoOutcome(&old, old.UserID)
	stored, err := svc.repo.Task(old.ID)
	if err != nil || stored.RecoveryOutcome == nil || *stored.RecoveryOutcome != localtask.RecoveryUnrecoverable || videoRecoveryNeedsPolling(*stored) {
		t.Fatalf("old task still polled: %+v err=%v", stored, err)
	}
	if outcome := localtask.ComputeOutcome(*stored, "", localtask.OutcomeFacts{}); outcome.Phase != "failed" || outcome.Regenerate == "blocked" {
		t.Fatalf("outcome=%+v, want a failed task that can be regenerated", outcome)
	}
}
