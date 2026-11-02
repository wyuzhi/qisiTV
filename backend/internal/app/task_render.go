package app

import (
	"context"

	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

const timelineRenderFileName = localtask.TimelineRenderFileName

func timelineRenderArtifactIdentity(taskID string) string {
	return localtask.TimelineRenderArtifactIdentity(taskID)
}

func (w *taskWorkerCoordinator) processTimelineRender(task *model.Task, ctx context.Context) error {
	s := w.service
	return localtask.ProcessTimelineRender(ctx, s.repo, s.resourceDomain(), s.nativeRenderer, s.DeliverSucceededTask, s.logInfo, task)
}
