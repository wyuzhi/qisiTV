package app

import (
	"context"
	"time"

	"qisitv/backend/internal/mediaattempt"
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

const (
	videoRecoveryBatch          = localtask.VideoRecoveryBatch
	videoRecoveryPassTimeout    = localtask.VideoRecoveryPassTimeout
	videoRecoveryDefaultBackoff = localtask.VideoRecoveryDefaultBackoff
)

func (s *Service) startVideoRecoveryPass(ctx context.Context) {
	localtask.StartVideoRecoveryPass(ctx, &s.videoRecoveryActive, s.runWorkerTask, s.IsDraining, s.recoverFailedVideos, s.log)
}

func (s *Service) recoverFailedVideos(ctx context.Context, limit int) error {
	return localtask.RecoverFailedVideos(ctx, s.repo, &s.videoRecoveryAfterID, s.IsDraining, s.recoverFailedVideo, limit)
}

func (s *Service) recoverFailedVideo(ctx context.Context, candidate model.Task) error {
	return localtask.RecoverFailedVideo(
		ctx, s.repo, s.hydrateTaskProviderRequestID,
		func(c context.Context, t model.Task) (bool, error) {
			_, managed, err := s.managedTaskRecoveryQuery(c, t)
			return managed, err
		},
		videoTaskPastRetentionWindow, s.recordMissingVideoReceiptOutcome, s.recordUnrecoverableVideoOutcome,
		s.queryFailedVideoTask, videoRecoveryPollBackoff, s.withFailedVideoRecoveryLease, candidate,
	)
}

func (s *Service) resumeTaskDeliveryForUser(_ context.Context, userID, taskID string) (*model.Task, error) {
	return localtask.ResumeTaskDeliveryForUser(s.repo, deliveryPaused, s.resumeGenerationDownload, s.DeliverSucceededTask, userID, taskID)
}

func (s *Service) recoverFailedImageForUser(ctx context.Context, userID, taskID string) (*model.Task, error) {
	return localtask.RecoverFailedImageForUser(ctx, s.repo, s.DeliverSucceededTask, imageRecoveryNeedsPolling, s.managedImageNeedsRecheck, s.recoverFailedImage, userID, taskID)
}

func (s *Service) recoverFailedVideoOrUpscaleForUser(ctx context.Context, userID, taskID string) (*model.Task, error) {
	return localtask.RecoverFailedVideoOrUpscaleForUser(ctx, s.repo, s.DeliverSucceededTask, s.recoverFailedVideo, userID, taskID)
}

func (s *Service) withFailedVideoRecoveryLease(task *model.Task, claimUserID string, fn func(*model.Task) error) error {
	return localtask.WithFailedVideoRecoveryLease(s.repo, newID, task, claimUserID, fn)
}

func (s *Service) recordMissingVideoReceiptOutcome(task *model.Task, claimUserID string) {
	localtask.RecordMissingVideoReceiptOutcome(s.repo, newID, beefTVOwnsVideoConclusion, videoRecoveryPollBackoff, task, claimUserID)
}

func (s *Service) recordUnrecoverableVideoOutcome(task *model.Task, claimUserID string) {
	localtask.RecordFailedVideoRecoveryOutcome(s.repo, newID, beefTVOwnsVideoConclusion, videoRecoveryPollBackoff, task, claimUserID, localtask.RecoveryUnrecoverable)
}

func (s *Service) recordFailedVideoRecoveryOutcome(task *model.Task, claimUserID, outcome string) {
	localtask.RecordFailedVideoRecoveryOutcome(s.repo, newID, beefTVOwnsVideoConclusion, videoRecoveryPollBackoff, task, claimUserID, outcome)
}

func classifyFailedVideoQueryOutcome(task model.Task, providerStatus string, err error) string {
	return mediaattempt.ClassifyFailedVideoQueryOutcome(task, providerStatus, err, time.Now())
}
func videoSettlementNeedsPolling(task model.Task) bool { return task.MediaSettlementPending() }
func videoRecoveryNeedsPolling(task model.Task) bool {
	return localtask.VideoRecoveryNeedsPolling(task)
}
func videoTaskPastRetentionWindow(task model.Task, now time.Time) bool {
	return mediaattempt.VideoTaskPastRetentionWindow(task, now)
}
func beefTVOwnsVideoConclusion(task model.Task, now time.Time) bool {
	return mediaattempt.BeefTVOwnsVideoConclusion(task, now)
}
func (s *Service) deferManagedVideoQuery(task *model.Task, user string) {
	localtask.DeferManagedVideoQuery(s.repo, newID, videoRecoveryPollBackoff, task, user)
}

func videoRecoveryPollBackoff(task model.Task) time.Duration {
	return localtask.VideoRecoveryPollBackoff(task, mediaattempt.VideoTaskAnchor(task))
}
