package generation

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
)

func runManagedAudioTask(ctx context.Context, client *beefapi.MediaClient, input Input) (map[string]any, error) {
	request := beefapi.MediaRequest{TaskRef: SubmissionKeyFromContext(ctx), MediaType: "audio", Model: input.Config.Model}
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.ManagedMedia == nil || request.TaskRef == "" {
		return nil, RequestPreparationError{Cause: errors.New("音频请求缺少持久化提交标识")}
	}
	sent, err := runtime.ManagedMedia.Sent(ctx)
	if err != nil {
		return nil, err
	}
	if sent {
		return executeManagedMedia(ctx, client, request, nil)
	}
	discovery, err := client.Discover(ctx)
	if err != nil {
		return nil, RequestPreparationError{Cause: err}
	}
	model := discovery.Models[input.Config.Model]
	capability, ok := model.Capabilities["audio"]
	if !ok || model.Version == "" {
		return nil, RequestPreparationError{Cause: errors.New("当前模型暂不支持此音频生成方式")}
	}
	request.Operation = metadataString(input.Metadata, "audioOperation")
	if request.Operation == "" && len(capability.Operations) == 1 {
		request.Operation = capability.Operations[0]
	}
	request.Input.Prompt = WithSystemPrompt(input.Config, input.Prompt)
	if input.Config.AudioFormat != "" && input.Config.AudioFormat != "mp3" {
		return nil, RequestPreparationError{Cause: errors.New("当前模型不支持所选音频格式，请选择 MP3")}
	}
	if strings.TrimSpace(input.Config.AudioInstructions) != "" {
		return nil, RequestPreparationError{Cause: errors.New("当前音频模型不支持配音指令，请清空后重试")}
	}
	request.Options = map[string]any{}
	switch request.Operation {
	case "synthesize":
		voice := strings.TrimSpace(input.Config.AudioVoice)
		if voice == "" || voice == "auto" {
			return nil, RequestPreparationError{Cause: errors.New("请选择当前模型支持的声音")}
		}
		request.Options["voice"] = voice
		if input.Config.AudioSpeed != "" {
			speed, err := strconv.ParseFloat(input.Config.AudioSpeed, 64)
			if err != nil {
				return nil, RequestPreparationError{Cause: errors.New("语速无效")}
			}
			request.Options["speed"] = speed
		}
	case "generate":
		for _, field := range []struct{ input, output string }{{"audioLyrics", "lyrics"}, {"audioIsInstrumental", "is_instrumental"}, {"audioLyricsOptimizer", "lyrics_optimizer"}} {
			if value, exists := input.Metadata[field.input]; exists {
				request.Options[field.output] = value
			}
		}
	default:
		return nil, RequestPreparationError{Cause: errors.New("请选择当前音频模型支持的操作")}
	}
	return executeManagedMedia(ctx, client, request, nil)
}
