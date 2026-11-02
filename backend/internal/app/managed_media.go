package app

import (
	"context"
	"qisitv/backend/internal/mediaattempt"
	"qisitv/backend/internal/model"
)

func managedTaskConnection(task model.Task) bool {
	return mediaattempt.ManagedTaskConnection(task)
}

func (s *Service) managedTaskQuery(ctx context.Context, task model.Task, row *model.ImageSubmission) (managedMediaQuery, bool, error) {
	return s.mediaAttempts().ManagedTaskQuery(ctx, task, row)
}

func (s *Service) managedTaskRecoveryQuery(ctx context.Context, task model.Task) (managedMediaQuery, bool, error) {
	return s.mediaAttempts().ManagedTaskRecoveryQuery(ctx, task)
}
