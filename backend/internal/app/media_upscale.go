package app

import (
	"context"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/topaz"
)

type MediaUpscaleRequest = topaz.Request

func (s *Service) upscaleConfig(name string) (generation.Config, error) {
	return generation.UpscaleConfig(name, s.lookupBeefTVCredential)
}
func (s *Service) MediaUpscaleCapabilities(ctx context.Context) map[string]any {
	return generation.LiveUpscaleCapabilities(ctx, s.lookupBeefTVCredential, s.bindGenerationRuntime)
}
func (s *Service) EstimateMediaUpscale(ctx context.Context, user string, request topaz.Request) (map[string]any, error) {
	return generation.EstimateMediaUpscale(ctx, user, request, s.EnsureResourceMediaMetadata, s.lookupBeefTVCredential, s.bindGenerationRuntime)
}
func (s *Service) CreateMediaUpscale(ctx context.Context, user string, request topaz.Request) (*model.Task, error) {
	input, payload, err := generation.BuildMediaUpscaleTaskPayload(ctx, user, request, s.EnsureResourceMediaMetadata, s.lookupBeefTVCredential, s.bindGenerationRuntime)
	if err != nil {
		return nil, err
	}
	return s.CreateTask(user, CreateTaskRequest{ProjectID: request.ProjectID, Type: "canvas_" + input.Mode, Operation: "media.upscale.topaz", Prompt: "AI 超分", Model: input.Config.Model, Provider: "beeftv", Input: payload})
}
func (s *Service) VideoSubtitleEraseCapabilities(ctx context.Context) map[string]any {
	return generation.SubtitleEraseCapabilities(ctx, s.lookupBeefTVCredential, s.bindGenerationRuntime)
}
func (s *Service) EstimateVideoSubtitleErase(ctx context.Context, user string, request generation.SubtitleEraseRequest) (map[string]any, error) {
	return generation.EstimateVideoSubtitleErase(ctx, user, request, s.EnsureResourceMediaMetadata, s.lookupBeefTVCredential, s.bindGenerationRuntime)
}
func (s *Service) CreateVideoSubtitleErase(ctx context.Context, user string, request generation.SubtitleEraseRequest) (*model.Task, error) {
	input, payload, err := generation.BuildVideoSubtitleEraseTaskPayload(ctx, user, request, s.EnsureResourceMediaMetadata, s.lookupBeefTVCredential)
	if err != nil {
		return nil, err
	}
	return s.CreateTask(user, CreateTaskRequest{ProjectID: request.ProjectID, Type: "canvas_video", Operation: input.SmartEraseTaskOperation(), Prompt: input.Prompt, Model: input.Config.Model, Provider: "beeftv", Input: payload})
}
func (s *Service) RecoverMediaUpscale(ctx context.Context, user, id string) (*model.Task, error) {
	return s.recoverManagedTool(ctx, user, id, "超分", (model.Task).IsUpscale)
}
func (s *Service) RecoverVideoSubtitleErase(ctx context.Context, user, id string) (*model.Task, error) {
	return s.recoverManagedTool(ctx, user, id, "视频处理", (model.Task).IsSubtitleErase)
}
func (s *Service) recoverManagedTool(ctx context.Context, user, id, label string, match func(model.Task) bool) (*model.Task, error) {
	deps := localtask.ManagedToolRecoveryDeps{
		Repo: s.repo, Deliver: s.DeliverSucceededTask, ReloadTask: s.Task, ProjectTask: taskForOutput,
		HydrateReqID: s.hydrateTaskProviderRequestID, RecordMissing: s.recordMissingVideoReceiptOutcome, QueryFailed: s.QueryFailedVideoTask,
		HasManagedRef: func(c context.Context, t model.Task) (bool, error) {
			_, ok, err := s.managedTaskRecoveryQuery(c, t)
			return ok, err
		},
	}
	return localtask.RecoverManagedToolTaskForUser(ctx, deps, user, id, label, match)
}
