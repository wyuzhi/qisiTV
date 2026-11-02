package app

import (
	"context"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/mediaattempt"
	"qisitv/backend/internal/model"
)

func (s *Service) startImageRecoveryPass(ctx context.Context) {
	s.mediaAttempts().StartImageRecoveryPass(ctx)
}

func imageRecoveryNeedsPolling(task model.Task) bool {
	return mediaattempt.ImageRecoveryNeedsPolling(task)
}

func (s *Service) managedImageNeedsRecheck(task model.Task) bool {
	return s.mediaAttempts().ManagedImageNeedsRecheck(task)
}

func (s *Service) recoverFailedImage(ctx context.Context, candidate model.Task) error {
	return s.mediaAttempts().RecoverFailedImage(ctx, candidate)
}

func (s *Service) resolveImageRecoveryConfig(task model.Task) (generation.Config, bool) {
	return s.mediaAttempts().ResolveImageRecoveryConfig(task)
}
