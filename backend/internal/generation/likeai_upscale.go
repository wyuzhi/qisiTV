package generation

import (
	"context"
	"errors"
)

func IsLikeAIUpscaleModel(model string) bool {
	return model == "huoshan_image_super_resolution" || model == "tengxun_video_super_resolution"
}

// Super-resolution is not text-to-image/video. Send only the documented fields;
// generic model defaults must not inject duration, aspect ratio or image size.
func likeAIUpscaleBody(model string, body map[string]any) (map[string]any, error) {
	if model == "huoshan_image_super_resolution" {
		kwargs, _ := body["kwargs"].(map[string]any)
		quality, _ := kwargs["model_quality"].(string)
		if quality != "MQ" && quality != "HQ" && quality != "LQ" {
			return nil, errors.New("无效的图片超清质量")
		}
		return map[string]any{"api_name": model, "image_urls": body["image_urls"], "kwargs": map[string]any{"model_quality": quality}}, nil
	}
	resolution, _ := body["resolution"].(string)
	if resolution != "1080p" && resolution != "1440p" && resolution != "2160p" {
		return nil, errors.New("无效的视频超清分辨率")
	}
	return map[string]any{"api_name": model, "video_urls": body["video_urls"], "resolution": resolution}, nil
}

func ValidateLikeAIUpscaleInput(input Input) error {
	kind := UpscaleMediaType(input.Config.Model)
	if !IsLikeAIUpscaleModel(input.Config.Model) || input.Mode != kind || input.Config.BaseURL != LikeAIBaseURL || input.Config.InterfaceType != "likeai-"+kind || input.Upscale == nil || input.Upscale.Factor != 1 || input.Upscale.OutputFormat != "" {
		return errors.New("LikeAI 超清模型、渠道或参数无效")
	}
	if kind == "image" && (len(input.ReferenceImages) != 1 || len(input.ReferenceVideos) != 0) || kind == "video" && (len(input.ReferenceVideos) != 1 || len(input.ReferenceImages) != 0) || len(input.ReferenceAudios) != 0 || input.Mask != nil {
		return errors.New("每个超清任务需要一个同类型素材")
	}
	source := input.ReferenceImages
	if kind == "video" {
		source = input.ReferenceVideos
	}
	if !upscaleOwnedSource.MatchString(source[0].StorageKey) || source[0].URL != "" || source[0].DataURL != "" {
		return errors.New("超清只能使用当前素材库中的图片或视频")
	}
	if kind == "image" {
		if input.Upscale.Resolution != "" || (input.Upscale.ModelQuality != "MQ" && input.Upscale.ModelQuality != "HQ" && input.Upscale.ModelQuality != "LQ") {
			return errors.New("图片超清质量必须为 MQ、HQ 或 LQ")
		}
	} else if input.Upscale.ModelQuality != "" || (input.Upscale.Resolution != "1080p" && input.Upscale.Resolution != "1440p" && input.Upscale.Resolution != "2160p") {
		return errors.New("视频超清分辨率必须为 1080p、1440p 或 2160p")
	}
	return nil
}

func runLikeAIUpscale(ctx context.Context, input Input) (map[string]any, error) {
	input.ReferenceImages = append([]Media(nil), input.ReferenceImages...)
	input.ReferenceVideos = append([]Media(nil), input.ReferenceVideos...)
	if err := ValidateLikeAIUpscaleInput(input); err != nil {
		return nil, RequestPreparationError{Cause: err}
	}
	if ResumedProviderRequestID(ctx) == "" {
		runtime, _ := RuntimeFromContext(ctx)
		if err := HydrateMedia(ctx, runtime.Call.UserID, &input, MediaHydrationPolicy{}); err != nil {
			return nil, RequestPreparationError{Cause: err}
		}
		if err := PrepareLikeAIReferences(ctx, &input); err != nil {
			return nil, RequestPreparationError{Cause: err}
		}
	}
	input.Config.Size, input.Config.Quality, input.Config.VideoSeconds = "", "", ""
	input.Config.VQuality = input.Upscale.Resolution
	metadata := make(map[string]any, len(input.Metadata)+1)
	for key, value := range input.Metadata {
		metadata[key] = value
	}
	input.Metadata = metadata
	options := map[string]any{"body": map[string]any{"resolution": input.Upscale.Resolution}}
	if input.Mode == "image" {
		options["kwargs"] = map[string]any{"model_quality": input.Upscale.ModelQuality}
	}
	input.Metadata["providerOptions"] = map[string]any{input.Config.InterfaceType: options}
	return RunDeclarativeProtocolTask(ctx, input)
}
