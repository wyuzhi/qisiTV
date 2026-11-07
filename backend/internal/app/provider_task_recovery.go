package app

import (
	"context"
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

const providerTaskRecoveryLeaseDuration = localtask.ProviderTaskRecoveryLeaseDuration

type ProviderTaskQueryResult = localtask.ProviderTaskQueryResult

func (s *Service) QueryFailedVideoTask(ctx context.Context, userID string, taskID string) (*ProviderTaskQueryResult, error) {
	task, err := s.repo.TaskForUser(strings.TrimSpace(userID), strings.TrimSpace(taskID))
	if err != nil {
		return nil, err
	}
	return s.queryFailedVideoTask(ctx, task, strings.TrimSpace(userID))
}

func (s *Service) queryFailedVideoTask(ctx context.Context, task *model.Task, claimUserID string) (*ProviderTaskQueryResult, error) {
	return localtask.QueryFailedVideoTaskWithDeps(ctx, localtask.VideoTaskRecoveryDeps{
		Repo:                  s.repo,
		Registry:              s.protocolRegistry(),
		NewID:                 newID,
		HydrateReqID:          s.hydrateTaskProviderRequestID,
		DecryptTaskInput:      s.decryptTaskInputJSON,
		ResolveProviderConfig: s.resolveProviderConfig,
		EnsureOfficialAdapter: ensureOfficialProtocolAdapter,
		DeclarativeAdapter:    declarativeProtocolAdapterForContext,
		BindAnalytics:         func(c context.Context, t model.Task) context.Context { return withProviderAnalytics(c, s, t) },
		ManagedQuery: func(c context.Context, t *model.Task) (bool, string, func(context.Context) (map[string]interface{}, string, *ProviderTaskQueryResult, error), error) {
			mq, unified, err := s.managedTaskRecoveryQuery(c, *t)
			if err != nil || !unified {
				return unified, mq.Kind, nil, err
			}
			return true, mq.Kind, func(queryCtx context.Context) (map[string]interface{}, string, *ProviderTaskQueryResult, error) {
				queryCtx = context.WithValue(queryCtx, imageTaskContext{}, *t)
				projection, qErr := mq.Client.Query(queryCtx, mq.Key, mq.Kind)
				if beeftv.IsMediaTaskNotFound(qErr) {
					outcome, resubmitted, resolveErr := s.mediaAttempts().ResolveMissingManagedSubmission(queryCtx, *t)
					switch {
					case outcome != "":
						if err := s.repo.FinishFailedVideoRecovery(*t, &outcome, nil); err != nil {
							return nil, "", nil, err
						}
						t.RecoveryOutcome = &outcome
						projected := taskForOutput(*t)
						s.attachTaskDelivery(projected)
						return nil, "", &ProviderTaskQueryResult{Task: projected, Recovered: false}, nil
					case resubmitted:
						projection, qErr = mq.Client.Query(queryCtx, mq.Key, mq.Kind)
					case resolveErr != nil:
						qErr = resolveErr
					}
				}
				if qErr != nil {
					return nil, projection.Status, nil, qErr
				}
				if projection.BillingState != nil {
					t.BeefBillingState = projection.BillingState
				}
				if projection.UsageState != nil {
					t.BeefUsageState = projection.UsageState
				}
				if projection.ReconcileDeadline != nil {
					value := time.Unix(*projection.ReconcileDeadline, 0).UTC().Format(time.RFC3339)
					t.BeefReconcileDeadline = &value
				}
				var res map[string]interface{}
				if projection.Status == "completed" {
					res, qErr = mq.Client.Result(queryCtx, projection, false)
				} else if projection.Status == "failed" {
					qErr = errors.New("原媒体任务未成功，请核对原任务结算")
					if projection.Error != nil {
						qErr = projection.Error
					}
				}
				return res, projection.Status, nil, qErr
			}, nil
		},
		RecordMissing:         s.recordMissingVideoReceiptOutcome,
		RecordUnrecoverable:   s.recordUnrecoverableVideoOutcome,
		ClassifyOutcome:       classifyFailedVideoQueryOutcome,
		Backoff:               videoRecoveryPollBackoff,
		PastRetention:         videoTaskPastRetentionWindow,
		AttachDelivery:        s.attachTaskDelivery,
		PersistGeneratedMedia: s.persistTaskGeneratedMediaResult,
		SaveTaskCompletion:    s.saveTaskCompletionWithinStorageQuota,
		RegisterOutput:        s.RegisterTaskOutputFromTask,
		AttachRecovered:       s.attachRecoveredProviderTask,
		Log:                   s.log,
	}, task, claimUserID)
}

func queryBeefTVVideoResult(ctx context.Context, input canvasGenerationInput, id string) (map[string]interface{}, string, error) {
	result, status, _, err := queryBeefTVVideoResultWithSettlement(ctx, input, id)
	return result, status, err
}

func queryBeefTVVideoResultWithSettlement(ctx context.Context, input canvasGenerationInput, id string) (map[string]interface{}, string, generation.BeefTVVideoSettlement, error) {
	return generation.QueryManagedLegacyVideo(ctx, input, id)
}

func providerTaskRecoveryContext(parent context.Context) (context.Context, context.CancelFunc) {
	return localtask.ProviderTaskRecoveryContext(parent)
}
