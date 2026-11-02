package app

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/gorm"
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

func TestImageReceiptRecoveryConclusionUsesHTTPStatus(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"temporary", 503, `{"error":{"code":"internal_error"}}`, ""},
		{"business-failure", 200, `{"error":{"code":"generation_failed"}}`, localtask.RecoveryNoResult},
		{"unauthorized", 401, `{"error":{"code":"token_revoked"}}`, localtask.RecoveryUnrecoverable},
		{"forbidden", 403, `{"error":{"code":"forbidden"}}`, localtask.RecoveryUnrecoverable},
		{"pending", 409, `{"error":{"code":"image_submission_pending"}}`, ""},
		{"unavailable", 503, `{"error":{"code":"image_result_unavailable"}}`, ""},
		{"expired", 410, `{"error":{"code":"image_result_expired"}}`, localtask.RecoveryUnrecoverable},
		{"conflict", 409, `{"error":{"code":"idempotency_conflict"}}`, localtask.RecoveryUnrecoverable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := imageReceiptConclusion(tc.status, tc.body); got != tc.want {
				t.Fatalf("结论=%q want=%q", got, tc.want)
			}
		})
	}
}

func TestAutomaticImageRecoveryTemporaryReceiptKeepsSameKeyRecovery(t *testing.T) {
	for _, status := range []int{http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusServiceUnavailable} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			s, db, task, row, original := imageSubmissionFixture(t, false)
			pinImageRecoveryChannel(t, s, db, row)
			task.Status, task.LeaseOwner = model.TaskStatusFailed, "manual-recovery:temporary-receipt"
			if err := db.Save(&task).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.ApiCallLog{
				ID: "temporary-receipt", UserID: task.UserID, TaskID: task.ID,
				Capability: "image", RequestKind: "create", Method: "POST",
				StatusCode: status, Status: model.ApiCallStatusFailed,
				ResponseBody: `{"error":{"code":"internal_error"}}`, StartedAt: time.Now(),
			}).Error; err != nil {
				t.Fatal(err)
			}
			wire, err := s.imageSubmissionWire(row)
			if err != nil {
				t.Fatal(err)
			}
			sends := 0
			for pass := 0; pass < 3; pass++ {
				result, outcome, err := s.failedImageResultWith(context.Background(), task, func(req *http.Request, admit func() error) ([]byte, string, error) {
					if err := admit(); err != nil {
						return nil, "", err
					}
					sends++
					body, readErr := io.ReadAll(req.Body)
					if readErr != nil || string(body) != string(original) || req.URL.String() != wire.URL || req.Header.Get("Idempotency-Key") != wire.Header.Get("Idempotency-Key") || req.Header.Get("Authorization") != wire.Header.Get("Authorization") {
						t.Error("临时回执后的取回改变了原身份、原键或原请求")
					}
					if pass == 2 {
						return []byte(`{"data":[{"url":"https://example.invalid/recovered.png"}]}`), "application/json", nil
					}
					return nil, "", providerHTTPError{StatusCode: http.StatusServiceUnavailable, Body: `{"error":{"code":"internal_error"}}`}
				})
				if pass == 2 {
					if err != nil || outcome != "" || len(result) == 0 {
						t.Fatalf("临时故障后未能取回: outcome=%q err=%v", outcome, err)
					}
					if err := s.saveTaskCompletionWithinStorageQuota(&task, result, nil, false); err != nil {
						t.Fatal(err)
					}
					continue
				}
				if err == nil || outcome != "" || len(result) != 0 {
					t.Fatalf("临时回执误判为终态: pass=%d sends=%d outcome=%q err=%v", pass, sends, outcome, err)
				}
			}
			stored, err := s.repo.Task(task.ID)
			if err != nil || sends != 3 || stored.RecoveryOutcome != nil || stored.Status != model.TaskStatusSucceeded || stored.RouteRun != task.RouteRun {
				t.Fatalf("原任务停止恢复: sends=%d task=%+v err=%v", sends, stored, err)
			}
		})
	}
}

func TestTaskOutcomeReadsNeverLoadFrozenImageRequest(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, false)
	op := "canvas:small-outcome"
	task.ClientOperationID, task.ProjectID = &op, "outcome-canvas"
	if err := db.Save(&task).Error; err != nil {
		t.Fatal(err)
	}
	// 故意放入不能解密的大快照；状态读取既不需要载入它，也不能依赖解析结果。
	row.RequestCipher = strings.Repeat("opaque-media-snapshot", 64*1024)
	if err := db.Save(row).Error; err != nil {
		t.Fatal(err)
	}
	other := task
	other.ID, other.ClientOperationID = "second-image-task", nil
	attempt := model.RouteAttempt{ID: "second-image-attempt", TaskID: other.ID, DispatchState: "submission_unknown"}
	otherRow := *row
	otherRow.TaskID, otherRow.AttemptID = other.ID, attempt.ID
	for _, v := range []any{&other, &attempt, &otherRow} {
		if err := db.Create(v).Error; err != nil {
			t.Fatal(err)
		}
	}
	var queries atomic.Int32
	if err := db.Callback().Query().After("gorm:query").Register("test:small-image-evidence", func(tx *gorm.DB) {
		if tx.Statement.Table != "image_submissions" {
			return
		}
		queries.Add(1)
		selectSQL := strings.SplitN(strings.ToLower(tx.Statement.SQL.String()), " from ", 2)[0]
		if strings.Contains(selectSQL, "request_cipher") || strings.HasSuffix(selectSQL, "*") {
			t.Error("任务读取查询了完整冻结请求，而不是小字段")
		}
	}); err != nil {
		t.Fatal(err)
	}
	reads := []struct {
		name string
		read func() error
	}{
		{"detail", func() error { _, err := s.Task(task.UserID, task.ID); return err }},
		{"list", func() error {
			items, err := s.Tasks(task.UserID, 100)
			if err == nil && len(items) != 2 {
				t.Errorf("未覆盖两项批量读取: %d", len(items))
			}
			return err
		}},
		{"by-operation", func() error { _, err := s.TaskByClientOperation(task.UserID, task.ProjectID, op); return err }},
	}
	for _, status := range []model.TaskStatus{model.TaskStatusFailed, model.TaskStatusSucceeded, model.TaskStatusRunning, model.TaskStatusQueued} {
		if err := db.Model(&model.Task{}).Where("id IN ?", []string{task.ID, other.ID}).Update("status", status).Error; err != nil {
			t.Fatal(err)
		}
		for _, read := range reads {
			t.Run(string(status)+"/"+read.name, func(t *testing.T) {
				queries.Store(0)
				if err := read.read(); err != nil {
					t.Fatal(err)
				}
				want := int32(0)
				if status == model.TaskStatusFailed {
					want = 1 // 两个任务也只有一次小字段提交证据查询。
				}
				if queries.Load() != want {
					t.Fatalf("提交证据查询数=%d want=%d", queries.Load(), want)
				}
			})
		}
	}
}
