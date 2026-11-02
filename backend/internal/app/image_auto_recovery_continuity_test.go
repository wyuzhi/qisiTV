package app

import (
	"context"
	"net/http"
	"testing"
	"time"

	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

func TestAutomaticImageRecoveryContinuesSameKeyAfterAmbiguousTransportLogs(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, false)
	pinImageRecoveryChannel(t, s, db, row)
	task.Status = model.TaskStatusFailed
	task.LeaseOwner = "manual-recovery:continuity"
	until := time.Now().Add(time.Minute)
	task.LeaseExpiresAt = &until
	if err := db.Save(&task).Error; err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"send-1", "send-2"} {
		if err := db.Create(&model.ApiCallLog{ID: id, UserID: task.UserID, TaskID: task.ID, Capability: "image", RequestKind: "create", Method: "POST", StatusCode: 0}).Error; err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		_, outcome, err := s.failedImageResultWith(context.Background(), task, func(req *http.Request, admit func() error) ([]byte, string, error) {
			if err := admit(); err != nil {
				return nil, "", err
			}
			return nil, "", providerHTTPError{StatusCode: 409, Body: `{"error":{"code":"image_submission_pending"}}`}
		})
		if err == nil || outcome != "" {
			t.Fatalf("暂时等待被错误写成终态: outcome=%s err=%v", outcome, err)
		}
	}
	stored, err := s.repo.ImageSubmission(row.AttemptID, row.TaskID, row.UserID)
	if err != nil || stored.SendCount != 2 {
		t.Fatalf("未沿用原提交: row=%+v err=%v", stored, err)
	}
	_, outcome, err := s.failedImageResultWith(context.Background(), task, func(req *http.Request, admit func() error) ([]byte, string, error) {
		if err := admit(); err != nil {
			return nil, "", err
		}
		return nil, "", providerHTTPError{StatusCode: 410, IdempotencyReplayed: true, Body: `{"error":{"code":"image_result_expired"}}`}
	})
	if err != nil || outcome != localtask.RecoveryUnrecoverable {
		t.Fatalf("过期结论=%s err=%v", outcome, err)
	}
}

func TestAutomaticImageRecoveryDoesNotBindReceiptFromPreviousRouteRun(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, false)
	pinImageRecoveryChannel(t, s, db, row)
	task.Status = model.TaskStatusFailed
	task.LeaseOwner = "manual-recovery:new-run"
	until := time.Now().Add(time.Minute)
	task.LeaseExpiresAt = &until
	if err := db.Save(&task).Error; err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if err := db.Model(&model.RouteAttempt{}).Where("task_id = ?", task.ID).Update("started_at", started).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ApiCallLog{ID: "old-success", UserID: task.UserID, TaskID: task.ID, Capability: "image", RequestKind: "create", Method: "POST", StatusCode: 200, Status: model.ApiCallStatusSucceeded, APIFormat: "openai", Path: "/v1/images/generations", ResponseBody: `{"data":[{"url":"http://127.0.0.1:1/old.png"}]}`, StartedAt: started.Add(-time.Hour)}).Error; err != nil {
		t.Fatal(err)
	}
	sends := 0
	result, outcome, err := s.failedImageResultWith(context.Background(), task, func(req *http.Request, admit func() error) ([]byte, string, error) {
		sends++
		if err := admit(); err != nil {
			return nil, "", err
		}
		return []byte(`{"error":{"code":"generation_failed","message":"no image"}}`), "application/json", nil
	})
	if sends != 1 || len(result) != 0 || outcome != localtask.RecoveryNoResult || err != nil {
		t.Fatalf("误用上一轮成功回执: sends=%d result=%s outcome=%s err=%v", sends, result, outcome, err)
	}
}
