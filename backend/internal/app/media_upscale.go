package app

import (
	"context"
	"encoding/json"
	"math"
	"strings"

	localasset "qisitv/backend/internal/asset"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/topaz"
)

type MediaUpscaleRequest = topaz.Request

func (s *Service) upscaleConfig(name string) (generation.Config, error) {
	key, base, _, _, err := s.lookupBeefAPICredential()
	if err != nil {
		return generation.Config{}, err
	}
	if key == "" {
		return generation.Config{}, BadAuthRequest("请先连接官方算力账号")
	}
	return generation.Config{BaseURL: base, APIKey: key, Model: name, InterfaceType: "newapi"}, nil
}

func (s *Service) likeAIUpscaleConfig(channelID, name string) (generation.Config, error) {
	body, err := s.ReadLocalModelConfig()
	if err != nil {
		return generation.Config{}, err
	}
	var document struct {
		Channels []struct {
			ID        string `json:"id"`
			BaseURL   string `json:"baseUrl"`
			APIFormat string `json:"apiFormat"`
			APIKey    string `json:"apiKey"`
			Enabled   *bool  `json:"enabled"`
		} `json:"channels"`
	}
	if err := json.Unmarshal(body, &document); err != nil {
		return generation.Config{}, err
	}
	for _, channel := range document.Channels {
		if channel.ID != channelID {
			continue
		}
		if channel.Enabled != nil && !*channel.Enabled || channel.APIFormat != "likeai" || strings.TrimRight(channel.BaseURL, "/") != generation.LikeAIBaseURL || strings.TrimSpace(channel.APIKey) == "" {
			break
		}
		return generation.Config{BaseURL: generation.LikeAIBaseURL, APIKey: channel.APIKey, APIFormat: "likeai", Model: name, InterfaceType: "likeai-" + generation.UpscaleMediaType(name)}, nil
	}
	return generation.Config{}, BadAuthRequest("请先配置官方 LikeAI API Key；qisi API 尚未开放这些超清模型")
}

func (s *Service) MediaUpscaleCapabilities() map[string]any {
	return map[string]any{"modes": topaz.Modes(), "cloudProcessing": true, "maxVideoDurationMs": 300000}
}

func (s *Service) upscaleInput(ctx context.Context, user string, request topaz.Request) (generation.Input, *model.Resource, error) {
	var input generation.Input
	resource, err := s.EnsureResourceMediaMetadata(ctx, user, request.ResourceID)
	if err != nil || resource == nil || resource.Status != model.ResourceStatusReady {
		return input, nil, BadAuthRequest("输入素材不存在或未就绪")
	}
	kind := localasset.NormalizeKind(resource.Kind, resource.MimeType)
	if err := topaz.Validate(request, kind); err != nil {
		return input, nil, BadAuthRequest(err.Error())
	}
	var config generation.Config
	if request.Mode == "likeai" {
		config, err = s.likeAIUpscaleConfig(request.ChannelID, request.Model)
	} else {
		config, err = s.upscaleConfig(topaz.ModelID(request.Model))
	}
	if err != nil {
		return input, nil, err
	}
	format := request.OutputFormat
	if kind == "video" {
		format = ""
	}
	input = generation.Input{Mode: kind, Config: config, Upscale: &generation.UpscaleOptions{Factor: int(request.Scale), OutputFormat: format, Resolution: request.Resolution, ModelQuality: request.ModelQuality}}
	if request.Mode == "likeai" && kind == "image" && input.Upscale.ModelQuality == "" {
		input.Upscale.ModelQuality = "MQ"
	}
	media := []generation.Media{{StorageKey: "resource:" + resource.ID, MimeType: resource.MimeType, Width: resource.Width, Height: resource.Height, DurationMs: resource.DurationMs}}
	if kind == "image" {
		input.ReferenceImages = media
	} else {
		input.ReferenceVideos = media
	}
	return input, resource, nil
}

func (s *Service) EstimateMediaUpscale(ctx context.Context, user string, request topaz.Request) (map[string]any, error) {
	input, resource, err := s.upscaleInput(ctx, user, request)
	if err != nil {
		return nil, err
	}
	if generation.IsLikeAIUpscaleModel(input.Config.Model) {
		if err := generation.ValidateLikeAIUpscaleInput(input); err != nil {
			return nil, BadAuthRequest(err.Error())
		}
		// Public LikeAI docs expose no quote API. This preflight never uploads or
		// creates a provider task; the UI must obtain separate billing consent.
		return map[string]any{"mediaType": input.Mode, "source": map[string]any{"width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs}, "output": map[string]any{"width": 0, "height": 0, "durationMs": resource.DurationMs}, "outputDimensionsKnown": false, "priceKnown": false, "provider": "likeai", "currency": "CNY", "reservation": 0, "generationSubmitted": false, "cloudProcessing": true}, nil
	}
	ctx = s.bindGenerationRuntime(ctx, generation.CallMeta{UserID: user, RequestKind: "estimate"})
	estimate, err := generation.EstimateUpscale(ctx, input)
	if err != nil {
		return nil, BadAuthRequest(generation.ClassifyError(err).UserMessage())
	}
	return map[string]any{"mediaType": input.Mode, "source": map[string]any{"width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs}, "output": map[string]any{"width": int(math.Round(float64(resource.Width) * request.Scale)), "height": int(math.Round(float64(resource.Height) * request.Scale)), "durationMs": resource.DurationMs}, "reservation": estimate.Reservation, "currency": estimate.Currency, "generationSubmitted": estimate.GenerationSubmitted, "cloudProcessing": true}, nil
}

func (s *Service) CreateMediaUpscale(ctx context.Context, user string, request topaz.Request) (*model.Task, error) {
	if strings.TrimSpace(request.ClientOperationID) == "" {
		return nil, BadAuthRequest("缺少本次确认的操作 ID")
	}
	input, _, err := s.upscaleInput(ctx, user, request)
	if err != nil {
		return nil, err
	}
	if generation.IsLikeAIUpscaleModel(input.Config.Model) && !request.AcceptProviderBilling {
		return nil, BadAuthRequest("请先确认 LikeAI 按服务商实际价格计费")
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	config := payload["config"].(map[string]any)
	provider, operation := "beefapi", "media.upscale.topaz"
	if generation.IsLikeAIUpscaleModel(input.Config.Model) {
		provider, operation = "likeai", "media.upscale.likeai"
	} else {
		config["credentialRef"] = managedBeefAPIRef
	}
	payload["metadata"] = map[string]any{"clientOperationId": request.ClientOperationID, "nodeId": request.NodeID, "source": "canvas", "operation": operation, "upscaleChannelId": request.ChannelID, "acceptProviderBilling": request.AcceptProviderBilling}
	return s.CreateTask(user, CreateTaskRequest{ProjectID: request.ProjectID, Type: "canvas_" + input.Mode, Operation: operation, Prompt: "AI 超分", Model: input.Config.Model, Provider: provider, Input: payload})
}

// Recover the accepted original gateway task, or retry only a proven unaccepted
// command. Neither path creates a different local or provider operation ID.
func (s *Service) RecoverMediaUpscale(ctx context.Context, user, id string) (*model.Task, error) {
	task, err := s.repo.TaskForUser(user, id)
	if err != nil {
		return nil, err
	}
	if generation.UpscaleMediaType(task.Model) == "" {
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
	if task.ProviderRequestID == "" {
		attempt, err := s.repo.LatestRouteAttempt(task.ID)
		if err != nil || (attempt.DispatchState != "not_sent" && attempt.DispatchState != "rejected_no_job") {
			return nil, BadAuthRequest("原超分提交状态尚未确认，请保留任务记录并联系支持查询，暂勿重复提交")
		}
		return s.RetryTask(user, id)
	}
	result, err := s.QueryFailedVideoTask(ctx, user, id)
	if err != nil {
		return nil, err
	}
	if !result.Recovered {
		return nil, BadAuthRequest("原超分任务仍在处理中，请稍后取回原结果")
	}
	return result.Task, nil
}
