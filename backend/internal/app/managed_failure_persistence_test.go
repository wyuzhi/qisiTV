package app

import (
	"strings"
	"testing"

	"qisitv/backend/internal/beeftv"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// 托管任务的失败类目在失败时算一次并随任务保存；读取时不能按保存后的中文文案再猜。
func TestManagedFailureCategoryAndServerMessageSurviveTaskRead(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.TaskTextDelta{}, &model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	svc := NewLocal(repository.New(db), t.TempDir())
	task := model.Task{ID: "managed-failure", UserID: "local", Type: "canvas_image", Status: model.TaskStatusRunning, Stage: "上游生成中"}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	managedErr := &beeftv.MediaTaskError{
		Code:        "media_generation_failed",
		Category:    "quota_user",
		Message:     "账户余额不足，请充值后重试。",
		Reason:      "insufficient_user_quota",
		UserMessage: "账户余额不足，请充值后重试。当前剩余额度: ¥0.50, 本次预计需要: ¥0.60",
		RequestID:   "req_fixture_quota_user",
	}
	if err := svc.terminalCoordinator().HandleExecutionFailure(&task, managedErr, false, false); err == nil {
		t.Fatal("managed failure must stay an error for the worker")
	}
	stored, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ErrorCode != "quota_user" || !strings.HasPrefix(stored.Error, "账户余额不足，请充值后重试。当前剩余额度: ¥0.50, 本次预计需要: ¥0.60") {
		t.Fatalf("stored failure = code %q text %q", stored.ErrorCode, stored.Error)
	}
	detail := taskForOutput(*stored)
	summary := taskSummaryForOutput(*stored)
	for _, got := range []struct{ code, text string }{{detail.ErrorCode, detail.Error}, {summary.ErrorCode, summary.Error}} {
		if got.code != "quota_user" || got.text != stored.Error {
			t.Fatalf("read-back reclassified failure: code %q text %q", got.code, got.text)
		}
		if strings.Contains(got.text, "模型服务拒绝了计费或额度相关请求") {
			t.Fatalf("read-back replaced the server sentence with the quota_unknown copy: %q", got.text)
		}
	}

	// 画布工作流显示同一任务时用同一份投影，不能和任务列表说法不同。
	if got := safePersistedFailureMessage(stored.Error, stored.Stage, stored.ErrorCode); got != stored.Error {
		t.Fatalf("workflow failure text differs from task list: %q", got)
	}

	// 明确保存为 unknown 的失败也是结论：原样返回文案，不再按文案猜成额度类。
	savedUnknown := model.Task{ID: "saved-unknown", UserID: "local", Type: "canvas_image", Status: model.TaskStatusFailed, Error: "账户余额不足，请充值后重试。", ErrorCode: "unknown"}
	if got := taskSummaryForOutput(savedUnknown); got.ErrorCode != "" || got.Error != savedUnknown.Error {
		t.Fatalf("saved unknown was reclassified: code %q text %q", got.ErrorCode, got.Error)
	}

	// 未确认阶段即使保存了类目，读取时仍给出按阶段的固定文案。
	uncertain := model.Task{ID: "uncertain-failure", UserID: "local", Type: "canvas_image", Status: model.TaskStatusFailed, Stage: "submission_unknown", Error: "Post: net/http: TLS handshake timeout", ErrorCode: "submission_uncertain"}
	if err := db.Create(&uncertain).Error; err != nil {
		t.Fatal(err)
	}
	if got := taskSummaryForOutput(uncertain); got.ErrorCode != "submission_uncertain" || !strings.Contains(got.Error, "尚未确认") {
		t.Fatalf("submission_unknown read-back changed: code %q text %q", got.ErrorCode, got.Error)
	}

	// 旧任务没有保存类目时，仍按旧文案归类，行为不变。
	legacy := model.Task{ID: "legacy-failure", UserID: "local", Type: "canvas_image", Status: model.TaskStatusFailed, Error: "上游模型服务返回 HTTP 402：当前账户余额不足"}
	if err := db.Create(&legacy).Error; err != nil {
		t.Fatal(err)
	}
	if code := taskSummaryForOutput(legacy).ErrorCode; code != "quota_unknown" {
		t.Fatalf("legacy read-back changed: %q", code)
	}
	if code := taskForOutput(legacy).ErrorCode; code != "quota_unknown" {
		t.Fatalf("legacy detail read-back changed: %q", code)
	}
}

// 准备阶段的失败同样在写终态时保存类目，而不是等读取时按文案重猜。
func TestPreparationFailurePersistsCategory(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.TaskTextDelta{}, &model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	svc := NewLocal(repository.New(db), t.TempDir())
	task := model.Task{ID: "prep-failure", UserID: "local", Type: "canvas_image", Status: model.TaskStatusRunning}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	_ = svc.terminalCoordinator().MarkPreparationFailure(&task, "路由准备失败", &beeftv.MediaTaskError{
		Code: "media_submission_rejected", Category: "authorization", Message: "no key",
	}, false, "")
	stored, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ErrorCode != "auth" {
		t.Fatalf("preparation failure category = %q", stored.ErrorCode)
	}
	if code := taskSummaryForOutput(*stored).ErrorCode; code != "auth" {
		t.Fatalf("preparation failure read-back = %q", code)
	}
}
