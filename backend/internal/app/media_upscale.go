package app

import (
	"context"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/topaz"
)

type MediaUpscaleRequest = topaz.Request

func (s *Service) upscaleConfig(name string) (generation.Config, error) {
	return generation.UpscaleConfig(name, s.lookupBeefTVCredential)
}

func (s *Service) likeAIUpscaleConfig(channelID, name string) (generation.Config, error) {
	return generation.LikeAIUpscaleConfig(s.ReadLocalModelConfig, channelID, name)
}

func (s *Service) MediaUpscaleCapabilities() map[string]any {
	return generation.UpscaleCapabilities()
}

func (s *Service) EstimateMediaUpscale(ctx context.Context, user string, request topaz.Request) (map[string]any, error) {
	return generation.EstimateMediaUpscale(ctx, user, request, s.EnsureResourceMediaMetadata, s.lookupBeefTVCredential, s.bindGenerationRuntime, s.likeAIUpscaleConfig)
}

func (s *Service) CreateMediaUpscale(ctx context.Context, user string, request topaz.Request) (*model.Task, error) {
	input, payload, err := generation.BuildMediaUpscaleTaskPayload(ctx, user, request, s.EnsureResourceMediaMetadata, s.lookupBeefTVCredential, s.likeAIUpscaleConfig)
	if err != nil {
		return nil, err
	}
	provider, operation := "beeftv", "media.upscale.topaz"
	if generation.IsLikeAIUpscaleModel(input.Config.Model) {
		provider, operation = "likeai", "media.upscale.likeai"
	}
	return s.CreateTask(user, CreateTaskRequest{ProjectID: request.ProjectID, Type: "canvas_" + input.Mode, Operation: operation, Prompt: "AI 超分", Model: input.Config.Model, Provider: provider, Input: payload})
}

func (s *Service) RecoverMediaUpscale(ctx context.Context, user, id string) (*model.Task, error) {
	task, err := s.repo.TaskForUser(user, id)
	if err != nil {
		return nil, err
	}
	if !task.IsUpscale() {
		return nil, BadAuthRequest("此任务不是超分任务")
	}
	if task.Status == model.TaskStatusCancelled {
		return nil, BadAuthRequest("原超分任务已取消，请在任务详情核对结果与扣费状态")
	}
	if task.Status == model.TaskStatusSucceeded {
		if err := s.DeliverSucceededTask(*task); err != nil {
			return nil, err
		}
		return s.Task(user, id)
	}
	if task.Status != model.TaskStatusFailed {
		return taskForOutput(*task), nil
	}
	s.hydrateTaskProviderRequestID(task)
	_, managed, queryErr := s.managedTaskRecoveryQuery(ctx, *task)
	if queryErr != nil {
		return nil, queryErr
	}
	if task.ProviderRequestID == "" && !managed {
		s.recordMissingVideoReceiptOutcome(task, user)
		return nil, BadAuthRequest("原超分任务没有可恢复的上游回执，请根据任务结论重新生成")
	}
	_ = s.repo.ResetTaskRecoveryBackoff(user, id)
	result, err := s.QueryFailedVideoTask(ctx, user, id)
	if err != nil {
		return nil, err
	}
	if !result.Recovered {
		return nil, BadAuthRequest("原超分任务仍在处理中，请稍后取回原结果")
	}
	return result.Task, nil
}
