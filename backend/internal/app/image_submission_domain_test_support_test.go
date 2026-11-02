package app

import (
	"context"
	"qisitv/backend/internal/mediaattempt"
	"qisitv/backend/internal/model"
	"net/http"
	"time"
)

func recoverableImageEndpoint(req *http.Request) bool {
	return mediaattempt.RecoverableImageEndpoint(req)
}

func (s *Service) imageSubmissionWire(row *model.ImageSubmission) (imageWireRequest, error) {
	return s.mediaAttempts().ImageSubmissionWire(row)
}

func (s *Service) sendImageSubmissionWith(ctx context.Context, task model.Task, row *model.ImageSubmission, send func(*http.Request, func() error) ([]byte, string, error), wait func(context.Context, time.Duration) error) ([]byte, string, error) {
	return s.mediaAttempts().SendImageSubmissionWith(ctx, task, row, send, wait)
}

func (s *Service) sendImageSubmissionWithMode(ctx context.Context, task model.Task, row *model.ImageSubmission, send func(*http.Request, func() error) ([]byte, string, error), wait func(context.Context, time.Duration) error, singleReplay bool) ([]byte, string, error) {
	return s.mediaAttempts().SendImageSubmissionWithMode(ctx, task, row, send, wait, singleReplay)
}

func retrySameImageSubmission(err error) bool {
	return mediaattempt.RetrySameImageSubmission(err)
}
