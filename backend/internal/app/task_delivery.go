package app

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/taskdelivery"
)

const generationDeliveryRecoveryInterval = taskdelivery.GenerationDeliveryRecoveryInterval

func (s *Service) DeliverSucceededTask(task model.Task) error {
	err := s.generationDeliverer().Deliver(task)
	if bindErr := s.recoverCanvasTaskBindings(task); bindErr != nil {
		log.Printf("generation canvas bind deferred: task_id=%s error=%v", task.ID, bindErr)
	}
	return err
}

func (s *Service) RecoverIncompleteGenerationDeliveries(limit int) error {
	err := s.generationDeliverer().RecoverIncomplete(limit)
	if bindErr := s.recoverPendingCanvasBindings(limit); bindErr != nil {
		log.Printf("generation canvas bind recovery paused: worker_id=%s error=%v", s.workerID, bindErr)
	}
	if failErr := s.recoverPendingCanvasFailures(limit); failErr != nil {
		log.Printf("generation canvas failure writeback paused: worker_id=%s error=%v", s.workerID, failErr)
	}
	return err
}

func (s *Service) CanvasBindingIntents(task model.Task) []localtask.CanvasBindingIntent {
	return taskdelivery.CanvasBindingIntents(s.generationDeliverer(), task, persistedFailureBlocksRetry(task.Error, task.Stage))
}

func (s *Service) ensureSucceededTaskDelivery(task *model.Task) error {
	return taskdelivery.EnsureSucceededTaskDelivery(s.generationDeliverer(), task, s.DeliverSucceededTask)
}

func (s *Service) attachTaskDelivery(task *model.Task) {
	if task == nil {
		return
	}
	taskdelivery.AttachTaskDelivery(s.generationDeliverer(), task, s.hydrateTaskProviderRequestID, s.taskOutcomeFacts, persistedFailureBlocksRetry(task.Error, task.Stage), s.deliveryProgressRegistry().ForTask(task.ID))
	task.ReferenceProgress = s.referenceProgressForTask(task.ID)
}

func (s *Service) attachTaskSummaryDeliveries(tasks []model.Task, summaries []TaskSummary) {
	taskdelivery.AttachTaskSummaryDeliveries(s.generationDeliverer(), tasks, summaries, s.taskOutcomeFacts, persistedFailureBlocksRetry, s.deliveryProgressRegistry().ForTask, func(index int, taskID string) {
		summaries[index].ReferenceProgress = s.referenceProgressForTask(taskID)
	})
}

func (s *Service) attachRecoveredProviderTask(task *model.Task) *model.Task {
	if task == nil {
		return nil
	}
	if err := s.DeliverSucceededTask(*task); err != nil {
		_ = s.log(task.UserID, task.ID, "error", "任务恢复成功但结果交付失败", err.Error())
	}
	projected := taskForOutput(*task)
	s.attachTaskDelivery(projected)
	return projected
}

func (s *Service) startGenerationDeliveryRecovery(context.Context) {
	s.runWorkerLoop(func(ctx context.Context) {
		recoverOnce := func() {
			if ctx.Err() != nil || s.IsDraining() {
				return
			}
			s.startImageRecoveryPass(ctx)
			s.startVideoRecoveryPass(ctx)
			if err := s.RecoverIncompleteGenerationDeliveries(0); err != nil {
				log.Printf("generation delivery recovery paused: worker_id=%s error=%v", s.workerID, err)
			}
			s.recoverAssistantContinuations(ctx)
		}
		recoverOnce()
		ticker := time.NewTicker(generationDeliveryRecoveryInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				recoverOnce()
			}
		}
	})
}

func (s *Service) generationDeliverer() *taskdelivery.Deliverer {
	if s == nil {
		return taskdelivery.New(taskdelivery.RepoStore{}, nil)
	}
	s.deliveryMu.Lock()
	defer s.deliveryMu.Unlock()
	if s.generationDelivery == nil {
		s.generationDelivery = taskdelivery.New(taskdelivery.NewRepoStore(s.repo, publicTaskInputJSON), s.deliveryMedia())
	}
	return s.generationDelivery
}

func (s *Service) deliveryMedia() taskdelivery.Media {
	if s != nil && s.generationDeliveryMedia != nil {
		return s.generationDeliveryMedia
	}
	if s == nil || strings.TrimSpace(s.dataDir) == "" {
		return nil
	}
	return generationDeliveryMediaAdapter{service: s}
}

func modelTaskOutputs(outputs []localtask.CanonicalOutput) []model.TaskOutput {
	return taskdelivery.ModelTaskOutputs(outputs)
}

func mapDeliveryStoreErr(err error) error {
	return taskdelivery.MapDeliveryStoreErr(err)
}

type generationDeliveryMediaAdapter struct {
	service                      *Service
	allowManagedMediaHTTPForTest bool
}

func (a generationDeliveryMediaAdapter) deps() localtask.DeliveryMediaDeps {
	s := a.service
	return localtask.DeliveryMediaDeps{
		Repo: s.repo, DataDir: s.dataDir, AllowHTTPForTest: a.allowManagedMediaHTTPForTest,
		Resources: s.resourceDomain(), DecodeDataURL: s.decodeDataURL, BeginDownload: s.beginGenerationDownload,
		MaxBytes: s.generatedMediaMaxBytes, Progress: &s.deliveryProgressRegistry().DeliveryProgressRegistry,
		DecryptTaskInput: s.decryptTaskInputJSON, DecryptSetting: s.decryptSettingSecret,
		ResolveConfig: s.resolveProviderConfig, ProtocolRegistry: s.protocolRegistry(),
		RefreshManagedURL: a.refreshManagedArtifactURL, BindRuntime: s.bindGenerationRuntime,
	}
}

func (a generationDeliveryMediaAdapter) PersistRemoteArtifact(userID, mediaType, artifactURL, identity string) (*model.Resource, error) {
	if a.service == nil {
		return nil, errors.New("generation media adapter is not initialized")
	}
	return localtask.PersistRemoteGenerationArtifact(a.deps(), userID, mediaType, artifactURL, identity, generationDownloadTimeout)
}

func (a generationDeliveryMediaAdapter) decodeGenerationArtifact(userID, identity, mediaType, artifactURL string) (string, []byte, string, string, int, int, int64, error) {
	return localtask.DecodeGenerationArtifact(a.deps(), userID, identity, mediaType, artifactURL, generationDownloadTimeout)
}

func (a generationDeliveryMediaAdapter) imageDownloadHeaders(userID, identity, kind, artifactURL string) (http.Header, error) {
	return localtask.ImageDownloadHeaders(a.service.repo, a.service.decryptTaskInputJSON, a.service.decryptSettingSecret, a.service.resolveProviderConfig, a.service.protocolRegistry(), userID, identity, kind, artifactURL)
}

func (a generationDeliveryMediaAdapter) managedArtifact(userID, identity string) (bool, error) {
	return localtask.ManagedDeliveryArtifact(a.service.repo, a.service.decryptSettingSecret, userID, identity)
}

func (a generationDeliveryMediaAdapter) artifactDownloadPartialPath(userID, identity string) string {
	return localtask.ArtifactDownloadPartialPath(a.service.dataDir, userID, identity)
}

func (s *Service) generationLocalArtifactPresent(resource *model.Resource) bool {
	if s == nil {
		return false
	}
	return taskdelivery.GenerationLocalArtifactPresent(s.dataDir, resource)
}
