package app

import (
	"context"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/mediaattempt"
	"qisitv/backend/internal/model"
)

type imageAttemptContext = mediaattempt.AttemptContext
type imageTaskContext = mediaattempt.TaskContext
type imageWireRequest = mediaattempt.WireRequest
type managedMediaQuery = mediaattempt.Query
type imageRecoveryError = generation.ImageRecoveryError
type imagePreparationError = generation.ImagePreparationError

const imageRecoveryMaxSends = mediaattempt.MaxSends
const imageRecoveryLifetime = mediaattempt.RecoveryLifetime

var errImageRecoveryIdentityUnavailable = mediaattempt.ErrIdentityUnavailable

func (s *Service) mediaAttempts() *mediaattempt.Service {
	if s == nil {
		return nil
	}
	s.mediaAttemptOnce.Do(func() {
		s.mediaAttemptService = mediaattempt.New(mediaattempt.Dependencies{
			Repository: s.repo, Secrets: s.taskSecrets(), Connections: attemptConnections{s}, Runtime: attemptRuntime{s}, Completion: attemptCompletion{s}, Log: s.log,
		})
	})
	return s.mediaAttemptService
}

type attemptConnections struct{ s *Service }

func (p attemptConnections) SystemChannel(id string) (*model.ModelChannel, error) {
	return p.s.SystemChannel(id)
}
func (p attemptConnections) ReadLocalModelConfig() ([]byte, error) { return p.s.ReadLocalModelConfig() }
func (p attemptConnections) HasManagedCredential() bool {
	return p.s.beefAPI != nil && p.s.beefAPI.HasManagedCredential()
}
func (p attemptConnections) LookupManagedCredential() (string, string, string, string, error) {
	return p.s.lookupBeefAPICredential()
}
func (p attemptConnections) ResolveProviderConfig(config generation.Config) (generation.Config, error) {
	return p.s.resolveProviderConfig(config)
}

type attemptRuntime struct{ s *Service }

func (p attemptRuntime) IsDraining() bool  { return p.s.IsDraining() }
func (p attemptRuntime) Go(fn func()) bool { return p.s.runWorkerTask(fn) }
func (p attemptRuntime) ForTask(ctx context.Context, task model.Task) context.Context {
	return withProviderAnalytics(ctx, p.s, task)
}
func (p attemptRuntime) Bind(ctx context.Context, meta generation.CallMeta) context.Context {
	return p.s.bindGenerationRuntime(ctx, meta)
}
func (p attemptRuntime) Receipts(ctx context.Context) context.Context {
	return bindRequestReceipts(ctx)
}
func (p attemptRuntime) HasAccounting() bool { return p.s.coordinator != nil }

type attemptCompletion struct{ s *Service }

func (p attemptCompletion) Save(task *model.Task, result, ops []byte, hasOps bool) error {
	return p.s.saveTaskCompletionWithinStorageQuota(task, result, ops, hasOps)
}
func (p attemptCompletion) Present(task *model.Task) *model.Task {
	p.s.attachTaskDelivery(task)
	return taskForOutput(*task)
}
