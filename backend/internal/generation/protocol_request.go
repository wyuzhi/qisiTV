package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/channelurl"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/protocol"
)

// ProtocolRequestFor builds the request for one resolved adapter. A model saved
// with a retired interface ID keeps the options it saved under that ID.
func ProtocolRequestFor(input Input, adapter protocol.Adapter) protocol.GenerationRequest {
	request := ProtocolRequestFromInput(input)
	if adapter == nil {
		return request
	}
	return protocol.WithRequestedAliasOptions(request, input.Config.InterfaceType, adapter.Metadata())
}

func ProtocolRequestFromInput(input Input) protocol.GenerationRequest {
	resolution := strings.TrimSpace(input.Config.VQuality)
	if input.Mode == "video" {
		if declared := videoResolutionNameRequest(input.VideoCapability, resolution); declared != "" {
			resolution = declared
		}
	}
	aspectRatio := strings.TrimSpace(input.Config.Size)
	if input.Mode == "image" {
		aspectRatio = ProtocolImageAspectRatio(input)
	}
	request := protocol.GenerationRequest{
		Capability:    protocol.Capability(input.Mode),
		Model:         input.Config.Model,
		Prompt:        input.Prompt,
		Instructions:  strings.TrimSpace(input.Config.SystemPrompt),
		Images:        ProtocolImageReferences(input),
		Videos:        ProtocolMediaReferences(input.ReferenceVideos, "video"),
		Audios:        ProtocolMediaReferences(input.ReferenceAudios, "audio"),
		AspectRatio:   aspectRatio,
		Resolution:    resolution,
		Quality:       input.Config.Quality,
		GenerateAudio: ParseBool(input.Config.VideoGenerateAudio, false),
		Watermark:     ParseBool(input.Config.VideoWatermark, false),
		Operation:     firstNonEmpty(metadataString(input.Metadata, "videoEditOperation"), metadataString(input.Metadata, "videoOperation")),
		Extra: map[string]any{
			"videoSeconds": input.Config.VideoSeconds,
			"audioVoice":   strings.TrimSpace(input.Config.AudioVoice),
			"audioFormat":  defaultString(input.Config.AudioFormat, "mp3"),
			"audioSpeed":   defaultString(input.Config.AudioSpeed, "1"),
			"count":        input.Config.Count,
		},
	}
	// 显式 false 与未设置必须区分：插件在未设置时省略声音开关，避免把上游默认值
	// 当成用户的选择；设置过 true/false 时按原值发出。
	if value, explicit := explicitVideoGenerateAudio(input); explicit {
		request.Extra["generateAudio"] = value
	}
	// 比例写法额外暴露给只认 aspect_ratio 的上游；像素尺寸不进入比例字段。
	if value := strings.TrimSpace(input.Config.Size); input.Mode == "video" && IsVideoAspectRatioLiteral(value) {
		request.Extra["aspectRatio"] = value
	}
	for _, message := range input.TextHistory {
		role := strings.ToLower(strings.TrimSpace(message.Role))
		if role != "user" && role != "assistant" && role != "system" {
			continue
		}
		if content := strings.TrimSpace(message.Content); content != "" {
			request.Messages = append(request.Messages, protocol.Message{Role: role, Content: content})
		}
	}
	if input.Mode == "video" {
		if draftTaskID := metadataString(input.Metadata, "videoDraftTaskId"); draftTaskID != "" {
			request.Extra["draft_task_id"] = draftTaskID
			request.Operation = "draft_to_final"
		} else if ParseBool(input.Config.VideoDraft, false) && VideoCapabilitySupportsDraft(input) {
			request.Resolution = "480p"
			request.Extra["draft"] = true
		}
		if VideoRequestsReturnLastFrame(input) && VideoCapabilitySupportsReturnLastFrame(input) {
			request.Extra["return_last_frame"] = true
		}
		if input.VideoCapability != nil && input.VideoCapability.TaskTypeConstraints {
			request.Extra["taskTypeConstraints"] = true
		}
	}
	if input.Mode == "image" && input.ImageCapability != nil && input.ImageCapability.SequentialGeneration.Supported {
		if maxImages := sequentialMaxImagesForInput(input); maxImages > 1 {
			request.Extra["sequential_image_generation_max"] = maxImages
		}
	}
	request.Inputs = append(request.Inputs, request.Images...)
	request.Inputs = append(request.Inputs, request.Videos...)
	request.Inputs = append(request.Inputs, request.Audios...)
	if input.MaxOutputTokens > 0 {
		request.Extra["max_output_tokens"] = input.MaxOutputTokens
		request.Extra["max_tokens"] = input.MaxOutputTokens
	}
	if duration, err := strconv.Atoi(strings.TrimSpace(input.Config.VideoSeconds)); err == nil && (duration > 0 || (duration == -1 && (model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(input.Config.InterfaceType)) || (input.VideoCapability != nil && input.VideoCapability.TaskTypeConstraints)))) {
		request.Duration = duration
	}
	if count, err := strconv.Atoi(strings.TrimSpace(input.Config.Count)); err == nil && count > 0 {
		request.ImageCount = count
	}
	request.Output = protocol.OutputOptions{
		Count: request.ImageCount, Duration: request.Duration, AspectRatio: request.AspectRatio,
		Resolution: request.Resolution, Quality: request.Quality, GenerateAudio: request.GenerateAudio,
		Watermark: request.Watermark, Format: input.Config.AudioFormat,
	}
	if input.Mode == "image" {
		// Project saved UI options without interpreting provider/model rules.
		// Only the selected plugin decides which fields it accepts and sends.
		request.Output.Options = map[string]any{
			"mode": input.Config.SeedreamMode, "format": input.Config.SeedreamOutputFormat,
			"watermark": input.Config.SeedreamWatermark, "optimize": input.Config.SeedreamOptimize,
			"maxImages": input.Config.SeedreamMaxImages, "transparent": input.Config.TransparentBackground,
		}
	}
	if instructions := strings.TrimSpace(input.Config.AudioInstructions); instructions != "" {
		request.Extra["audioInstructions"] = instructions
	}
	request.ProviderOptions = make(map[string]map[string]any)
	if configured, ok := input.Metadata["providerOptions"].(map[string]any); ok {
		for namespace, raw := range configured {
			if options, ok := raw.(map[string]any); ok {
				request.ProviderOptions[strings.TrimSpace(namespace)] = options
			}
		}
	}
	applyImageResponseFormatOption(&request, input)
	if input.Mode == "video" {
		if usesSeedanceTaskOptions(input.Config) || (input.VideoCapability != nil && input.VideoCapability.TaskTypeConstraints) {
			request = protocol.NormalizeSeedanceTaskOptions(request)
		} else if request.Extra["draft"] == true || request.Extra["draft_task_id"] != nil {
			request = protocol.NormalizeVideoDraftTaskOptions(request)
		}
	}
	return request
}

// applyImageResponseFormatOption 把渠道上选定的 response_format 写进 providerOptions。
// 官方 OpenAI Images 插件（plugin-packages/openai-images）自己拼请求体，只从
// providerOptions.openai-image.response_format 取这个参数，不读能力配置；
// 不写进去，插件启用时界面上选 url 也发不出去。
// 只在渠道显式选过取值时覆盖，渠道里手配的 providerOptions 在没选过时照旧生效。
func applyImageResponseFormatOption(request *protocol.GenerationRequest, input Input) {
	if input.Mode != "image" || request == nil {
		return
	}
	if strings.TrimSpace(input.Config.InterfaceType) != string(model.ChannelInterfaceOpenAIImage) {
		return
	}
	profile := input.ImageCapability
	if profile == nil || !profile.ResponseFormat.Supported {
		return
	}
	if strings.TrimSpace(profile.ResponseFormat.Value) == "" {
		return
	}
	namespace := string(model.ChannelInterfaceOpenAIImage)
	options := make(map[string]any, len(request.ProviderOptions[namespace])+1)
	for key, value := range request.ProviderOptions[namespace] {
		options[key] = value
	}
	options["response_format"] = ImageResponseFormatValue(profile)
	request.ProviderOptions[namespace] = options
}

// protocolImageAspectRatio keeps the canvas size for protocol AspectRatio unless
// the capability field is size and the adapter copies that value onto body.size
// with no ratio table of its own (openai-images).
func ProtocolImageAspectRatio(input Input) string {
	raw := strings.TrimSpace(input.Config.Size)
	key, value := ImageSizeParameter(input.ImageCapability, input.Config.Size)
	if key != "size" || value == "" {
		return raw
	}
	if strings.TrimSpace(input.Config.InterfaceType) != string(model.ChannelInterfaceOpenAIImage) {
		return raw
	}
	return value
}

func ProtocolImageReferences(input Input) []protocol.MediaReference {
	if input.Mode == "video" {
		return ProtocolVideoImageReferences(input)
	}
	result := make([]protocol.MediaReference, 0, len(input.ReferenceImages)+1)
	for index, value := range input.ReferenceImages {
		item := ProtocolMediaReference(value, "image", index)
		item.Role = "reference_image"
		if input.Mode == "image" {
			item.Role = "edit_source"
		}
		if item.URL != "" || item.DataURL != "" {
			result = append(result, item)
		}
	}
	if input.Mask != nil {
		mask := ProtocolMediaReference(*input.Mask, "image", len(result))
		mask.Role = "mask"
		if mask.URL != "" || mask.DataURL != "" {
			result = append(result, mask)
		}
	}
	return result
}

func ProtocolVideoImageReferences(input Input) []protocol.MediaReference {
	result := make([]protocol.MediaReference, 0, len(input.ReferenceImages))
	fallbackRole := ""
	if metadataString(input.Metadata, "videoStartFrameNodeId") != "" || metadataString(input.Metadata, "videoEndFrameNodeId") != "" {
		fallbackRole = "reference_image"
	}
	for index, value := range input.ReferenceImages {
		item := ProtocolMediaReference(value, "image", index)
		item.Role = VideoImageRoleOrDefault(input, value, fallbackRole)
		if modelcatalog.IsSeedance25Model(input.Config.Model) && item.Role == "" && (usesSeedanceTaskOptions(input.Config) || (input.VideoCapability != nil && input.VideoCapability.TaskTypeConstraints)) {
			item.Role = SeedanceTaskImageRole(input, value)
		}
		if item.URL != "" || item.DataURL != "" {
			result = append(result, item)
		}
	}
	return result
}

func ProtocolMediaReferences(values []Media, kind string) []protocol.MediaReference {
	result := make([]protocol.MediaReference, 0, len(values))
	for index, value := range values {
		item := ProtocolMediaReference(value, kind, index)
		if kind == "video" {
			item.Role = "reference_video"
		} else if kind == "audio" {
			item.Role = "reference_audio"
		}
		if item.URL != "" || item.DataURL != "" {
			result = append(result, item)
		}
	}
	return result
}

func ProtocolMediaReference(value Media, kind string, order int) protocol.MediaReference {
	return protocol.MediaReference{
		ID: strings.TrimSpace(value.ID), URL: strings.TrimSpace(value.URL), DataURL: strings.TrimSpace(value.DataURL),
		Kind: kind, MIMEType: firstNonEmpty(strings.TrimSpace(value.MimeType), strings.TrimSpace(value.Type)), Name: strings.TrimSpace(value.Name), Order: order,
		Metadata: map[string]any{"bytes": value.Bytes, "width": value.Width, "height": value.Height, "durationMs": value.DurationMs, "storageKey": strings.TrimSpace(value.StorageKey)},
	}
}

func ExecuteProtocolRequest(ctx context.Context, config Config, spec protocol.RequestSpec) ([]byte, error) {
	data, _, err := ExecuteProtocolBinaryRequest(ctx, config, spec)
	return data, err
}

// executeProtocolBinaryRequest 是声明式插件与宿主网络能力之间的边界。manifest 只能声明
// method/path/body/auth；最终 URL 校验、凭证注入、SSRF、超时、大小限制和审计仍由宿主统一执行，
// 插件不能通过自定义请求规格绕过这些安全约束。
func ExecuteProtocolBinaryRequest(ctx context.Context, config Config, spec protocol.RequestSpec) ([]byte, string, error) {
	return ExecuteProtocolBinaryRequestWithConsumer(ctx, config, spec, nil)
}

func ExecuteProtocolBinaryRequestWithConsumer(ctx context.Context, config Config, spec protocol.RequestSpec, consume func(string, []byte)) ([]byte, string, error) {
	if err := spec.Validate(); err != nil {
		return nil, "", RequestPreparationError{Cause: err}
	}
	method := strings.ToUpper(strings.TrimSpace(spec.Method))
	body, contentType, err := ProtocolRequestBody(ctx, config, spec)
	if err != nil {
		return nil, "", RequestPreparationError{Cause: err}
	}
	requestURL, err := ProtocolRequestURL(config.BaseURL, spec)
	if err != nil {
		return nil, "", RequestPreparationError{Cause: err}
	}
	req, err := http.NewRequestWithContext(ctx, method, requestURL, body)
	if err != nil {
		return nil, "", RequestPreparationError{Cause: err}
	}
	if method == http.MethodPut && contentType == "application/octet-stream" && req.Body != nil {
		req.Body = io.NopCloser(referenceUploadReader(ctx, req.Body))
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	idle, _ := ctx.Value(videoDeliveryRequestContext{}).(time.Duration)
	if idle == 0 || SameProviderOrigin(config.BaseURL, requestURL) {
		for name, value := range spec.Headers {
			req.Header.Set(name, value)
		}
		outbound.ApplyOutboundHeaders(req, config.Headers)
		if err := ApplyProtocolAuth(req, config, spec.Auth); err != nil {
			return nil, "", RequestPreparationError{Cause: err}
		}
	}
	applyBeefTVVideoDeliveryHeader(ctx, config, req)
	if consume != nil {
		req.Header.Set("Accept", "text/event-stream")
		return DoBinaryWithConsumer(req, consume)
	}
	return DoBinary(req)
}

func ProtocolRequestBody(ctx context.Context, config Config, spec protocol.RequestSpec) (io.Reader, string, error) {
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(spec.ContentType, ";")[0]))
	if spec.Body == nil && len(spec.Files) == 0 {
		return nil, "", nil
	}
	switch contentType {
	case "", "application/json":
		data, err := json.Marshal(spec.Body)
		if err != nil {
			return nil, "", err
		}
		// Ark documents a 64 MiB JSON request limit. Measure the actual wire
		// representation, including base64; URL resource sizes are irrelevant.
		if model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(config.InterfaceType)) && int64(len(data)) > VideoJSONRequestLimitBytes {
			return nil, "", ErrVideoJSONRequestTooLarge
		}
		return bytes.NewReader(data), "application/json", nil
	case "application/x-www-form-urlencoded":
		values := url.Values{}
		for key, value := range ProtocolBodyObject(spec.Body) {
			for _, item := range ProtocolFormValues(value) {
				values.Add(key, item)
			}
		}
		return strings.NewReader(values.Encode()), contentType, nil
	case "multipart/form-data":
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		keys := make([]string, 0)
		for key := range ProtocolBodyObject(spec.Body) {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			for _, item := range ProtocolFormValues(ProtocolBodyObject(spec.Body)[key]) {
				if err := writer.WriteField(key, item); err != nil {
					_ = writer.Close()
					return nil, "", err
				}
			}
		}
		for _, file := range spec.Files {
			data, detectedMIME, err := ProtocolMediaBytes(ctx, config, file.Reference)
			if err != nil {
				_ = writer.Close()
				return nil, "", fmt.Errorf("读取 multipart 文件 %s 失败：%w", file.Name, err)
			}
			filename := SafeProtocolFilename(file.Filename)
			mimeType := strings.TrimSpace(file.MIMEType)
			if mimeType == "" {
				mimeType = detectedMIME
			}
			header := make(textproto.MIMEHeader)
			header.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, file.Name, filename))
			header.Set("Content-Type", defaultString(mimeType, "application/octet-stream"))
			part, err := writer.CreatePart(header)
			if err != nil {
				_ = writer.Close()
				return nil, "", err
			}
			if _, err := part.Write(data); err != nil {
				_ = writer.Close()
				return nil, "", err
			}
		}
		if err := writer.Close(); err != nil {
			return nil, "", err
		}
		return bytes.NewReader(body.Bytes()), writer.FormDataContentType(), nil
	case "application/octet-stream":
		switch value := spec.Body.(type) {
		case []byte:
			return bytes.NewReader(value), contentType, nil
		case string:
			if strings.HasPrefix(value, "data:") {
				mimeType, data, err := DecodeProviderDataURL(value)
				if err != nil {
					return nil, "", err
				}
				return bytes.NewReader(data), defaultString(mimeType, contentType), nil
			}
			return strings.NewReader(value), contentType, nil
		default:
			return nil, "", fmt.Errorf("二进制协议请求体必须是字节或字符串")
		}
	default:
		return nil, "", fmt.Errorf("声明式协议暂不支持 %s 请求体", spec.ContentType)
	}
}

func ProtocolBodyObject(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func ProtocolFormValues(value any) []string {
	switch typed := value.(type) {
	case nil:
		return nil
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			result = append(result, ProtocolFormValues(item)...)
		}
		return result
	case string:
		return []string{typed}
	case bool:
		return []string{strconv.FormatBool(typed)}
	case float64:
		return []string{strconv.FormatFloat(typed, 'f', -1, 64)}
	case int:
		return []string{strconv.Itoa(typed)}
	default:
		data, err := json.Marshal(typed)
		if err != nil {
			return nil
		}
		return []string{string(data)}
	}
}

func SafeProtocolFilename(value string) string {
	value = strings.TrimSpace(value)
	if index := strings.LastIndexAny(value, `/\\`); index >= 0 {
		value = value[index+1:]
	}
	value = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 || r == '"' {
			return -1
		}
		return r
	}, value)
	if value == "" {
		return "upload.bin"
	}
	return value
}

func ProtocolRequestURL(baseURL string, spec protocol.RequestSpec) (string, error) {
	if !spec.OriginPath {
		if spec.DefaultPathPrefix != "" {
			return AppendProtocolQuery(channelurl.Join(baseURL, spec.Path, spec.DefaultPathPrefix), spec.Query)
		}
		return AppendProtocolQuery(APIURL(baseURL, spec.Path), spec.Query)
	}
	base, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("协议根路径请求的 Base URL 无效")
	}
	requestPath, err := url.Parse(spec.Path)
	if err != nil || !strings.HasPrefix(requestPath.Path, "/") {
		return "", fmt.Errorf("协议根路径请求必须使用绝对路径")
	}
	base.Path = requestPath.Path
	base.RawPath = requestPath.RawPath
	base.RawQuery = requestPath.RawQuery
	base.Fragment = ""
	return AppendProtocolQuery(base.String(), spec.Query)
}

func AppendProtocolQuery(rawURL string, values map[string][]string) (string, error) {
	if len(values) == 0 {
		return rawURL, nil
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	query := parsed.Query()
	for key, items := range values {
		for _, item := range items {
			query.Add(key, item)
		}
	}
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}
