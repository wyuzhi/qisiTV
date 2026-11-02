package app

import (
	"context"
	"fmt"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
	"testing"
	"time"
)

func TestImageRecoveryScanCoversLegacyAndKeepsCursorPastContendedTasks(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	s, db, _, _ := creationTestService(t)
	for _, id := range []string{"a", "b", "c", "d"} {
		task := model.Task{ID: id, UserID: "user", Type: "canvas_image", Status: model.TaskStatusFailed, Stage: "任务失败", InputJSON: `{"mode":"image"}`}
		if err := db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
		if id == "d" {
			if err := db.Create(&model.RouteAttempt{ID: "accepted", TaskID: id, DispatchState: "accepted"}).Error; err != nil {
				t.Fatal(err)
			}
			continue
		}
		r := model.ApiCallLog{ID: "receipt-" + id, UserID: "user", TaskID: id, Capability: "image", RequestKind: "create", Method: "POST", Path: "/v1/images/generations", APIFormat: "openai", Status: model.ApiCallStatusSucceeded, StatusCode: 200, ResponseBody: `{"data":[{"url":"http://127.0.0.1:1/original.png"}]}`}
		if err := db.Create(&r).Error; err != nil {
			t.Fatal(err)
		}
		if id == "a" || id == "b" {
			if err := s.repo.ClaimFailedTaskProviderRecovery(id, "user", "manual-recovery:contended", time.Minute); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, kind := range []string{"canvas_video", "canvas_image"} {
		for _, status := range []model.TaskStatus{model.TaskStatusRunning, model.TaskStatusCancelled} {
			if err := db.Create(&model.Task{ID: fmt.Sprintf("ignored-%s-%s", kind, status), UserID: "user", Type: kind, Status: status, Stage: "submission_unknown"}).Error; err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := db.Create(&model.Task{ID: "other-owner-receipt", UserID: "user", Type: "canvas_image", Status: model.TaskStatusFailed}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ApiCallLog{ID: "foreign", TaskID: "other-owner-receipt", UserID: "other", Capability: "image", RequestKind: "create", Method: "POST"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.recoverFailedImages(context.Background(), 2); err != nil {
		t.Fatal(err)
	}
	if s.mediaAttempts().ImageRecoveryCursor() != "b" {
		t.Fatalf("cursor=%s", s.mediaAttempts().ImageRecoveryCursor())
	}
	if err := s.recoverFailedImages(context.Background(), 2); err != nil {
		t.Fatal(err)
	}
	c, _ := s.repo.Task("c")
	d, _ := s.repo.Task("d")
	if c.Status != model.TaskStatusSucceeded || d.RecoveryOutcome == nil {
		t.Fatalf("历史回执或已接受但无回执任务被漏掉: c=%+v d=%+v", c, d)
	}
	found, err := s.repo.FailedImagesForRecovery("d", 20)
	if err != nil || len(found) != 0 {
		t.Fatalf("扫描误包含运行中、取消、视频或异主回执任务: %+v %v", found, err)
	}
}

func TestRunningImageLeaseSurvivesDatabaseReopenWithoutCancellation(t *testing.T) {
	s, db, task, _, _ := imageSubmissionFixture(t, false)
	past := time.Now().Add(-time.Minute)
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("lease_expires_at", past).Error; err != nil {
		t.Fatal(err)
	}
	dsn := db.Dialector.(*sqlite.Dialector).DSN
	closeDB(t, db)
	reopened, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer closeDB(t, reopened)
	restarted := &Service{repo: repository.New(reopened), dataDir: s.dataDir, mode: serviceModeLocal}
	// 同一个持久任务由另一 runtime 领取，既不取消，也不新建路由世代。
	claimed, err := restarted.repo.ClaimNextTask("restarted-worker", time.Minute)
	if err != nil || claimed == nil || claimed.ID != task.ID || claimed.Status != model.TaskStatusRunning || claimed.RouteRun != task.RouteRun {
		t.Fatalf("重启领取=%+v %v", claimed, err)
	}
	got, err := restarted.Task(task.UserID, task.ID)
	if err != nil || got.Status != model.TaskStatusRunning || got.Outcome.Phase != "running" {
		t.Fatalf("重启投影=%+v %v", got, err)
	}
}
