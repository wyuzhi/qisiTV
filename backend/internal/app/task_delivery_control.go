package app

import (
	"context"
	"time"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/taskdelivery"
)

const generationDownloadTimeout = taskdelivery.GenerationDownloadTimeout

func deliveryPaused(stage string) bool {
	return taskdelivery.DeliveryPaused(stage)
}

func (s *Service) pauseGenerationDownload(task model.Task, stage string) (*model.Task, error) {
	return taskdelivery.PauseGenerationDownload(&s.deliveryControlMu, s.repo, s.generationDeliverer(), s.deliveryCancels, s.deliveryDeadlines, s.attachTaskDelivery, task, stage)
}

func (s *Service) resumeGenerationDownload(task model.Task) (*model.Task, error) {
	return taskdelivery.ResumeGenerationDownload(&s.deliveryControlMu, &s.deliveryClosed, s.IsDraining, s.repo, s.deliveryCancels, s.attachTaskDelivery, task)
}

func (s *Service) beginGenerationDownload(userID, identity string, timeout time.Duration) (context.Context, func(error), error) {
	return taskdelivery.BeginGenerationDownload(
		&s.deliveryControlMu, &s.deliveryClosed, s.IsDraining, s.repo, s.backgroundWorkers().Context(),
		func(parent context.Context, task model.Task) (context.Context, func(string)) {
			return s.SupportTrace().Start(taskSupportContext(parent, task), "generation.download", taskSupportFields(task))
		},
		supportFailureReason,
		func(task model.Task) { _, _ = s.pauseGenerationDownload(task, "delivery_timed_out") },
		&s.deliveryDeadlines, &s.deliveryCancels, userID, identity, timeout,
	)
}

func (s *Service) stopGenerationDownloads() {
	taskdelivery.StopGenerationDownloads(&s.deliveryControlMu, &s.deliveryClosed, s.deliveryCancels)
}
