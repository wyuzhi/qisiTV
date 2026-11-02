package app

import (
	"context"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
)

func (s *Service) invalidateRouteCatalog() {
	if s != nil {
		s.ensureRouter().Invalidate(context.Background())
	}
}

func (s *Service) routeCatalogSnapshot() (*routeCatalogSnapshot, error) {
	return s.ensureRouter().Snapshot()
}

func (s *Service) ResolveLogicalModel(logicalModelID string, intent ModelRequestIntent) (*RoutedModel, error) {
	return s.ensureRouter().ResolveLogicalModel(logicalModelID, intent)
}

func (s *Service) createRouteAttempt(task *model.Task, routed *RoutedModel, attemptNumber int) (*model.RouteAttempt, error) {
	return s.ensureRouter().CreateRouteAttempt(s.routeStore(), task, routed, attemptNumber)
}

func (s *Service) beginTaskRouteAttempt(task *model.Task) (*model.RouteAttempt, error) {
	return generation.BeginTaskRouteAttempt(s.repo, s.ensureRouter(), s.routeStore(), s.taskInputCodec(), func(t model.Task, row *model.ImageSubmission) bool {
		query, managed, err := s.managedTaskQuery(context.Background(), t, row)
		return err == nil && managed && !query.Legacy
	}, s.retryRejectedImageAttempt, task)
}

func (s *Service) markRouteAttemptDispatching(attempt *model.RouteAttempt) error {
	return modelcatalog.MarkRouteAttemptDispatching(s.routeStore(), attempt)
}

func (s *Service) routedModelForTaskSelection(task *model.Task) (*RoutedModel, error) {
	return s.ensureRouter().RoutedModelForTaskSelection(s.routeStore(), task)
}

func (s *Service) switchTaskToNextRoute(task *model.Task, attempts []model.RouteAttempt) (*model.RouteAttempt, error) {
	return s.ensureRouter().SwitchTaskToNextRoute(s.routeStore(), s.taskInputCodec(), task, attempts)
}

func (s *Service) nextRouteAttemptAfterFailure(task *model.Task, attempt *model.RouteAttempt, taskErr error) (*model.RouteAttempt, error) {
	return generation.NextRouteAttemptAfterFailure(s.repo, s.ensureRouter(), s.routeStore(), s.taskInputCodec(), s.resolveImageRecoveryConfig, s.retryRejectedImageAttempt, task, attempt, taskErr)
}

func (s *Service) prepareLogicalTaskRetry(task *model.Task, input map[string]any) error {
	return s.ensureRouter().PrepareLogicalTaskRetry(s.routeStore(), s.taskInputCodec(), task, input)
}

func (s *Service) resolveArchivedTaskRoute(task *model.Task, intent ModelRequestIntent) (*RoutedModel, error) {
	return s.ensureRouter().ResolveArchivedTaskRoute(s.routeStore(), task, intent)
}

func (s *Service) finishTaskRouteAttempt(attempt *model.RouteAttempt, task *model.Task, taskErr error) {
	generation.FinishTaskRouteAttempt(s.repo, s.routeStore(), attempt, task, taskErr, taskFailureMessage(taskErr))
}
