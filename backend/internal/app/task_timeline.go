package app

import (
	"context"

	"qisitv/backend/internal/editing"
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

type timelineTranscriptionInput = localtask.TimelineTranscriptionInput

func (w *taskWorkerCoordinator) processTimelineTranscription(task *model.Task, ctx context.Context) error {
	s := w.service
	return localtask.ProcessTimelineTranscription(ctx, s.repo, s.beefTV, func() error {
		return s.RequireFeature(FeatureTimelineTranscription)
	}, s.transcriptionExecutor, s.logInfo, task)
}

func (w *taskWorkerCoordinator) failTimelineTask(task *model.Task, stage string, message string) error {
	return localtask.FailTimelineTask(w.service.repo, w.service.logInfo, task, stage, message)
}

func (w *taskWorkerCoordinator) progress(task *model.Task, stage string, progress int) error {
	return localtask.UpdateTimelineTaskProgress(w.service.repo, task, stage, progress)
}

func (s *Service) logInfo(userID string, taskID string, message string, extra string) {
	s.log(userID, taskID, "info", message, extra)
}

type TimelineTranscriptionCreateRequest = localtask.TimelineTranscriptionCreateRequest

func (s *Service) CreateTimelineTranscriptionTask(userID string, req TimelineTranscriptionCreateRequest) (*model.Task, error) {
	return s.taskDomain().CreateTimelineTranscriptionTask(userID, req)
}

func (s *Service) bindTranscriptionModel(modelID string) (string, error) {
	return localtask.BindTranscriptionModel(s.beefTV, modelID)
}

type TimelineRenderCreateRequest = localtask.TimelineRenderCreateRequest
type timelineRenderInput = localtask.TimelineRenderInput
type TimelineRenderPlanRequest = localtask.TimelineRenderPlanRequest
type timelineRenderResult = localtask.TimelineRenderResult

func (s *Service) CreateTimelineRenderTask(userID string, req TimelineRenderCreateRequest) (*model.Task, error) {
	return s.taskDomain().CreateTimelineRenderTask(userID, req)
}

func (s *Service) CompileTimelineRenderPlan(userID string, req TimelineRenderPlanRequest) (*editing.Plan, error) {
	return localtask.CompileTimelineRenderPlan(userID, req)
}
