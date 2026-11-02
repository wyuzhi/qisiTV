package app

import (
	"context"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/mediaattempt"
	"qisitv/backend/internal/model"
)

type providerSubmissionKeyContext = mediaattempt.SubmissionKeyContext

func uncertainVideoSubmission(ctx context.Context, err error) error {
	return generation.UncertainVideoSubmission(ctx, err)
}
func withProviderSubmissionKey(ctx context.Context, attempt *model.RouteAttempt) context.Context {
	return mediaattempt.WithAttempt(ctx, attempt)
}
func (s *Service) createDirectTaskAttempt(task *model.Task) (*model.RouteAttempt, error) {
	return generation.CreateDirectTaskAttempt(s.repo, task)
}
