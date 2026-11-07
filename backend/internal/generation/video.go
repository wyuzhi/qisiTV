package generation

// 视频生成遗留手写路径；已有官方插件的接口类型走声明式协议。

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"mime/multipart"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/providerpreset"
)

func RestoreBeefTVSeedanceAudioControl(ctx context.Context, config Config, video *VideoCapabilityConfig) {
	if config.VideoCapabilitiesVersion != nil {
		return
	}
	// Saved built-in profiles predate the supported audio switch. This is a
	// BeefTV contract correction, not an override of custom provider settings.
	contract, known := providerpreset.BeefTVVideoContract(config.Model)
	if IsBeefTVVideoConfig(ctx, config) && known && contract.Protocol == "newapi" && modelcatalog.IsSeedance2Family("newapi", config.Model) {
		video.GenerateAudio.Supported = true
	}
}

func RunVideoTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	return RunVideoTaskWithPolicy(ctx, input, DefaultVideoPollPolicy())
}

func RunVideoTaskWithPolicy(ctx context.Context, input Input, pollPolicy VideoPollPolicy) (map[string]interface{}, error) {
	pollPolicy = videoPollPolicyForConfig(ctx, input.Config, pollPolicy)
	// BeefTV exposes its flat /v1/videos contract. Route it before
	// protocol adapters so stale persisted channel metadata cannot select an
	// incompatible legacy multipart or flat request shape.
	if managedConnection(input.Config) || IsBeefTVVideoConfig(ctx, input.Config) {
		client, unified, err := useManagedMediaEnvelope(ctx, input.Config, "video")
		if err != nil {
			return nil, err
		}
		if unified {
			return runManagedVideoTask(ctx, client, input)
		}
		return runManagedLegacyVideo(ctx, input, pollPolicy)
	}
	// 路由顺序是协议边界，不是“哪个请求先试”：官方声明式接口必须由已注册适配器执行，
	// 缺少适配器时直接失败，不能偷偷退回遗留手写协议；只有未声明为官方插件的旧渠道才继续走兼容分支。
	if strings.TrimSpace(input.Mode) == "" {
		input.Mode = "video"
	}
	// 已有官方声明式插件的 InterfaceType 只走适配器。未注入 registry 时补官方包，
	// 显式空 registry 则报“插件未安装”，不再回退到手写协议。
	ctx = EnsureOfficialProtocolAdapter(ctx, input.Config.InterfaceType)
	if adapter, ok := DeclarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType); ok {
		return RunProtocolAdapterTaskWithPolicy(ctx, input, adapter, pollPolicy)
	}
	if label, official := OfficialDeclarativeVideoInterface(input.Config.InterfaceType); official {
		return nil, fmt.Errorf("%s 视频插件未安装", label)
	}
	if IsArkPlanVideoConfig(input.Config) {
		return RunSeedanceAgentPlanVideoTask(ctx, input, pollPolicy)
	}
	if IsSeedanceVideoConfig(input.Config) {
		return RunSeedanceVideosTask(ctx, input, pollPolicy)
	}
	if len(input.ReferenceVideos) > 0 || len(input.ReferenceAudios) > 0 {
		return nil, errors.New("OpenAI 风格视频接口不支持参考视频或参考音频，请切换到 Seedance / Agent Plan 渠道")
	}
	id := ResumedProviderRequestID(ctx)
	var created map[string]interface{}
	if id == "" && IsGrokVideoConfig(input.Config) {
		requestBody, err := GrokVideoBody(input)
		if err != nil {
			return nil, err
		}
		if err := PostJSON(ctx, input.Config, "/videos", requestBody, &created); err != nil {
			return nil, err
		}
	} else if id == "" {
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		writeField(writer, "model", input.Config.Model)
		writeField(writer, "prompt", NewAPIVideoPromptText(input))
		writeField(writer, "seconds", defaultString(input.Config.VideoSeconds, "6"))
		if size := NormalizeVideoSize(input.Config.Size); size != "" {
			writeField(writer, "size", size)
		}
		if resolution := videoResolutionNameRequest(input.VideoCapability, input.Config.VQuality); resolution != "" {
			writeField(writer, "resolution_name", resolution)
		}
		writeField(writer, "preset", "normal")
		if ShouldSendNewAPIVideoImages(input) {
			for _, image := range input.ReferenceImages {
				if err := writeMediaPart(writer, "input_reference[]", image); err != nil {
					return nil, err
				}
			}
		}
		if err := writer.Close(); err != nil {
			return nil, err
		}
		if err := PostForm(ctx, input.Config, "/videos", writer.FormDataContentType(), body, &created); err != nil {
			return nil, err
		}
	}
	if id == "" {
		extracted, err := firstJSONString(created, "id", "request_id", "task_id")
		if err != nil {
			return nil, fmt.Errorf("视频接口任务 ID 无效：%w", err)
		}
		id = extracted
	}
	if id == "" {
		if data, ok := created["data"].(map[string]interface{}); ok {
			extracted, err := firstJSONString(data, "id", "request_id", "task_id")
			if err != nil {
				return nil, fmt.Errorf("视频接口任务 ID 无效：%w", err)
			}
			id = extracted
		}
	}
	if id == "" {
		return nil, errors.New("视频接口没有返回任务 ID")
	}
	return RunVideoPollLoop(ctx, id, pollPolicy, func(ctx context.Context) (VideoPollOutcome, error) {
		var state map[string]interface{}
		if err := GetJSON(ctx, input.Config, "/videos/"+id, &state); err != nil {
			return VideoPollOutcome{}, err
		}
		var err error
		state, err = ValidateVideoTaskState(id, state)
		if err != nil {
			return VideoPollOutcome{}, err
		}
		status := strings.ToLower(stringField(state, "status"))
		if VideoTaskSucceeded(status) {
			lastFrameURL := SeedanceLastFrameURL(state)
			if videoURL := NewAPIVideoResultURL(state); videoURL != "" {
				data, mimeType, err := RunVideoDownload(ctx, id, pollPolicy, videoResultDownloader(input.Config, videoURL, id, newAPIVideoURLResolver(input.Config, id)))
				if err != nil {
					return VideoPollOutcome{}, fmt.Errorf("视频结果下载失败（任务 %s）：%w", id, err)
				}
				mimeType = NormalizedMediaMIMEType(mimeType, data)
				videoMap := map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType}
				attachOptionalProviderLastFrame(ctx, input.Config, videoMap, lastFrameURL, true)
				return VideoPollOutcome{Done: true, Result: map[string]interface{}{"mode": "video", "video": videoMap}}, nil
			}
			data, mimeType, err := RunVideoDownload(ctx, id, pollPolicy, videoResultDownloader(input.Config, APIURL(input.Config.BaseURL, "/videos/"+id+"/content"), id, newAPIVideoURLResolver(input.Config, id)))
			if err != nil {
				return VideoPollOutcome{}, err
			}
			videoMap := map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType}
			attachOptionalProviderLastFrame(ctx, input.Config, videoMap, lastFrameURL, true)
			return VideoPollOutcome{Done: true, Result: map[string]interface{}{"mode": "video", "video": videoMap}}, nil
		}
		if status == "failed" || status == "cancelled" {
			return VideoPollOutcome{}, errors.New("视频生成失败")
		}
		return VideoPollOutcome{}, nil
	})
}

func NewAPIVideoResultURL(state map[string]interface{}) string {
	return NestedNewAPIVideoResultURL(state, false, 0)
}

func NestedNewAPIVideoResultURL(payload map[string]interface{}, allowResultURL bool, depth int) string {
	if depth < 2 {
		for _, key := range []string{"data", "result", "video"} {
			if nested, ok := payload[key].(map[string]interface{}); ok {
				if videoURL := NestedNewAPIVideoResultURL(nested, true, depth+1); videoURL != "" {
					return videoURL
				}
			}
		}
	}
	keys := []string{"video_url", "videoUrl", "url"}
	if allowResultURL {
		keys = append(keys, "result_url", "resultUrl")
	}
	for _, key := range keys {
		if videoURL := strings.TrimSpace(stringField(payload, key)); IsPublicMediaURL(videoURL) {
			return videoURL
		}
	}
	return ""
}

func GrokVideoBody(input Input) (map[string]interface{}, error) {
	seconds := defaultString(input.Config.VideoSeconds, "6")
	duration, err := strconv.Atoi(seconds)
	if err != nil || duration <= 0 {
		duration = 6
	}
	body := map[string]interface{}{
		"model":    input.Config.Model,
		"prompt":   strings.TrimSpace(input.Prompt),
		"duration": duration,
		"seconds":  strconv.Itoa(duration),
	}
	if size := NormalizeVideoSize(input.Config.Size); size != "" {
		body["size"] = size
	}
	if ShouldSendNewAPIVideoImages(input) && len(input.ReferenceImages) > 0 {
		images := make([]string, 0, len(input.ReferenceImages))
		for _, image := range input.ReferenceImages {
			url, err := openAIImageInputURL(image)
			if err != nil {
				return nil, err
			}
			images = append(images, url)
		}
		body["image"] = images[0]
		body["images"] = images
	}
	return body, nil
}

func newAPIVideoURLResolver(config Config, id string) videoResultURLResolver {
	return videoTaskURLResolver(config, id, "/videos/"+id, func(state map[string]interface{}) (string, string) {
		status, rawURL := SeedancePollStatusAndURL(state)
		if rawURL == "" {
			rawURL = NewAPIVideoResultURL(state)
		}
		if rawURL == "" && VideoTaskSucceeded(status) {
			rawURL = APIURL(config.BaseURL, "/videos/"+id+"/content")
		}
		return status, rawURL
	})
}

func videoTaskURLResolver(config Config, taskID, path string, extract func(map[string]interface{}) (string, string)) videoResultURLResolver {
	return func(ctx context.Context) (string, error) {
		var state map[string]interface{}
		if err := GetJSON(WithRequestKind(ctx, "poll"), config, path, &state); err != nil {
			return "", err
		}
		var err error
		state, err = ValidateVideoTaskState(taskID, state)
		if err != nil {
			return "", err
		}
		return videoResultURL(extract(state))
	}
}

func ShouldSendNewAPIVideoImages(input Input) bool {
	if input.Metadata == nil {
		return true
	}
	operation, _ := input.Metadata["videoEditOperation"].(string)
	return strings.TrimSpace(operation) != "text_to_video"
}

// 本地测试 helper 没有能力配置时保留历史协议字段；真实系统任务会携带已解析的模型能力。
func VideoCapabilitySupportsAudio(input Input) bool {
	return input.VideoCapability == nil || input.VideoCapability.GenerateAudio.Supported
}

func VideoCapabilitySupportsWatermark(input Input) bool {
	return input.VideoCapability == nil || input.VideoCapability.Watermark.Supported
}

func VideoCapabilitySupportsDraft(input Input) bool {
	if input.VideoCapability != nil {
		return input.VideoCapability.Draft.Supported
	}
	return modelcatalog.IsSeedance25Model(input.Config.Model)
}

func VideoCapabilitySupportsReturnLastFrame(input Input) bool {
	if input.VideoCapability != nil {
		return input.VideoCapability.ReturnLastFrame.Supported
	}
	return modelcatalog.IsSeedance2Family(input.Config.InterfaceType, input.Config.Model)
}

func VideoRequestsReturnLastFrame(input Input) bool {
	if ParseBool(input.Config.VideoReturnLastFrame, false) || ParseBool(metadataString(input.Metadata, "returnLastFrame"), false) {
		return true
	}
	if b, ok := input.Metadata["returnLastFrame"].(bool); ok {
		return b
	}
	return false
}

func NewAPIVideoPromptText(input Input) string {
	return strings.TrimSpace(input.Prompt)
}
