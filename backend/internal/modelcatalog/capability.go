package modelcatalog

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/providerpreset"
)

func NormalizeCapability(value string) string {
	return normalizeCapability(value)
}

func CapabilityFromTaskType(taskType string) string {
	return capabilityFromTaskType(taskType)
}

func normalizeCapability(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "text", "image", "video", "audio":
		return normalized
	default:
		return ""
	}
}

func capabilityFromTaskType(taskType string) string {
	value := strings.ToLower(taskType)
	for _, capability := range []string{"video", "image", "audio", "text"} {
		if strings.Contains(value, capability) {
			return capability
		}
	}
	if strings.Contains(value, "storyboard") || strings.Contains(value, "agent") {
		return "text"
	}
	return ""
}

func DefaultModelCapabilityConfig(protocol string) *ModelCapabilityConfig {
	return DefaultModelCapabilityConfigForModel(protocol, "")
}

func DefaultModelCapabilityConfigForModel(protocol string, modelName string) *ModelCapabilityConfig {
	// 文本模型是否支持视觉输入不能从协议或模型名可靠推断，默认关闭，由管理员按真实上游能力开启。
	streaming := true
	thinking := strings.EqualFold(strings.TrimSpace(protocol), "openai-response")
	text := &TextCapabilityConfig{Streaming: &streaming, Thinking: &thinking, References: TextReferenceConfig{PromptMaxChars: 32000}}
	video := defaultVideoCapabilityConfig(protocol, modelName)
	return &ModelCapabilityConfig{Version: 1, Text: text, Image: DefaultImageCapabilityConfig(protocol, modelName), Video: video}
}

func DecodeModelCapabilityConfig(raw string) (*ModelCapabilityConfig, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var value ModelCapabilityConfig
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return nil, err
	}
	return &value, nil
}

// normalizedChannelModelCapability 从持久化记录恢复渠道模型的权威能力合同。
// 目录读取可以选择隔离损坏记录；任务创建等写路径必须把错误向上返回并失败关闭。
func normalizedChannelModelCapability(channelModel *model.ChannelModel) (*ModelCapabilityConfig, error) {
	if channelModel == nil {
		return nil, errors.New("渠道模型为空")
	}
	capability := normalizeCapability(channelModel.Capability)
	if capability == "audio" {
		return nil, nil
	}
	if capability != "text" && capability != "image" && capability != "video" {
		return nil, fmt.Errorf("不支持的渠道模型能力：%s", channelModel.Capability)
	}
	config, err := DecodeModelCapabilityConfig(channelModel.CapabilityConfigJSON)
	if err != nil {
		return nil, fmt.Errorf("解析渠道模型能力配置失败：%w", err)
	}
	normalized, err := NormalizeModelCapabilityConfigForModel(capability, string(channelModel.Protocol), kernel.FirstNonEmpty(channelModel.ProviderModelKey, channelModel.ModelKey), config)
	if err != nil {
		return nil, err
	}
	return normalized, nil
}

func NormalizeModelCapabilityConfig(capability string, protocol string, input *ModelCapabilityConfig) (*ModelCapabilityConfig, error) {
	return NormalizeModelCapabilityConfigForModel(capability, protocol, "", input)
}

func NormalizeModelCapabilityConfigForModel(capability string, protocol string, modelName string, input *ModelCapabilityConfig) (*ModelCapabilityConfig, error) {
	if capability != "text" && capability != "image" && capability != "video" {
		return nil, nil
	}
	if capability == "text" {
		if input == nil || input.Text == nil {
			return nil, kernel.BadAuthRequest("请配置文本模型能力参数")
		}
		text := *input.Text
		if text.Streaming == nil {
			streaming := true
			text.Streaming = &streaming
		}
		if text.Thinking == nil {
			thinking := strings.EqualFold(strings.TrimSpace(protocol), "openai-response")
			text.Thinking = &thinking
		}
		value := &ModelCapabilityConfig{Version: 1, Text: &text}
		if err := validateTextCapabilityConfig(value.Text); err != nil {
			return nil, err
		}
		return value, nil
	}
	if capability == "image" {
		if input == nil || input.Image == nil {
			return nil, kernel.BadAuthRequest("请配置图片模型能力参数")
		}
		value := &ModelCapabilityConfig{Version: 1, Image: applyModelSpecificImageCapability(input.Image, protocol, modelName, "")}
		if err := validateImageCapabilityConfig(value.Image); err != nil {
			return nil, err
		}
		return value, nil
	}
	if input == nil || input.Video == nil {
		return nil, kernel.BadAuthRequest("请配置视频模型能力参数")
	}
	value := &ModelCapabilityConfig{Version: 1, Video: applyModelSpecificVideoCapability(input.Video, protocol, modelName)}
	if err := validateVideoCapabilityConfig(value.Video); err != nil {
		return nil, err
	}
	return value, nil
}

type CapabilityNormalizer struct{}

func NewCapabilityNormalizer() CapabilityNormalizer {
	return CapabilityNormalizer{}
}

func (CapabilityNormalizer) NormalizeModelCapabilityDraft(draft ModelCapabilityDraft) (*ModelCapabilityConfig, error) {
	return NormalizeModelCapabilityDraft(draft)
}

func NormalizeModelCapabilityDraft(draft ModelCapabilityDraft) (*ModelCapabilityConfig, error) {
	if draft.VideoCapabilitiesVersion != nil && strings.TrimSpace(*draft.VideoCapabilitiesVersion) != "" {
		if draft.CapabilityConfig == nil || draft.CapabilityConfig.Video == nil {
			return nil, kernel.BadAuthRequest("当前视频模型能力尚未加载，请在设置中刷新模型列表")
		}
		if err := validateVideoCapabilityConfig(draft.CapabilityConfig.Video); err != nil {
			return nil, err
		}
		return &ModelCapabilityConfig{Version: 1, Video: draft.CapabilityConfig.Video}, nil
	}
	modelName := strings.TrimSpace(draft.Model)
	protocol := strings.ToLower(strings.TrimSpace(kernel.FirstNonEmpty(draft.Protocol, draft.InterfaceType)))
	rawCapability := strings.TrimSpace(kernel.FirstNonEmpty(draft.Capability, draft.Type, draft.Category))
	capability := normalizeCapability(rawCapability)
	if rawCapability != "" && capability == "" {
		return nil, kernel.BadAuthRequest("模型能力类型无效")
	}
	baseURL := strings.TrimSpace(draft.BaseURL)
	channelID := strings.TrimSpace(draft.ChannelID)

	isBeefRoute := providerpreset.IsBeefTVEndpoint(baseURL) || (baseURL == "" && strings.EqualFold(channelID, "beeftv"))
	if isBeefRoute {
		if contract, ok := providerpreset.BeefTVVideoContract(modelName); ok {
			protocol = contract.Protocol
			capability = "video"
		} else if isSeedance2Family("newapi", modelName) && (protocol == "" || protocol == "openai" || protocol == "openai-response" || protocol == "chat-completion" || protocol == "openai-videos" || protocol == "newapi-channel-1" || protocol == "newapi-channel-2") {
			protocol = "newapi"
			capability = "video"
		}
	}
	if protocol == "" {
		switch capability {
		case "image":
			protocol = "openai-image"
		case "video":
			protocol = "newapi"
		case "audio":
			protocol = "openai-audio"
		default:
			protocol = "openai"
		}
	}
	if capability == "" {
		capability = defaultCapabilityForProtocol(protocol)
	}

	result := DefaultModelCapabilityConfigForModel(protocol, modelName)
	localItem := LocalChannelModel{
		ChannelID:                channelID,
		BaseURL:                  baseURL,
		Model:                    modelName,
		Capability:               capability,
		Protocol:                 protocol,
		VideoCapabilitiesVersion: draft.VideoCapabilitiesVersion,
	}

	input := draft.CapabilityConfig
	if input != nil {
		if input.Text != nil {
			text := *input.Text
			if text.Streaming == nil && result.Text != nil {
				text.Streaming = result.Text.Streaming
			}
			if text.Thinking == nil && result.Text != nil {
				text.Thinking = result.Text.Thinking
			}
			if text.References.PromptMaxChars <= 0 && result.Text != nil {
				text.References.PromptMaxChars = result.Text.References.PromptMaxChars
			}
			normalizedText, err := NormalizeModelCapabilityConfigForModel("text", protocol, modelName, &ModelCapabilityConfig{Version: 1, Text: &text})
			if err != nil {
				return nil, err
			}
			result.Text = normalizedText.Text
		}
		if input.Image != nil {
			fixedBeefImage := false
			if strings.EqualFold(protocol, "openai-image") && isBeefRoute {
				if contract, ok := providerpreset.BeefTVImageContract(modelName); ok && contract.FixedOutputs > 0 {
					fixedBeefImage = true
				}
			}
			if !fixedBeefImage {
				image := mergeDraftImageCapability(result.Image, input.Image)
				normalizedImage, err := NormalizeModelCapabilityConfigForModel("image", protocol, modelName, &ModelCapabilityConfig{Version: 1, Image: image})
				if err != nil {
					return nil, err
				}
				result.Image = normalizedImage.Image
			}
		}
		if input.Video != nil {
			mergedVideo := mergeDraftVideoCapability(result.Video, input.Video)
			repaired := ApplyLocalVideoContract(localItem, &ModelCapabilityConfig{Version: 1, Video: mergedVideo})
			if isSeedance2Family(protocol, modelName) && repaired.Video != nil && strings.EqualFold(repaired.Video.Duration.Selection, "enum") && len(repaired.Video.Duration.Values) == 0 && repaired.Video.Duration.Values != nil {
				result.Video = applyModelSpecificVideoCapability(repaired.Video, protocol, modelName)
			} else {
				normalizedVideo, err := NormalizeModelCapabilityConfigForModel("video", protocol, modelName, repaired)
				if err != nil {
					return nil, err
				}
				result.Video = normalizedVideo.Video
			}
		} else {
			result = ApplyLocalVideoContract(localItem, result)
		}
	} else {
		result = ApplyLocalVideoContract(localItem, result)
	}

	if result.Video != nil {
		taskCfg := TaskConfig{
			ChannelID:        channelID,
			BaseURL:          baseURL,
			InterfaceType:    protocol,
			Model:            modelName,
			CapabilityConfig: result,
		}
		result.Video = tightenedVideoCapability(taskCfg, result.Video)
		applySeedanceDocumentedVideoPixelFloor(taskCfg, &result.Video.References)
	}
	return result, nil
}

func defaultCapabilityForProtocol(protocol string) string {
	normalized := strings.ToLower(strings.TrimSpace(protocol))
	switch {
	case strings.HasSuffix(normalized, "-image") || normalized == "openai-image" || normalized == "gemini-image" || normalized == "grok-image":
		return "image"
	case strings.HasSuffix(normalized, "-audio") || normalized == "openai-audio" || normalized == "minimax-speech":
		return "audio"
	case strings.HasSuffix(normalized, "-video") || strings.Contains(normalized, "video") || normalized == "newapi" || normalized == "newapi-channel-1" || normalized == "newapi-channel-2" || normalized == "gemini-veo" || normalized == "luma-dream-machine" || normalized == "zhipu-cogvideox" || normalized == "autodl-comfyui":
		return "video"
	default:
		return "text"
	}
}

func appendUniqueString(values []string, value string) []string {
	for _, item := range values {
		if item == value {
			return values
		}
	}
	return append(values, value)
}

// CapabilitySpecFromModelCapabilityConfig 将渠道模型的真实供应能力投影为路由能力规格。
// 渠道模型能力参数是唯一事实来源，前台模型供应线路直接引用该规格。
func CapabilitySpecFromModelCapabilityConfig(config *ModelCapabilityConfig, capability string) (CapabilitySpec, error) {
	spec := CapabilitySpec{Version: 1, Capability: capability, Inputs: map[string]InputConstraint{}, Options: map[string]OptionConstraint{}}
	// 音频模型当前没有可编辑的渠道能力 JSON，使用空能力规格表示“无额外路由约束”。
	if capability == "audio" {
		return spec, nil
	}
	if config == nil {
		switch capability {
		case "text":
			return spec, kernel.BadAuthRequest("渠道文本模型尚未配置能力参数")
		case "image":
			return spec, kernel.BadAuthRequest("渠道图片模型尚未配置能力参数")
		case "video":
			return spec, kernel.BadAuthRequest("渠道视频模型尚未配置能力参数")
		default:
			return spec, kernel.BadAuthRequest("渠道模型尚未配置能力参数")
		}
	}
	switch capability {
	case "text":
		if config.Text == nil {
			return spec, kernel.BadAuthRequest("渠道文本模型尚未配置能力参数")
		}
		addInputConstraint(spec.Inputs, "image", 0, config.Text.References.MaxImages)
		addInputConstraint(spec.Inputs, "video", 0, config.Text.References.MaxVideos)
	case "image":
		if config.Image == nil {
			return spec, kernel.BadAuthRequest("渠道图片模型尚未配置能力参数")
		}
		image := config.Image
		addInputConstraint(spec.Inputs, "image", 0, image.References.MaxImages)
		if image.References.MaskSupported {
			addInputConstraint(spec.Inputs, "mask", 0, 1)
		}
		if image.Size.Parameter != "none" {
			spec.Options["size"] = imageSizeOptionConstraint(image.Size)
			spec.ImageSize = capabilityImageSizeFromConfig(image.Size)
		}
		if image.Quality.Supported {
			spec.Options["quality"] = anyValues(image.Quality.Values)
		}
		if image.TransparentBackground.Supported {
			spec.Options["transparentBackground"] = boolValues(true)
		} else {
			spec.Options["transparentBackground"] = boolValues(false)
		}
		spec.Options["count"] = numericRange(1, float64(image.MaxOutputs), 1)
		if image.FixedOutputs > 0 {
			spec.Options["count"] = numericRange(float64(image.FixedOutputs), float64(image.FixedOutputs), float64(image.FixedOutputs))
		}
	case "video":
		if config.Video == nil {
			return spec, kernel.BadAuthRequest("渠道视频模型尚未配置能力参数")
		}
		video := config.Video
		spec.Operations = append([]string(nil), video.Operations...)
		addInputConstraint(spec.Inputs, "image", video.References.MinImages, video.References.MaxImages)
		addInputConstraint(spec.Inputs, "video", 0, video.References.MaxVideos)
		addInputConstraint(spec.Inputs, "audio", 0, video.References.MaxAudios)
		if video.Duration.Selection == "enum" {
			values := make([]any, 0, len(video.Duration.Values))
			for _, value := range video.Duration.Values {
				values = append(values, value)
			}
			spec.Options["videoSeconds"] = OptionConstraint{Values: values}
		} else {
			spec.Options["videoSeconds"] = numericRange(durationMinimum(video.Duration), float64(video.Duration.Max), float64(video.Duration.Step))
			if video.Duration.Continuous {
				option := spec.Options["videoSeconds"]
				option.Step = nil
				spec.Options["videoSeconds"] = option
			}
		}
		spec.Options["size"] = anyValues(video.Ratios)
		if len(video.Resolutions) > 0 {
			spec.Options["vquality"] = anyValues(video.Resolutions)
		}
		if video.GenerateAudio.Supported {
			spec.Options["videoGenerateAudio"] = boolValues(true)
		} else {
			spec.Options["videoGenerateAudio"] = boolValues(false)
		}
		if video.Watermark.Supported {
			spec.Options["videoWatermark"] = boolValues(true)
		} else {
			spec.Options["videoWatermark"] = boolValues(false)
		}
	default:
		return spec, kernel.BadAuthRequest("未知模型能力类型")
	}
	return spec, nil
}

func addInputConstraint(inputs map[string]InputConstraint, name string, min int, max int) {
	if min <= 0 && max <= 0 {
		return
	}
	inputs[name] = InputConstraint{Min: min, Max: max}
}

func validateTextCapabilityConfig(value *TextCapabilityConfig) error {
	if value.References.PromptMaxChars < 1 || value.References.PromptMaxChars > 1000000 {
		return kernel.BadAuthRequest("提示词最大字符数必须在 1-1000000 之间")
	}
	for name, number := range map[string]int{"最大图片引用数": value.References.MaxImages, "最大视频引用数": value.References.MaxVideos} {
		if number < 0 || number > 100 {
			return kernel.BadAuthRequest(name + "必须在 0-100 之间")
		}
	}
	if value.References.MaxImageBytes < 0 || value.References.MaxVideoBytes < 0 {
		return kernel.BadAuthRequest("引用素材大小限制不能小于 0")
	}
	return nil
}

func containsCapabilityString(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), strings.TrimSpace(target)) {
			return true
		}
	}
	return false
}

func containsInt(values []int, target int) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func absFloat(value float64) float64 {
	if value < 0 {
		return -value
	}
	return value
}

func composedPrompt(systemPrompt, prompt string) string {
	systemPrompt = strings.TrimSpace(systemPrompt)
	if systemPrompt == "" {
		return prompt
	}
	return systemPrompt + "\n\n" + prompt
}

func metadataString(metadata map[string]any, key string) string {
	if metadata == nil {
		return ""
	}
	value, ok := metadata[key]
	if !ok || value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return ""
}

func NormalizedChannelModelCapability(channelModel *model.ChannelModel) (*ModelCapabilityConfig, error) {
	return normalizedChannelModelCapability(channelModel)
}

func ValidateTextCapabilityConfig(value *TextCapabilityConfig) error {
	return validateTextCapabilityConfig(value)
}

func ContainsCapabilityString(values []string, target string) bool {
	return containsCapabilityString(values, target)
}
