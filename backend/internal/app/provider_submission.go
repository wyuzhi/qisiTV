package app

import (
	"context"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/mediaattempt"
	"infinite-canvas/backend/internal/model"
)

type providerSubmissionKeyContext = mediaattempt.SubmissionKeyContext

func uncertainVideoSubmission(ctx context.Context, err error) error {
	return generation.UncertainVideoSubmission(ctx, err)
}
func withProviderSubmissionKey(ctx context.Context, attempt *model.RouteAttempt) context.Context {
	return mediaattempt.WithAttempt(ctx, attempt)
}
