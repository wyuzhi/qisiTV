package generation

// 图片生成：托管媒体、已安装的协议插件和通用 OpenAI Images。

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"qisitv/backend/internal/channelurl"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
	"qisitv/backend/internal/providerpreset"
)

func RunImageTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	if input.Mode == "" {
		input.Mode = "image"
	}
	if managedConnection(input.Config) {
		return runManagedImageTask(ctx, input)
	}
	// Older saved BYOK channels selected OpenAI even for Ark requests. Keep
	// those records readable while moving their execution to the installed plugin.
	if (input.Config.InterfaceType == "" || input.Config.InterfaceType == string(model.ChannelInterfaceOpenAIImage) || input.Config.InterfaceType == string(model.ChannelInterfaceVolcengineArkImage)) && providerpreset.SeedreamFamily(input.Config.Model) != "" {
		input.Config.InterfaceType = string(model.ChannelInterfaceVolcengineArkImage)
		if channelurl.BasePrefix(input.Config.BaseURL) == "" {
			parsed, _ := url.Parse(input.Config.BaseURL)
			if parsed != nil && parsed.Hostname() != "ark.ap-southeast.bytepluses.com" && parsed.Hostname() != "ark.cn-beijing.volces.com" {
				input.Config.BaseURL = strings.TrimRight(input.Config.BaseURL, "/") + "/v1"
			}
		}
	}
	if input.Config.InterfaceType != "" && input.Config.InterfaceType != string(model.ChannelInterfaceOpenAIImage) && input.Config.InterfaceType != string(model.ChannelInterfaceGrokImage) {
		ctx = EnsureOfficialProtocolAdapter(ctx, input.Config.InterfaceType)
		if _, ok := DeclarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType); !ok {
			return nil, RequestPreparationError{Cause: fmt.Errorf("图片协议插件未安装或已停用：%s", input.Config.InterfaceType)}
		}
		return RunDeclarativeProtocolTask(ctx, input)
	}
	if strings.TrimSpace(input.Config.InterfaceType) == string(model.ChannelInterfaceGrokImage) {
		ctx = EnsureOfficialProtocolAdapter(ctx, input.Config.InterfaceType)
		adapter, ok := DeclarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType)
		if !ok || !adapter.Metadata().Enabled || adapter.Metadata().UnavailableReason != "" {
			err := errors.New("Grok Images 图片插件未安装或未启用")
			// 恢复已有任务时保留提交证据，不能把查询失败记成新请求未发送。
			if ResumedProviderRequestID(ctx) == "" {
				return nil, ProtocolPreparationError{Cause: err}
			}
			return nil, err
		}
		if strings.TrimSpace(input.Mode) == "" {
			input.Mode = "image"
		}
		return RunProtocolAdapterTask(ctx, input, adapter)
	}
	if input.Config.ImageCapabilitiesVersion == nil || strings.TrimSpace(*input.Config.ImageCapabilitiesVersion) == "" {
		input.ImageCapability = modelcatalog.ApplyModelSpecificImageCapability(input.ImageCapability, input.Config.InterfaceType, input.Config.Model, input.Config.APIFormat)
	}
	outputCount := 1
	if input.ImageCapability != nil && input.ImageCapability.FixedOutputs > 0 {
		outputCount = input.ImageCapability.FixedOutputs
	}
	if _, ok := DeclarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType); ok {
		return RunDeclarativeProtocolTask(ctx, input)
	}
	var payload ImageResponse
	if input.Mask != nil {
		// 蒙版编辑是强校验写路径：协议能力不明确时必须失败，不能静默退化为整图重绘。
		if strings.TrimSpace(input.Config.InterfaceType) != string(model.ChannelInterfaceOpenAIImage) {
			return nil, errors.New("当前渠道未声明 OpenAI Images 编辑协议，已拒绝可能忽略蒙版的整图重绘")
		}
		if len(input.ReferenceImages) == 0 {
			return nil, errors.New("蒙版编辑必须提供与蒙版同尺寸的源图片")
		}
	}
	if len(input.ReferenceImages) > 0 || input.Mask != nil {
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		writeField(writer, "model", input.Config.Model)
		writeField(writer, "prompt", WithSystemPrompt(input.Config, input.Prompt))
		writeField(writer, "n", strconv.Itoa(outputCount))
		if ImageParameterSupported(input.ImageCapability, "response_format") {
			writeField(writer, "response_format", ImageResponseFormatValue(input.ImageCapability))
		}
		if ImageParameterSupported(input.ImageCapability, "output_format") {
			writeField(writer, "output_format", "png")
		}
		if ImageTransparentBackgroundSupported(input.ImageCapability) && input.Config.TransparentBackground == "true" {
			writeField(writer, "background", "transparent")
		}
		if ImageQualitySupported(input.ImageCapability) && input.Config.Quality != "" && !strings.EqualFold(strings.TrimSpace(input.Config.Quality), "auto") {
			writeField(writer, "quality", NormalizeImageQuality(input.Config.Quality))
		}
		if key, value := ImageSizeParameter(input.ImageCapability, input.Config.Size); value != "" {
			writeField(writer, key, value)
		}
		if input.ImageCapability != nil && input.ImageCapability.SequentialGeneration.Supported {
			if maxImages := sequentialMaxImagesForInput(input); maxImages > 1 {
				writeField(writer, "sequential_image_generation", "auto")
				writeField(writer, "sequential_image_generation_options", fmt.Sprintf(`{"max_images":%d}`, maxImages))
			}
		}
		for _, image := range input.ReferenceImages {
			if err := writeMediaPart(writer, "image", image); err != nil {
				return nil, err
			}
		}
		if input.Mask != nil {
			if err := writeMediaPart(writer, "mask", *input.Mask); err != nil {
				return nil, err
			}
		}
		if err := writer.Close(); err != nil {
			return nil, err
		}
		if err := PostForm(ctx, input.Config, "/images/edits", writer.FormDataContentType(), body, &payload); err != nil {
			return nil, err
		}
	} else {
		body := map[string]interface{}{
			"model":  input.Config.Model,
			"prompt": WithSystemPrompt(input.Config, input.Prompt),
			"n":      outputCount,
		}
		if ImageParameterSupported(input.ImageCapability, "response_format") {
			body["response_format"] = ImageResponseFormatValue(input.ImageCapability)
		}
		if ImageParameterSupported(input.ImageCapability, "output_format") {
			body["output_format"] = "png"
		}
		if ImageTransparentBackgroundSupported(input.ImageCapability) && input.Config.TransparentBackground == "true" {
			body["background"] = "transparent"
		}
		if ImageQualitySupported(input.ImageCapability) && input.Config.Quality != "" && !strings.EqualFold(strings.TrimSpace(input.Config.Quality), "auto") {
			body["quality"] = NormalizeImageQuality(input.Config.Quality)
		}
		if key, value := ImageSizeParameter(input.ImageCapability, input.Config.Size); value != "" {
			body[key] = value
		}
		if input.ImageCapability != nil && input.ImageCapability.SequentialGeneration.Supported {
			if maxImages := sequentialMaxImagesForInput(input); maxImages > 1 {
				body["sequential_image_generation"] = "auto"
				body["sequential_image_generation_options"] = map[string]interface{}{"max_images": maxImages}
			}
		}
		if err := PostJSON(ctx, input.Config, "/images/generations", body, &payload); err != nil {
			return nil, err
		}
	}
	images, err := ImageDataURLs(payload)
	if err != nil {
		return nil, err
	}
	result := map[string]interface{}{"mode": "image", "images": images}
	if payload.Usage != nil {
		result["usage"] = payload.Usage
	}
	return result, nil
}

func MaterializeImageDataURLs(ctx context.Context, config Config, payload ImageResponse) ([]map[string]string, error) {
	images, err := ImageDataURLs(payload)
	if err != nil {
		return nil, err
	}
	for _, image := range images {
		value := strings.TrimSpace(image["dataUrl"])
		if strings.HasPrefix(value, "data:image/") {
			continue
		}
		if !IsPublicMediaURL(value) {
			return nil, errors.New("图片接口没有返回可下载的图片")
		}
		// URL results must become bytes before task persistence. Keep provider
		// authentication on same-origin content routes, never on external CDNs.
		data, mimeType, err := GetProviderExternalBinary(WithRequestKind(ctx, "download"), config, value)
		if err != nil {
			return nil, fmt.Errorf("图片结果下载失败：%w", err)
		}
		detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
		mimeType = strings.ToLower(NormalizedMediaMIMEType(mimeType, data))
		if len(data) == 0 || strings.Contains(detected, "json") || strings.HasPrefix(detected, "text/") || !strings.HasPrefix(mimeType, "image/") {
			return nil, fmt.Errorf("图片结果无效：%s", defaultString(detected, mimeType))
		}
		image["dataUrl"] = DataURL(mimeType, data)
		image["mimeType"] = mimeType
	}
	return images, nil
}

func ImageDataURLs(payload ImageResponse) ([]map[string]string, error) {
	if len(payload.Data) == 0 {
		return nil, errors.New("接口没有返回图片")
	}
	images := make([]map[string]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		if b64, ok := item["b64_json"].(string); ok && b64 != "" {
			images = append(images, map[string]string{"dataUrl": "data:image/png;base64," + b64})
			continue
		}
		if url, ok := item["url"].(string); ok && url != "" {
			images = append(images, map[string]string{"dataUrl": url})
		}
	}
	if len(images) == 0 {
		return nil, errors.New("接口没有返回可用图片")
	}
	return images, nil
}
