package generation

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"

	"qisitv/backend/internal/beeftv"
)

func runManagedAudioTask(ctx context.Context, client *beeftv.MediaClient, input Input) (map[string]any, error) {
	request := beeftv.MediaRequest{TaskRef: SubmissionKeyFromContext(ctx), MediaType: "audio", Model: input.Config.Model}
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
	var localLimit int64
	if runtime.Limits != nil {
		localLimit, err = runtime.Limits.ResourceUploadBytes(ctx)
		if err != nil {
			return nil, RequestPreparationError{Cause: err}
		}
	}
	if len(input.ReferenceImages) > 0 && !slices.Contains(capability.ReferenceKinds, "image") {
		return nil, RequestPreparationError{Cause: errors.New("当前音频模型不支持参考图片，请切换支持全能参考的配音模型或移除参考图")}
	}
	if len(input.ReferenceAudios) > 0 && !slices.Contains(capability.ReferenceKinds, "audio") {
		return nil, RequestPreparationError{Cause: errors.New("当前音频模型不支持参考音频，请切换支持全能参考的配音模型或移除参考音频")}
	}
	if len(input.ReferenceImages) > 0 && len(input.ReferenceAudios) > 0 {
		return nil, RequestPreparationError{Cause: errors.New("配音暂不支持同时传入参考图片与参考音频，请只保留其中一种参考素材")}
	}
	refs := make([]beeftv.LocalMediaReference, 0, len(input.ReferenceImages)+len(input.ReferenceAudios))
	for _, image := range input.ReferenceImages {
		ref := managedReference(image, "reference")
		ref.Kind = "image"
		ref.MaxBytes = localLimit
		refs = append(refs, ref)
	}
	for _, audio := range input.ReferenceAudios {
		ref := managedReference(audio, "reference")
		ref.Kind = "audio"
		ref.MaxBytes = localLimit
		refs = append(refs, ref)
	}
	request.Operation = metadataString(input.Metadata, "audioOperation")
	if request.Operation == "" && len(capability.Operations) == 1 {
		request.Operation = capability.Operations[0]
	}
	request.Input.Prompt = WithSystemPrompt(input.Config, input.Prompt)
	if input.Config.AudioFormat != "" && input.Config.AudioFormat != "mp3" {
		return nil, RequestPreparationError{Cause: errors.New("当前模型不支持所选音频格式，请选择 MP3")}
	}
	instructions := strings.TrimSpace(input.Config.AudioInstructions)
	if instructions != "" && !slices.Contains(capability.Options, "instructions") {
		return nil, RequestPreparationError{Cause: errors.New("当前音频模型不支持配音指令，请清空后重试")}
	}
	request.Options = map[string]any{}
	switch request.Operation {
	case "synthesize":
		voice := strings.TrimSpace(input.Config.AudioVoice)
		if strings.EqualFold(voice, "auto") {
			voice = ""
		}
		voiceControl, hasVoiceControl := capability.Controls["voice"]
		voiceRequired := (!hasVoiceControl || voiceControl.Required) && len(refs) == 0 && !slices.Contains(capability.Options, "instructions")
		if voice == "" && voiceRequired {
			return nil, RequestPreparationError{Cause: errors.New("请选择当前模型支持的声音")}
		}
		if voice != "" {
			request.Options["voice"] = voice
		}
		if instructions != "" {
			request.Options["instructions"] = instructions
		}
		if input.Config.AudioSpeed != "" {
			speed, err := strconv.ParseFloat(input.Config.AudioSpeed, 64)
			if err != nil {
				return nil, RequestPreparationError{Cause: errors.New("语速无效")}
			}
			request.Options["speed"] = speed
		}
		if input.Config.AudioPitch != "" && slices.Contains(capability.Options, "pitch") {
			pitch, err := strconv.ParseFloat(input.Config.AudioPitch, 64)
			if err != nil {
				return nil, RequestPreparationError{Cause: errors.New("声调无效")}
			}
			if pitch != 0 {
				request.Options["pitch"] = pitch
			}
		}
		if input.Config.AudioVolume != "" && slices.Contains(capability.Options, "volume") {
			volume, err := strconv.ParseFloat(input.Config.AudioVolume, 64)
			if err != nil {
				return nil, RequestPreparationError{Cause: errors.New("音量无效")}
			}
			if volume != 1 {
				request.Options["volume"] = volume
			}
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
	return executeManagedMedia(ctx, client, request, refs)
}
