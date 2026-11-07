package generation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/protocol"
)

func RunSeedanceVideosTask(ctx context.Context, input Input, pollPolicy VideoPollPolicy) (map[string]interface{}, error) {
	if managedConnection(input.Config) || IsBeefTVVideoConfig(ctx, input.Config) {
		return runManagedLegacyVideo(ctx, input, pollPolicy)
	}
	pollPolicy = videoPollPolicyForConfig(ctx, input.Config, pollPolicy)
	// 恢复任务已有 provider ID 时只能继续查询，绝不能重新 create，否则会产生第二个上游任务。
	// create 成功后的 poll/download 任一失败都保留失败或结果未知语义，不降级成“成功但无内容”。
	id := ResumedProviderRequestID(ctx)
	var created map[string]interface{}
	if id == "" {
		var body interface{}
		var err error
		body, err = SeedanceVideosRequestBody(input)
		if err != nil {
			return nil, err
		}
		post := PostJSON
		if err := post(ctx, input.Config, "/videos", body, &created); err != nil {
			return nil, UncertainVideoSubmission(ctx, err)
		}
		if data, ok := created["data"].(map[string]interface{}); ok {
			created = data
		}
		extracted, err := firstJSONString(created, "id", "task_id")
		if err != nil {
			return nil, SubmissionUnknownError{Cause: fmt.Errorf("视频接口任务 ID 无效：%w", err)}
		}
		id = extracted
	}
	if id == "" {
		return nil, SubmissionUnknownError{Cause: errors.New("视频接口没有返回任务 ID")}
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
		status, videoURL := SeedancePollStatusAndURL(state)
		if VideoTaskSucceeded(status) {
			lastFrameURL := SeedanceLastFrameURL(state)
			if videoURL != "" {
				data, mimeType, err := RunVideoDownload(ctx, id, pollPolicy, videoResultDownloader(input.Config, videoURL, id, newAPIVideoURLResolver(input.Config, id)))
				if err != nil {
					return VideoPollOutcome{}, fmt.Errorf("视频结果下载失败：%w", err)
				}
				mimeType = NormalizedMediaMIMEType(mimeType, data)
				videoMap := map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType}
				attachOptionalProviderLastFrame(ctx, input.Config, videoMap, lastFrameURL, true)
				return VideoPollOutcome{Done: true, Result: map[string]interface{}{"mode": "video", "video": videoMap}}, nil
			}
			data, mimeType, err := RunVideoDownload(ctx, id, pollPolicy, videoResultDownloader(input.Config, APIURL(input.Config.BaseURL, "/videos/"+id+"/content"), id, newAPIVideoURLResolver(input.Config, id)))
			if err != nil {
				return VideoPollOutcome{}, fmt.Errorf("视频任务成功但未返回视频 URL，备用内容下载失败：%w", err)
			}
			mimeType = NormalizedMediaMIMEType(mimeType, data)
			videoMap := map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType}
			attachOptionalProviderLastFrame(ctx, input.Config, videoMap, lastFrameURL, true)
			return VideoPollOutcome{Done: true, Result: map[string]interface{}{"mode": "video", "video": videoMap}}, nil
		}
		if status == "failed" || status == "cancelled" || status == "expired" {
			message := SeedanceErrorMessage(state)
			if message == "" {
				payload, _ := json.Marshal(map[string]interface{}{"error": map[string]string{"code": "task_failed", "message": "视频生成失败", "task_id": id}})
				message = string(payload)
			}
			return VideoPollOutcome{}, errors.New(message)
		}
		return VideoPollOutcome{}, nil
	})
}

// BeefTV reports the transport task as in_progress while the nested
// generation has completed and the output is being saved. Treat that nested
// terminal state as authoritative and use its URL for the content download.
func SeedancePollStatusAndURL(state map[string]interface{}) (string, string) {
	status := strings.ToLower(stringField(state, "status"))
	videoURL := stringField(state, "video_url")
	if metadata, ok := state["metadata"].(map[string]interface{}); ok {
		if generationStatus := strings.ToLower(stringField(metadata, "generation_status")); generationStatus != "" {
			status = generationStatus
		}
		if videoURL == "" {
			videoURL = stringField(metadata, "url")
		}
	}
	return status, videoURL
}

func SeedanceLastFrameURL(state map[string]interface{}) string {
	for _, key := range []string{"last_frame_url", "lastFrameUrl"} {
		if url := stringField(state, key); url != "" {
			return url
		}
	}
	for _, containerKey := range []string{"metadata", "content", "data", "output", "result", "task"} {
		if nested, ok := state[containerKey].(map[string]interface{}); ok {
			for _, key := range []string{"last_frame_url", "lastFrameUrl"} {
				if url := stringField(nested, key); url != "" {
					return url
				}
			}
		}
		if items, ok := state[containerKey].([]interface{}); ok {
			for _, raw := range items {
				if nested, ok := raw.(map[string]interface{}); ok {
					for _, key := range []string{"last_frame_url", "lastFrameUrl"} {
						if url := stringField(nested, key); url != "" {
							return url
						}
					}
				}
			}
		}
	}
	return ""
}

func attachOptionalLastFrame(ctx context.Context, videoResult map[string]interface{}, lastFrameURL string, allowHTTP bool) {
	attachOptionalProviderLastFrame(ctx, Config{}, videoResult, lastFrameURL, allowHTTP)
}

func attachOptionalProviderLastFrame(ctx context.Context, config Config, videoResult map[string]interface{}, lastFrameURL string, allowHTTP bool) {
	link := strings.TrimSpace(lastFrameURL)
	if link == "" {
		return
	}
	downloadCtx := WithRequestKind(ctx, "download")
	if !allowHTTP {
		downloadCtx = outbound.WithPublicHTTPS(downloadCtx)
	}
	var data []byte
	var mime string
	var err error
	if strings.TrimSpace(config.BaseURL) != "" {
		data, mime, err = GetProviderExternalBinary(downloadCtx, config, link)
	} else {
		data, mime, err = GetExternalBinary(downloadCtx, link)
	}
	if err != nil || len(data) == 0 {
		return
	}
	mime = NormalizedMediaMIMEType(mime, data)
	videoResult["lastFrame"] = map[string]interface{}{"dataUrl": DataURL(mime, data), "mimeType": mime}
}

// BeefTVVideoRequestBody assembles only user intent. The BeefTV adapter
// serializes canonical references and the server selects supplier parameters.
func BeefTVVideoRequestBody(input Input) (map[string]interface{}, error) {
	return beeftv.LegacyVideoBody(managedLegacyVideoInput(input))
}

func RunSeedanceAgentPlanVideoTask(ctx context.Context, input Input, pollPolicy VideoPollPolicy) (map[string]interface{}, error) {
	providerName := "Seedance"
	if model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(input.Config.InterfaceType)) {
		providerName = "火山方舟"
	}
	// Agent Plan 与 Videos API 使用相同的恢复合同：已有任务只查询，不重复创建。
	// 外部签名地址仍统一经过 doBinary 的 SSRF、状态码和响应大小检查。
	id := ResumedProviderRequestID(ctx)
	var created map[string]interface{}
	if id == "" {
		content, err := SeedanceContent(input)
		if err != nil {
			return nil, err
		}
		if model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(input.Config.InterfaceType)) && !modelcatalog.IsSeedance25Model(input.Config.Model) {
			for _, item := range content {
				if item["type"] == "image_url" {
					item["role"] = "reference_image"
				}
			}
		}
		body := SeedanceAgentPlanRequest{
			Model:      input.Config.Model,
			Content:    content,
			Ratio:      NormalizeSeedanceRatio(input.Config.Size),
			Resolution: NormalizeSeedanceResolution(input.Config.VQuality, input.Config.Model),
			Duration:   NormalizeSeedanceDuration(input.Config.VideoSeconds),
		}
		if modelcatalog.IsSeedance25Model(input.Config.Model) {
			options := SeedanceTaskOptions(input)
			body.Ratio, body.Duration = options.AspectRatio, options.Duration
			body.OmniReferenceTaskType = protocol.SeedanceOmniTaskType(options)
		}
		// 显式值优先；未设置时沿用能力判断的历史默认。
		if value, explicit := explicitVideoGenerateAudio(input); explicit {
			body.GenerateAudio = &value
		} else if VideoCapabilitySupportsAudio(input) {
			value := ParseBool(input.Config.VideoGenerateAudio, true)
			body.GenerateAudio = &value
		}
		if VideoCapabilitySupportsWatermark(input) {
			value := ParseBool(input.Config.VideoWatermark, false)
			body.Watermark = &value
		}
		if VideoRequestsReturnLastFrame(input) && VideoCapabilitySupportsReturnLastFrame(input) {
			value := true
			body.ReturnLastFrame = &value
		}
		if metadataString(input.Metadata, "videoDraftTaskId") != "" {
			body.Ratio = ""
			body.Duration = 0
			body.GenerateAudio = nil
			body.Draft = nil
			body.OmniReferenceTaskType = ""
		} else if ParseBool(input.Config.VideoDraft, false) && VideoCapabilitySupportsDraft(input) {
			value := true
			body.Draft = &value
			body.Resolution = "480p"
		}
		if err := PostJSON(ctx, input.Config, "/contents/generations/tasks", body, &created); err != nil {
			return nil, err
		}
		if data, ok := created["data"].(map[string]interface{}); ok {
			created = data
		}
		extracted, err := firstJSONString(created, "id")
		if err != nil {
			return nil, fmt.Errorf("%s接口任务 ID 无效：%w", providerName, err)
		}
		id = extracted
	}
	if id == "" {
		return nil, fmt.Errorf("%s接口没有返回任务 ID", providerName)
	}
	return RunVideoPollLoop(ctx, id, pollPolicy, func(ctx context.Context) (VideoPollOutcome, error) {
		var state map[string]interface{}
		if err := GetJSON(ctx, input.Config, "/contents/generations/tasks/"+id, &state); err != nil {
			return VideoPollOutcome{}, err
		}
		var err error
		state, err = ValidateVideoTaskState(id, state)
		if err != nil {
			return VideoPollOutcome{}, err
		}
		status := strings.ToLower(strings.TrimSpace(stringField(state, "status")))
		if status == "succeeded" {
			content, _ := state["content"].(map[string]interface{})
			videoURL := stringField(content, "video_url")
			if videoURL == "" {
				return VideoPollOutcome{}, fmt.Errorf("%s任务成功但没有返回视频 URL", providerName)
			}
			renew := videoTaskURLResolver(input.Config, id, "/contents/generations/tasks/"+id, func(state map[string]interface{}) (string, string) {
				content, _ := state["content"].(map[string]interface{})
				return stringField(state, "status"), stringField(content, "video_url")
			})
			data, mimeType, err := RunVideoDownload(ctx, id, pollPolicy, videoResultDownloader(input.Config, videoURL, id, renew))
			if err != nil {
				return VideoPollOutcome{}, fmt.Errorf("视频结果下载失败：%w", err)
			}
			mimeType = NormalizedMediaMIMEType(mimeType, data)
			videoMap := map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType}
			attachOptionalProviderLastFrame(ctx, input.Config, videoMap, stringField(content, "last_frame_url"), true)
			return VideoPollOutcome{Done: true, Result: map[string]interface{}{"mode": "video", "video": videoMap}}, nil
		}
		if status == "failed" || status == "cancelled" || status == "expired" {
			return VideoPollOutcome{}, fmt.Errorf("%s视频生成失败", providerName)
		}
		return VideoPollOutcome{}, nil
	})
}

func SeedanceContent(input Input) ([]map[string]interface{}, error) {
	if draftTaskID := metadataString(input.Metadata, "videoDraftTaskId"); draftTaskID != "" {
		return []map[string]interface{}{{"type": "draft_task", "draft_task": map[string]interface{}{"id": draftTaskID}}}, nil
	}
	content := make([]map[string]interface{}, 0, 1+len(input.ReferenceImages)+len(input.ReferenceVideos)+len(input.ReferenceAudios))
	text := SeedancePromptText(input)
	if strings.TrimSpace(text) != "" {
		content = append(content, map[string]interface{}{"type": "text", "text": text})
	}
	for _, image := range input.ReferenceImages {
		url, err := MediaReferenceURL(image)
		if err != nil {
			return nil, err
		}
		role := VideoImageRole(input, image)
		if modelcatalog.IsSeedance25Model(input.Config.Model) {
			role = SeedanceTaskImageRole(input, image)
		}
		content = append(content, map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": url}, "role": role})
	}
	for _, video := range input.ReferenceVideos {
		url, err := MediaReferenceURL(video)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]interface{}{"type": "video_url", "video_url": map[string]interface{}{"url": url}, "role": "reference_video"})
	}
	for _, audio := range input.ReferenceAudios {
		url, err := MediaReferenceURL(audio)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]interface{}{"type": "audio_url", "audio_url": map[string]interface{}{"url": url}, "role": "reference_audio"})
	}
	if len(content) == 0 {
		return nil, errors.New("请输入视频提示词或连接参考素材")
	}
	return content, nil
}

func SeedanceVideosRequestBody(input Input) (SeedanceVideosRequest, error) {
	if draftTaskID := metadataString(input.Metadata, "videoDraftTaskId"); draftTaskID != "" {
		return SeedanceVideosRequest{
			Model:       input.Config.Model,
			DraftTaskID: draftTaskID,
			Resolution:  NormalizeSeedanceResolution(input.Config.VQuality, input.Config.Model),
		}, nil
	}
	if len(input.ReferenceImages) == 0 && len(input.ReferenceVideos) == 0 && len(input.ReferenceAudios) > 0 && !videoCapabilityAllowsAudioOnly(input.VideoCapability) {
		return SeedanceVideosRequest{}, errors.New("当前视频模型不支持只用音频生成视频，请同时添加参考图片或参考视频")
	}
	body := SeedanceVideosRequest{
		Model:       input.Config.Model,
		Prompt:      SeedanceVideosPromptText(input),
		AspectRatio: NormalizeSeedanceVideosRatio(input.Config.Size),
		Duration:    NormalizeSeedanceVideosDuration(input.Config.VideoSeconds),
	}
	options := SeedanceTaskOptions(input)
	if modelcatalog.IsSeedance25Model(input.Config.Model) {
		body.AspectRatio, body.Duration = options.AspectRatio, options.Duration
		body.OmniReferenceTaskType = protocol.SeedanceOmniTaskType(options)
	}
	// 显式值优先；未设置时沿用能力判断的历史默认。
	if value, explicit := explicitVideoGenerateAudio(input); explicit {
		body.GenerateAudio = &value
	} else if VideoCapabilitySupportsAudio(input) {
		value := ParseBool(input.Config.VideoGenerateAudio, true)
		body.GenerateAudio = &value
	}
	if ParseBool(input.Config.VideoDraft, false) && VideoCapabilitySupportsDraft(input) {
		value := true
		body.Draft = &value
	}
	if VideoRequestsReturnLastFrame(input) && VideoCapabilitySupportsReturnLastFrame(input) {
		value := true
		body.ReturnLastFrame = &value
	}
	imageURLs := make([]string, 0, len(input.ReferenceImages))
	for _, image := range input.ReferenceImages {
		url, err := openAIImageInputURL(image)
		if err != nil {
			return SeedanceVideosRequest{}, err
		}
		imageURLs = append(imageURLs, url)
	}
	frameImageURLs, err := VideoFrameImageURLs(input, imageURLs)
	if err != nil {
		return SeedanceVideosRequest{}, err
	}
	if metadataString(input.Metadata, "videoEditOperation") == "reference_to_video" {
		body.ReferenceImageURLs = imageURLs
	} else if len(frameImageURLs) > 0 {
		body.ImageURLs = frameImageURLs
	} else if len(imageURLs) > 0 {
		body.ImageURL = imageURLs[0]
		if len(imageURLs) > 1 {
			body.ReferenceImageURLs = imageURLs[1:]
		}
	}
	videoURLs := make([]string, 0, len(input.ReferenceVideos))
	for _, video := range input.ReferenceVideos {
		url, err := SeedanceVideosMediaURL(video)
		if err != nil {
			return SeedanceVideosRequest{}, err
		}
		videoURLs = append(videoURLs, url)
	}
	if len(videoURLs) > 0 {
		body.ReferenceVideos = videoURLs
	}
	audioURLs := make([]string, 0, len(input.ReferenceAudios))
	for _, audio := range input.ReferenceAudios {
		url, err := SeedanceVideosMediaURL(audio)
		if err != nil {
			return SeedanceVideosRequest{}, err
		}
		audioURLs = append(audioURLs, url)
	}
	if len(audioURLs) > 0 {
		body.ReferenceAudios = audioURLs
	}
	return body, nil
}

// 兼容旧的 map 断言调用；实际请求路径使用类型化 Seedance DTO。
func SeedanceVideosBody(input Input) (map[string]interface{}, error) {
	body, err := SeedanceVideosRequestBody(input)
	if err != nil {
		return nil, err
	}
	return RequestAsMap(body)
}

func SeedancePromptText(input Input) string {
	return strings.TrimSpace(input.Prompt)
}

func SeedanceVideosPromptText(input Input) string {
	return strings.TrimSpace(input.Prompt)
}

func VideoImageRole(input Input, image Media) string {
	return VideoImageRoleOrDefault(input, image, "reference_image")
}

func SeedanceTaskImageRole(input Input, image Media) string {
	role := VideoImageRole(input, image)
	if !modelcatalog.IsSeedance25Model(input.Config.Model) {
		return role
	}
	if role == "reference_image" && metadataString(input.Metadata, "videoEditOperation") != "reference_to_video" &&
		metadataString(input.Metadata, "videoStartFrameNodeId") == "" && metadataString(input.Metadata, "videoEndFrameNodeId") == "" &&
		len(input.ReferenceVideos) == 0 && len(input.ReferenceAudios) == 0 {
		for index, candidate := range input.ReferenceImages {
			if candidate.ID == image.ID && candidate.DataURL == image.DataURL && candidate.URL == image.URL {
				if index == 0 {
					return "first_frame"
				}
				if index == 1 && len(input.ReferenceImages) == 2 {
					return "last_frame"
				}
				break
			}
		}
	}
	return role
}

func SeedanceTaskOptions(input Input) protocol.GenerationRequest {
	r := protocol.GenerationRequest{Model: input.Config.Model, AspectRatio: NormalizeSeedanceRatio(input.Config.Size), Duration: NormalizeSeedanceDuration(input.Config.VideoSeconds), Operation: metadataString(input.Metadata, "videoEditOperation")}
	for _, image := range input.ReferenceImages {
		r.Images = append(r.Images, protocol.MediaReference{Role: SeedanceTaskImageRole(input, image)})
	}
	for range input.ReferenceVideos {
		r.Videos = append(r.Videos, protocol.MediaReference{})
	}
	return protocol.NormalizeSeedanceTaskOptions(r)
}

func VideoImageRoleOrDefault(input Input, image Media, fallback string) string {
	if metadataString(input.Metadata, "videoEditOperation") == "reference_to_video" {
		return "reference_image"
	}
	if id := metadataString(input.Metadata, "videoStartFrameNodeId"); id != "" && image.ID == id {
		return "first_frame"
	}
	if id := metadataString(input.Metadata, "videoEndFrameNodeId"); id != "" && image.ID == id {
		return "last_frame"
	}
	return fallback
}

func VideoFrameImageURLs(input Input, imageURLs []string) ([]string, error) {
	if metadataString(input.Metadata, "videoEditOperation") == "reference_to_video" {
		return nil, nil
	}
	startFrameID := metadataString(input.Metadata, "videoStartFrameNodeId")
	endFrameID := metadataString(input.Metadata, "videoEndFrameNodeId")
	if startFrameID == "" && endFrameID == "" {
		return nil, nil
	}
	// image_urls 按首帧、尾帧、普通参考图排序，保持 JSON 视频协议的结构化帧语义。
	ordered := make([]string, 0, len(imageURLs))
	used := make([]bool, len(imageURLs))
	appendFrame := func(frameID string, label string) error {
		if frameID == "" {
			return nil
		}
		for index, image := range input.ReferenceImages {
			if index >= len(imageURLs) || image.ID != frameID {
				continue
			}
			ordered = append(ordered, imageURLs[index])
			used[index] = true
			return nil
		}
		return fmt.Errorf("已配置的%s参考图未包含在视频请求中", label)
	}
	if err := appendFrame(startFrameID, "首帧"); err != nil {
		return nil, err
	}
	if err := appendFrame(endFrameID, "尾帧"); err != nil {
		return nil, err
	}
	for index, imageURL := range imageURLs {
		if !used[index] {
			ordered = append(ordered, imageURL)
		}
	}
	return ordered, nil
}

func MediaReferenceURL(media Media) (string, error) {
	value := strings.TrimSpace(media.URL)
	if IsPublicMediaURL(value) || strings.HasPrefix(value, "asset://") || strings.HasPrefix(value, "data:") {
		return value, nil
	}
	value = strings.TrimSpace(media.DataURL)
	if value != "" {
		return value, nil
	}
	return "", errors.New("参考素材需要公网 URL、asset:// 素材 ID 或 data URL")
}

func SeedanceVideosMediaURL(media Media) (string, error) {
	value := strings.TrimSpace(media.DataURL)
	if strings.HasPrefix(value, "data:") {
		return value, nil
	}
	value = strings.TrimSpace(media.URL)
	if strings.HasPrefix(value, "data:") || strings.HasPrefix(value, "asset://") || IsPublicMediaURL(value) {
		return value, nil
	}
	return "", errors.New("Seedance /videos 参考素材需要公网 URL、asset:// 素材 ID 或 data URL")
}

func BeefTVAudioURL(media Media) (string, error) {
	value := strings.TrimSpace(media.URL)
	if strings.HasPrefix(value, "asset://") || IsPublicMediaURL(value) {
		return value, nil
	}
	if strings.HasPrefix(strings.ToLower(value), "data:") {
		return value, nil
	}
	data := strings.TrimSpace(media.DataURL)
	if strings.HasPrefix(strings.ToLower(data), "data:") {
		return data, nil
	}
	return "", errors.New("参考音频需要公网 URL、asset:// 素材 ID 或 data URL")
}

func SeedanceErrorMessage(state map[string]interface{}) string {
	if errorValue, ok := state["error"].(map[string]interface{}); ok {
		message := stringField(errorValue, "message")
		code := stringField(errorValue, "code")
		if code != "" {
			// Preserve the provider code across polling and persisted task errors.
			// Flattening it into prose lets ambiguous message keywords override it.
			payload, _ := json.Marshal(map[string]interface{}{"error": map[string]string{"code": code, "message": message}})
			return string(payload)
		}
		if message != "" {
			return message
		}
	}
	code := stringField(state, "error_code")
	if code != "" {
		return code
	}
	return ""
}
