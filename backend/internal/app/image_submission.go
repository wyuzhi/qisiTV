package app

import (
	"context"
	"qisitv/backend/internal/mediaattempt"
	"qisitv/backend/internal/model"
	"net/http"
)

func (s *Service) validateImageTaskRetry(task *model.Task) error {
	return s.mediaAttempts().ValidateImageTaskRetry(task)
}

func definiteImageThrottle(err error) bool {
	return mediaattempt.DefiniteImageThrottle(err)
}

func definiteMidjourneyCountRejection(err error) bool {
	return mediaattempt.DefiniteMidjourneyCountRejection(err)
}

func definiteVODImageParameterFailure(err error) bool {
	return mediaattempt.DefiniteVODImageParameterFailure(err)
}

func isImageRecoveryError(err error) bool {
	return mediaattempt.IsImageRecoveryError(err)
}

func imageTaskEnded(err error) bool {
	return mediaattempt.ImageTaskEnded(err)
}

func (s *Service) retryRejectedImageAttempt(task *model.Task, previous *model.RouteAttempt, taskErr error) (*model.RouteAttempt, error) {
	return s.mediaAttempts().RetryRejectedImageAttempt(task, previous, taskErr)
}

func (s *Service) shouldDeferImageRecovery(task model.Task, taskErr error, providerSucceeded bool) bool {
	return s.mediaAttempts().ShouldDeferImageRecovery(task, taskErr, providerSucceeded)
}

func (s *Service) deferImageRecovery(task model.Task) error {
	return s.mediaAttempts().DeferImageRecovery(task)
}

func prepareImageSubmission(s *Service, req *http.Request) (*model.ImageSubmission, bool, error) {
	return mediaattempt.PrepareImageSubmission(s.mediaAttempts(), req)
}

func (s *Service) sendImageSubmission(ctx context.Context, task model.Task, row *model.ImageSubmission) ([]byte, string, error) {
	return s.mediaAttempts().SendImageSubmission(ctx, task, row)
}

func (s *Service) recoverImageSubmission(ctx context.Context, task model.Task) (map[string]interface{}, bool, error) {
	return s.mediaAttempts().RecoverImageSubmission(ctx, task)
}
