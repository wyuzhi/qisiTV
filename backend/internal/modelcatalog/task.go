package modelcatalog

import (
	"strings"

	"qisitv/backend/internal/kernel"
)

// ValidateConfiguredTask applies stored channel capability to a task. Workflow
// providers are handled by the caller. lookup may be nil when no channel is
// selected; direct/BYOK tasks delegate capability validation to the upstream server.
func ValidateConfiguredTask(input TaskInput, lookup ChannelModelLookup) (TaskInput, error) {
	if input.Mode != "image" && input.Mode != "video" && input.Mode != "audio" {
		return input, nil
	}
	if input.Mode == "audio" {
		return input, nil
	}
	channelID := strings.TrimSpace(input.Config.ChannelID)
	if channelID == "" {
		channelID = SystemChannelIDFromBaseURL(input.Config.BaseURL)
	}
	if channelID == "" {
		if input.Mode == "video" && input.Config.CapabilityConfig != nil && input.Config.CapabilityConfig.Video != nil {
			if normalized, err := NormalizeModelCapabilityConfigForModel("video", input.Config.InterfaceType, input.Config.Model, input.Config.CapabilityConfig); err == nil && normalized != nil && normalized.Video != nil {
				applyFixedVideoResolution(&input, normalized.Video)
			} else {
				applyFixedVideoResolution(&input, input.Config.CapabilityConfig.Video)
			}
		}
		return input, nil
	}
	if lookup == nil {
		return input, kernel.BadAuthRequest("当前系统渠道模型未配置或已停用")
	}
	item, err := lookup(channelID, ProviderChannelModelKey(input.Config.ChannelModelKey, input.Config.Model))
	if err != nil {
		return input, kernel.BadAuthRequest("当前系统渠道模型未配置或已停用")
	}
	profile, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
	if input.Mode == "image" {
		if err != nil {
			return input, kernel.BadAuthRequest("当前图片模型能力参数无效")
		}
		imageProfile := DefaultImageCapabilityConfig(string(item.Protocol), kernel.FirstNonEmpty(item.ProviderModelKey, item.ModelKey))
		if profile != nil && profile.Image != nil {
			imageProfile = profile.Image
		}
		return input, validateImageTask(applyModelSpecificImageCapability(imageProfile, string(item.Protocol), kernel.FirstNonEmpty(item.ProviderModelKey, item.ModelKey), input.Config.APIFormat), input)
	}
	if err != nil || profile == nil || profile.Video == nil {
		return input, kernel.BadAuthRequest("当前视频模型尚未配置能力参数")
	}
	normalized, normalizeErr := NormalizeModelCapabilityConfigForModel("video", string(item.Protocol), kernel.FirstNonEmpty(item.ProviderModelKey, item.ModelKey), profile)
	if normalizeErr != nil || normalized == nil || normalized.Video == nil {
		return input, kernel.BadAuthRequest("当前视频模型能力参数无效")
	}
	applyFixedVideoResolution(&input, normalized.Video)
	return input, validateVideoTask(normalized.Video, input)
}
