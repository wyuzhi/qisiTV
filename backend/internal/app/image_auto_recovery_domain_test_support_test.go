package app

import (
	"context"
	"qisitv/backend/internal/mediaattempt"
	"qisitv/backend/internal/model"
	"net/http"
)

func (s *Service) recoverFailedImages(ctx context.Context, limit int) error {
	return s.mediaAttempts().RecoverFailedImages(ctx, limit)
}

func (s *Service) failedImageResultWith(ctx context.Context, task model.Task, send func(*http.Request, func() error) ([]byte, string, error)) ([]byte, string, error) {
	return s.mediaAttempts().FailedImageResultWith(ctx, task, send)
}

func imageReceiptConclusion(statusCode int, body string) string {
	return mediaattempt.ImageReceiptConclusion(statusCode, body)
}
