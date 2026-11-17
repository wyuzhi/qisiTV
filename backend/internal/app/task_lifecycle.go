package app

import (
	"context"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

// taskLifecycleCoordinator 负责任务重试与取消这类会改变任务状态的写命令。
// 读模型和 worker 执行细节留在各自边界，避免写命令跨层拼接状态更新。
type taskLifecycleCoordinator struct {
	service *Service
}

func newTaskLifecycleCoordinator(service *Service) *taskLifecycleCoordinator {
	return &taskLifecycleCoordinator{service: service}
}

func (w *taskLifecycleCoordinator) retryTask(userID string, id string) (*model.Task, error) {
	return w.service.taskDomain().Retry(userID, id)
}

func taskCancellationPendingRetryMessage() string {
	return localtask.CancellationPendingRetryMessage
}

func (w *taskLifecycleCoordinator) cancelTask(ctx context.Context, userID string, id string) (*model.Task, error) {
	return w.service.taskDomain().Cancel(ctx, userID, id)
}
