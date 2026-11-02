package app

import (
	"context"
	"qisitv/backend/internal/model"
)

func (s *Service) managedImageQueryCipher(task model.Task, wire imageWireRequest) (string, error) {
	return s.mediaAttempts().ManagedImageQueryCipher(task, wire)
}

func (s *Service) expireImageSubmissionRequests() error {
	return s.mediaAttempts().ExpireImageSubmissionRequests()
}

func (s *Service) collectManagedImage(ctx context.Context, task model.Task, row *model.ImageSubmission) (map[string]any, bool, error) {
	return s.mediaAttempts().CollectManagedImage(ctx, task, row)
}
