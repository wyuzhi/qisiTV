package app

import (
	"context"

	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

func canvasMediaDemuxer(mime string) string {
	return localtask.CanvasMediaDemuxer(mime)
}

func (w *taskWorkerCoordinator) processCanvasMedia(task *model.Task, ctx context.Context) error {
	s := w.service
	return localtask.ProcessCanvasMedia(ctx, s.repo, s.resourceDomain(), s.OpenResource, s.DeliverSucceededTask, s.log, s.logInfo, task)
}
