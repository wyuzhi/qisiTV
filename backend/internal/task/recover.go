package task

import (
	"context"
	"strings"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
)

const (
	DrainRecoverMessage          = "服务正在重启，暂不执行结果取回"
	RecoverUnsupportedStatusText = "仅支持对失败或待入库任务执行结果取回"
	RecoverUnsupportedTypeText   = "该任务类型不支持免费结果取回"
)

type manualRecoveryKey struct{}

// WithManualRecovery 标记这次恢复由用户手动发起（继续取回）。只有手动恢复才允许
// 把冻结的原请求按原编号补交；后台恢复只查询，避免几小时后突然开始生成、扣费。
func WithManualRecovery(ctx context.Context) context.Context {
	return context.WithValue(ctx, manualRecoveryKey{}, true)
}

// ManualRecovery 报告这次恢复是否由用户手动发起。
func ManualRecovery(ctx context.Context) bool {
	manual, _ := ctx.Value(manualRecoveryKey{}).(bool)
	return manual
}

// RecoverTask performs a recovery pass (delivery resume, accepted image
// replay, or upstream video/upscale/audio status query) after resetting any poll
// backoff. It never creates a new task. When the caller marks the context with
// WithManualRecovery (only the user's 继续取回, POST /api/tasks/:id/recover),
// a managed submission BeefAPI never received may be resubmitted once with its
// original key, reference and body; BeefAPI deduplicates it, so the original
// generation is charged at most once. Structurally, it never references Store.Retry, Store.CreateWithLimit,
// Persistence.CreateAdmitted, or Service.Retry.
func (s *Service) RecoverTask(ctx context.Context, userID, id string) (*model.Task, error) {
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	if s.deps.Runtime == nil || s.deps.Recovery == nil || s.deps.Present == nil {
		return nil, unavailable()
	}
	if s.deps.Runtime.IsDraining() {
		return nil, drainError(DrainRecoverMessage)
	}
	task, err := s.store.TaskForUser(userID, id)
	if mapped := mapTaskScopeError(err); mapped != nil {
		return nil, mapped
	}
	if mapped := mapTaskResourceError(err); mapped != nil {
		return nil, mapped
	}
	if err != nil {
		return nil, err
	}
	if RetiredAgentTask(task) {
		return nil, kernel.BadAuthRequest(RetiredAgentBoundaryMessage)
	}
	s.hydrateProviderRequestID(task)

	switch task.Status {
	case model.TaskStatusQueued, model.TaskStatusRunning:
		return presentTask(s.deps.Present, *task)
	case model.TaskStatusSucceeded:
		recovered, err := s.deps.Recovery.ResumeDelivery(ctx, userID, task.ID)
		if err != nil {
			return nil, err
		}
		if recovered == nil {
			return nil, unavailable()
		}
		return presentTask(s.deps.Present, *recovered)
	case model.TaskStatusFailed:
		if err := s.deps.Recovery.ResetBackoff(userID, task.ID); err != nil {
			return nil, err
		}
		var recovered *model.Task
		switch {
		case task.Type == "canvas_image" && !task.IsUpscale():
			recovered, err = s.deps.Recovery.RecoverImage(ctx, userID, task.ID)
		case task.Type == "canvas_video" || task.Type == "canvas_audio" || strings.HasPrefix(task.Type, "video_") || task.IsUpscale():
			recovered, err = s.deps.Recovery.RecoverVideoOrUpscale(ctx, userID, task.ID)
		default:
			return nil, kernel.BadAuthRequest(RecoverUnsupportedTypeText)
		}
		if err != nil {
			return nil, err
		}
		if recovered == nil {
			return nil, unavailable()
		}
		return presentTask(s.deps.Present, *recovered)
	default:
		return nil, kernel.BadAuthRequest(RecoverUnsupportedStatusText)
	}
}
