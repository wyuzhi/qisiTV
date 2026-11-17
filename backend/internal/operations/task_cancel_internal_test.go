package operations

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"qisitv/backend/internal/model"
)

type stubTaskDomain struct {
	Domain
	tasks map[string]*model.Task
}

func (d stubTaskDomain) Task(userID, id string) (*model.Task, error) {
	task := d.tasks[id]
	if task == nil || task.UserID != userID {
		return nil, errors.New("task not found")
	}
	copied := *task
	return &copied, nil
}

type raceTaskController struct {
	task   *model.Task
	status model.TaskStatus
	err    error
}

func (c raceTaskController) CancelTask(context.Context, string, string) (*model.Task, error) {
	c.task.Status = c.status
	return nil, c.err
}

func TestTaskCancelMapsStatusRaceToConflict(t *testing.T) {
	task := &model.Task{ID: "race-task", UserID: "user-1", Status: model.TaskStatusQueued}
	ctx := &Context{
		Context:     context.Background(),
		UserID:      "user-1",
		Domain:      stubTaskDomain{tasks: map[string]*model.Task{task.ID: task}},
		TaskControl: raceTaskController{task: task, status: model.TaskStatusFailed, err: errors.New("任务当前状态为 failed，无法取消")},
	}
	_, err := opTaskCancel(ctx, json.RawMessage(`{"taskId":"race-task"}`))
	if opErr, ok := err.(*Error); !ok || opErr.Code != CodeConflict || opErr.Reason != "task_not_cancellable" {
		t.Fatalf("状态竞态必须映射为业务冲突，得到 %v", err)
	}
}

func TestTaskCancelRaceToCancelledReturnsCancelled(t *testing.T) {
	task := &model.Task{ID: "race-cancelled", UserID: "user-1", Status: model.TaskStatusRunning}
	ctx := &Context{
		Context:     context.Background(),
		UserID:      "user-1",
		Domain:      stubTaskDomain{tasks: map[string]*model.Task{task.ID: task}},
		TaskControl: raceTaskController{task: task, status: model.TaskStatusCancelled, err: errors.New("任务状态已变化，请刷新后重试")},
	}
	value, err := opTaskCancel(ctx, json.RawMessage(`{"taskId":"race-cancelled"}`))
	if err != nil {
		t.Fatalf("竞态后已被取消应返回取消状态: %v", err)
	}
	payload, _ := value.(map[string]any)
	if payload["status"] != model.TaskStatusCancelled {
		t.Fatalf("unexpected result: %#v", payload)
	}
}

func TestTaskCancelRaceToRunningIsRetryable(t *testing.T) {
	task := &model.Task{ID: "race-running", UserID: "user-1", Status: model.TaskStatusQueued}
	ctx := &Context{
		Context:     context.Background(),
		UserID:      "user-1",
		Domain:      stubTaskDomain{tasks: map[string]*model.Task{task.ID: task}},
		TaskControl: raceTaskController{task: task, status: model.TaskStatusRunning, err: errors.New("任务状态已变化，请刷新后重试")},
	}
	_, err := opTaskCancel(ctx, json.RawMessage(`{"taskId":"race-running"}`))
	if opErr, ok := err.(*Error); !ok || opErr.Code != CodeConflict || opErr.Reason != "task_cancel_race" {
		t.Fatalf("queued→running 必须保留可重试语义，得到 %v", err)
	}
}

func TestTaskCancelRaceToSucceededIsRetryable(t *testing.T) {
	task := &model.Task{ID: "race-succeeded", UserID: "user-1", Status: model.TaskStatusRunning}
	ctx := &Context{
		Context:     context.Background(),
		UserID:      "user-1",
		Domain:      stubTaskDomain{tasks: map[string]*model.Task{task.ID: task}},
		TaskControl: raceTaskController{task: task, status: model.TaskStatusSucceeded, err: errors.New("任务状态已变化，请刷新后重试")},
	}
	_, err := opTaskCancel(ctx, json.RawMessage(`{"taskId":"race-succeeded"}`))
	if opErr, ok := err.(*Error); !ok || opErr.Code != CodeConflict || opErr.Reason != "task_cancel_race" {
		t.Fatalf("running→succeeded 必须保留可重试语义，得到 %v", err)
	}
}
