package generation

import (
	"context"
	"encoding/json"
	"math"
	"strings"

	localasset "qisitv/backend/internal/asset"
	"qisitv/backend/internal/beeftv"
	"qisitv/backend/internal/channelurl"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/topaz"
)

func LikeAIUpscaleConfig(readConfig func() ([]byte, error), channelID, name string) (Config, error) {
	body, err := readConfig()
	if err != nil {
		return Config{}, err
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
		return Config{}, err
	}
	for _, channel := range document.Channels {
		if channel.ID != channelID {
			continue
		}
		if channel.Enabled != nil && !*channel.Enabled || channel.APIFormat != "likeai" || !channelurl.IsDirectLikeAI(channel.BaseURL) || strings.TrimSpace(channel.APIKey) == "" {
			break
		}
		return Config{BaseURL: strings.TrimRight(strings.TrimSpace(channel.BaseURL), "/"), APIKey: channel.APIKey, APIFormat: "likeai", Model: name, InterfaceType: "likeai-" + UpscaleMediaType(name)}, nil
	}
	return Config{}, BadAuthRequest("请先配置官方 LikeAI API Key；qisi API 尚未开放这些超清模型")
}

func UpscaleConfig(name string, lookupCred func() (string, string, string, string, error)) (Config, error) {
	key, base, _, _, err := lookupCred()
	if err != nil {
		return Config{}, err
	}
	if key == "" {
		return Config{}, BadAuthRequest("请先连接官方算力账号")
	}
	return Config{BaseURL: base, APIKey: key, CredentialRef: beeftv.CredentialRef, Model: name, InterfaceType: "newapi"}, nil
}

func UpscaleCapabilities() map[string]any {
	return map[string]any{"modes": topaz.Modes(), "cloudProcessing": true, "maxVideoDurationMs": 300000}
}

func UpscaleInput(ctx context.Context, user string, request topaz.Request, ensureMetadata func(context.Context, string, string) (*model.Resource, error), lookupCred func() (string, string, string, string, error), likeAIConfig ...func(string, string) (Config, error)) (Input, *model.Resource, error) {
	var input Input
	resource, err := ensureMetadata(ctx, user, request.ResourceID)
	if err != nil || resource == nil || resource.Status != model.ResourceStatusReady {
		return input, nil, BadAuthRequest("输入素材不存在或未就绪")
	}
	kind := localasset.NormalizeKind(resource.Kind, resource.MimeType)
	if err := topaz.Validate(request, kind); err != nil {
		return input, nil, BadAuthRequest(err.Error())
	}
	var config Config
	if request.Mode == "likeai" {
		if len(likeAIConfig) == 0 || likeAIConfig[0] == nil {
			return input, nil, BadAuthRequest("LikeAI 超清配置不可用")
		}
		config, err = likeAIConfig[0](request.ChannelID, request.Model)
	} else {
		config, err = UpscaleConfig(topaz.ModelID(request.Model), lookupCred)
	}
	if err != nil {
		return input, nil, err
	}
	format := request.OutputFormat
	if kind == "video" {
		format = ""
	}
	input = Input{Mode: kind, Config: config, Upscale: &UpscaleOptions{Factor: int(request.Scale), OutputFormat: format, Resolution: request.Resolution, ModelQuality: request.ModelQuality}}
	if request.Mode == "likeai" && kind == "image" && input.Upscale.ModelQuality == "" {
		input.Upscale.ModelQuality = "MQ"
	}
	media := []Media{{StorageKey: "resource:" + resource.ID, MimeType: resource.MimeType, Width: resource.Width, Height: resource.Height, DurationMs: resource.DurationMs}}
	if kind == "image" {
		input.ReferenceImages = media
	} else {
		input.ReferenceVideos = media
	}
	return input, resource, nil
}

func EstimateMediaUpscale(ctx context.Context, user string, request topaz.Request, ensureMetadata func(context.Context, string, string) (*model.Resource, error), lookupCred func() (string, string, string, string, error), bindRuntime func(context.Context, CallMeta) context.Context, likeAIConfig ...func(string, string) (Config, error)) (map[string]any, error) {
	input, resource, err := UpscaleInput(ctx, user, request, ensureMetadata, lookupCred, likeAIConfig...)
	if err != nil {
		return nil, err
	}
	if IsLikeAIUpscaleModel(input.Config.Model) {
		if err := ValidateLikeAIUpscaleInput(input); err != nil {
			return nil, BadAuthRequest(err.Error())
		}
		// LikeAI has no quote endpoint; this preflight never uploads or submits.
		return map[string]any{"mediaType": input.Mode, "source": map[string]any{"width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs}, "output": map[string]any{"width": 0, "height": 0, "durationMs": resource.DurationMs}, "outputDimensionsKnown": false, "priceKnown": false, "provider": "likeai", "currency": "CNY", "reservation": 0, "generationSubmitted": false, "cloudProcessing": true}, nil
	}
	if bindRuntime != nil {
		ctx = bindRuntime(ctx, CallMeta{UserID: user, RequestKind: "estimate"})
	}
	estimate, err := EstimateUpscale(ctx, input)
	if err != nil {
		return nil, BadAuthRequest(ClassifyError(err).UserMessage())
	}
	return map[string]any{
		"mediaType":           input.Mode,
		"source":              map[string]any{"width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs},
		"output":              map[string]any{"width": int(math.Round(float64(resource.Width) * request.Scale)), "height": int(math.Round(float64(resource.Height) * request.Scale)), "durationMs": resource.DurationMs},
		"reservation":         estimate.Reservation,
		"currency":            estimate.Currency,
		"generationSubmitted": estimate.GenerationSubmitted,
		"cloudProcessing":     true,
	}, nil
}

func BuildMediaUpscaleTaskPayload(ctx context.Context, user string, request topaz.Request, ensureMetadata func(context.Context, string, string) (*model.Resource, error), lookupCred func() (string, string, string, string, error), likeAIConfig ...func(string, string) (Config, error)) (Input, map[string]any, error) {
	if strings.TrimSpace(request.ClientOperationID) == "" {
		return Input{}, nil, BadAuthRequest("缺少本次确认的操作 ID")
	}
	input, _, err := UpscaleInput(ctx, user, request, ensureMetadata, lookupCred, likeAIConfig...)
	if err != nil {
		return Input{}, nil, err
	}
	if IsLikeAIUpscaleModel(input.Config.Model) && !request.AcceptProviderBilling {
		return Input{}, nil, BadAuthRequest("请先确认 LikeAI 按服务商实际价格计费")
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return Input{}, nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return Input{}, nil, err
	}
	config := payload["config"].(map[string]any)
	operation := "media.upscale.topaz"
	if IsLikeAIUpscaleModel(input.Config.Model) {
		operation = "media.upscale.likeai"
	} else {
		config["credentialRef"] = beeftv.CredentialRef
	}
	payload["metadata"] = map[string]any{"clientOperationId": request.ClientOperationID, "nodeId": request.NodeID, "source": "canvas", "operation": operation, "upscaleChannelId": request.ChannelID, "acceptProviderBilling": request.AcceptProviderBilling}
	return input, payload, nil
}
