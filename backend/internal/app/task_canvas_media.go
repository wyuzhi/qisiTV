package app

import (
	"context"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func (w *taskWorkerCoordinator) processCanvasMedia(task *model.Task, ctx context.Context) error {
	s := w.service
	return localtask.ProcessCanvasMedia(ctx, s.repo, s.resourceDomain(), s.OpenResource, s.DeliverSucceededTask, s.log, s.logInfo, task)
}
