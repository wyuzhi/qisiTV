package app

import (
	"context"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
)

type providerCancellationOutcome = generation.ProviderCancellationOutcome

const (
	providerCancellationPending   = generation.ProviderCancellationPending
	providerCancellationConfirmed = generation.ProviderCancellationConfirmed
	providerCancellationSucceeded = generation.ProviderCancellationSucceeded
	providerCancellationFailed    = generation.ProviderCancellationFailed
)

func (s *Service) startProviderCancellationReconciliation(ctx context.Context) {
	generation.StartProviderCancellationReconciliation(ctx, s.runWorkerLoop, s.repo, s.workerID, s.reconcileProviderCancellation, s.log)
}

func (s *Service) requestProviderCancellation(ctx context.Context, task *model.Task) error {
	bindCtx := func(c context.Context, t model.Task) context.Context { return withProviderAnalytics(c, s, t) }
	return generation.RequestProviderCancellation(ctx, s.repo, task, s.hydrateTaskProviderRequestID, s.decryptTaskInputJSON, s.resolveProviderConfig, bindCtx, s.log)
}

func (s *Service) reconcileProviderCancellation(ctx context.Context, task *model.Task) error {
	bindCtx := func(c context.Context, t model.Task) context.Context { return withProviderAnalytics(c, s, t) }
	return generation.ReconcileProviderCancellation(ctx, s.repo, task, s.decryptTaskInputJSON, s.resolveProviderConfig, bindCtx, s.log)
}

func cancelProviderTask(ctx context.Context, config providerConfig, providerRequestID string) error {
	return generation.CancelProviderTask(bindRequestReceipts(ctx), config, providerRequestID)
}

func queryProviderCancellation(ctx context.Context, config providerConfig, providerRequestID string) (providerCancellationOutcome, string, error) {
	return generation.QueryProviderCancellation(bindRequestReceipts(ctx), config, providerRequestID)
}

func providerCancellationUncertainMessage(base string) string {
	return generation.ProviderCancellationUncertainMessage(base)
}
