package operations_test

import (
	"strings"
	"testing"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/operations"
)

func TestTaskCancelReportsBillingCaveatAndReplays(t *testing.T) {
	h := newHarness(t)
	task := model.Task{ID: "task-cancel-1", UserID: h.userID, Status: model.TaskStatusQueued, Stage: "等待队列调度", Type: "canvas_image"}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}

	caller := operations.ExternalCaller(false)
	result, err := h.execute(t, caller, "task.cancel", "cancel-op-1", map[string]any{"taskId": task.ID})
	if err != nil {
		t.Fatalf("task.cancel: %v", err)
	}
	payload, ok := result.Result.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result: %#v", result.Result)
	}
	if payload["status"] != string(model.TaskStatusCancelled) || payload["previousStatus"] != string(model.TaskStatusQueued) {
		t.Fatalf("unexpected cancel result: %#v", payload)
	}
	note, _ := payload["note"].(string)
	if !strings.Contains(note, "可能已经计费") || !strings.Contains(note, "不承诺退款") {
		t.Fatalf("cancel note must state the billing caveat, got %q", note)
	}

	stored, err := h.service.Task(h.userID, task.ID)
	if err != nil || stored.Status != model.TaskStatusCancelled {
		t.Fatalf("task was not cancelled: %+v (err=%v)", stored, err)
	}

	replayed, err := h.execute(t, caller, "task.cancel", "cancel-op-1", map[string]any{"taskId": task.ID})
	if err != nil {
		t.Fatalf("replay task.cancel: %v", err)
	}
	if !replayed.Replayed {
		t.Fatal("same operationId must replay the stored cancel result")
	}
}

func TestTaskCancelAlreadyCancelledAndReadOnlyClient(t *testing.T) {
	h := newHarness(t)
	task := model.Task{ID: "task-cancel-2", UserID: h.userID, Status: model.TaskStatusCancelled, Stage: "任务已取消", Type: "canvas_image"}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}

	result, err := h.execute(t, operations.ExternalCaller(false), "task.cancel", "cancel-op-2", map[string]any{"taskId": task.ID})
	if err != nil {
		t.Fatalf("cancel already-cancelled task: %v", err)
	}
	note, _ := result.Result.(map[string]any)["note"].(string)
	if !strings.Contains(note, "此前已经取消") {
		t.Fatalf("already-cancelled note = %q", note)
	}

	_, err = h.execute(t, operations.ExternalCaller(true), "task.cancel", "cancel-op-readonly", map[string]any{"taskId": task.ID})
	if got := opErr(t, err); got.Code != operations.CodeReadOnly {
		t.Fatalf("read-only client cancel must be rejected, got %+v", got)
	}
}

func TestTaskCancelRejectsOtherUsersTask(t *testing.T) {
	h := newHarness(t)
	task := model.Task{ID: "task-cancel-other", UserID: "other-user", Status: model.TaskStatusQueued, Stage: "等待队列调度", Type: "canvas_image"}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	_, err := h.execute(t, operations.ExternalCaller(false), "task.cancel", "cancel-op-other", map[string]any{"taskId": task.ID})
	if got := opErr(t, err); got.Code != operations.CodeNotFound {
		t.Fatalf("other user's task must not be cancellable, got %+v", got)
	}
}

func TestAgentTaskAndWriteOpsStayOutOfAssistantCatalog(t *testing.T) {
	h := newHarness(t)
	visible := map[string]bool{}
	for _, descriptor := range h.registry.List(h.assistant()) {
		visible[descriptor.ID] = true
	}
	for _, id := range []string{"task.cancel", "canvas.generation.orders", "canvas.external.write.list", "canvas.external.write.undo"} {
		if visible[id] {
			t.Fatalf("内置助手不应看到外部 Agent 操作 %s", id)
		}
	}
	_, err := h.execute(t, h.assistant(), "task.cancel", "assistant-cancel", map[string]any{"taskId": "anything"})
	if got := opErr(t, err); got.Code != operations.CodePermissionDenied || got.Reason != "scope_denied" {
		t.Fatalf("assistant cancel must be denied, got %+v", got)
	}
}

func TestTaskCancelRejectsFailedTaskAndRetriesSameOperationID(t *testing.T) {
	h := newHarness(t)
	task := model.Task{ID: "task-cancel-failed", UserID: h.userID, Status: model.TaskStatusFailed, Stage: "生成失败", Type: "canvas_image"}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	params := map[string]any{"taskId": task.ID}
	_, err := h.execute(t, operations.ExternalCaller(false), "task.cancel", "cancel-retry-1", params)
	if got := opErr(t, err); got.Code != operations.CodeConflict || got.Reason != "task_not_cancellable" {
		t.Fatalf("failed task must be rejected as not cancellable, got %+v", got)
	}
	// 失败后同一 operationId 必须能重试，而不是卡在 operation_in_progress。
	if err := h.service.Database().Model(&model.Task{}).Where("id = ?", task.ID).
		Updates(map[string]any{"status": model.TaskStatusQueued, "stage": "等待队列调度"}).Error; err != nil {
		t.Fatal(err)
	}
	result, err := h.execute(t, operations.ExternalCaller(false), "task.cancel", "cancel-retry-1", params)
	if err != nil {
		t.Fatalf("same operationId retry after failure: %v", err)
	}
	if result.Replayed {
		t.Fatal("失败后重试必须重新执行，不能标记为回放")
	}
	if payload, _ := result.Result.(map[string]any); payload["status"] != string(model.TaskStatusCancelled) {
		t.Fatalf("retry did not cancel: %#v", result.Result)
	}
}

func TestTaskCancelPausesSucceededDelivery(t *testing.T) {
	h := newHarness(t)
	task := model.Task{ID: "task-cancel-succeeded", UserID: h.userID, Status: model.TaskStatusSucceeded, Stage: "生成完成", Type: "canvas_image", ResultJSON: `{"images":[{"url":"https://example.com/image.png"}]}`}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	result, err := h.execute(t, operations.ExternalCaller(false), "task.cancel", "cancel-succeeded-1", map[string]any{"taskId": task.ID})
	if err != nil {
		t.Fatalf("cancel succeeded image delivery: %v", err)
	}
	payload, _ := result.Result.(map[string]any)
	note, _ := payload["note"].(string)
	if payload["status"] != string(model.TaskStatusSucceeded) || !strings.Contains(note, "已经完成") || !strings.Contains(note, "停止") {
		t.Fatalf("unexpected succeeded cancel result: %#v", payload)
	}
}

func TestTaskCancelRejectsAlreadyDeliveredSucceededTask(t *testing.T) {
	h := newHarness(t)
	task := model.Task{ID: "task-cancel-delivered", UserID: h.userID, Status: model.TaskStatusSucceeded, Stage: "生成完成", Type: "canvas_image", ResultJSON: `{"images":[{"url":"https://example.com/image.png"}]}`}
	if err := h.service.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	// 产物已经保存到素材库，才算“已经取回”；只有结果 JSON 还停在取回中时取消是暂停。
	delivered := model.Result{ID: "result-cancel-delivered", UserID: h.userID, TaskID: task.ID, Kind: "generation_output", Payload: `{"outputIndex":0,"mediaType":"image","materializedAssetId":"asset-cancel-delivered"}`}
	if err := h.service.Database().Create(&delivered).Error; err != nil {
		t.Fatal(err)
	}
	_, err := h.execute(t, operations.ExternalCaller(false), "task.cancel", "cancel-delivered-1", map[string]any{"taskId": task.ID})
	if got := opErr(t, err); got.Code != operations.CodeConflict || got.Reason != "task_not_cancellable" {
		t.Fatalf("already delivered task must be rejected, got %+v", got)
	}
}
