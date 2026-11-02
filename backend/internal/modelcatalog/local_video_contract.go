package modelcatalog

import (
	"slices"
	"strings"

	"qisitv/backend/internal/providerpreset"
)

// ApplyLocalVideoContract matches the desktop configuration's BeefAPI overlay.
// A versioned gateway profile owns its limits. Otherwise, verified route limits
// repair legacy generic profiles without changing the saved audio default.
func ApplyLocalVideoContract(item LocalChannelModel, config *ModelCapabilityConfig) *ModelCapabilityConfig {
	isBeefRoute := providerpreset.IsBeefAPIEndpoint(item.BaseURL) || (strings.TrimSpace(item.BaseURL) == "" && strings.EqualFold(strings.TrimSpace(item.ChannelID), "beefapi"))
	if item.Capability != "video" || item.VideoCapabilitiesVersion != nil || !isBeefRoute || config == nil || config.Video == nil {
		return config
	}
	if isSeedance2Family(item.Protocol, item.Model) {
		config = repairLegacyEnterpriseSeedanceVideoProfile(item.Protocol, item.Model, config)
	}
	contract, ok := providerpreset.BeefAPIVideoContract(item.Model)
	if !ok {
		return config
	}
	result := *config
	video := *config.Video
	result.Video = &video
	if len(contract.Resolutions) > 0 {
		video.Resolutions = slices.Clone(contract.Resolutions)
		if !slices.Contains(video.Resolutions, video.DefaultResolution) {
			video.DefaultResolution = video.Resolutions[0]
		}
	}
	if len(contract.Ratios) > 0 {
		video.Ratios = slices.Clone(contract.Ratios)
		if !slices.Contains(video.Ratios, video.DefaultRatio) {
			video.DefaultRatio = video.Ratios[0]
		}
	}
	if contract.Duration != nil {
		video.Duration.Selection = "range"
		video.Duration.Min, video.Duration.Max, video.Duration.Default = contract.Duration.Min, contract.Duration.Max, contract.Duration.Default
	}
	if contract.GenerateAudio {
		video.GenerateAudio.Supported = true
	}
	for kind, limit := range contract.MaxReferences {
		switch kind {
		case "image":
			video.References.MaxImages = min(video.References.MaxImages, limit)
		case "video":
			video.References.MaxVideos = min(video.References.MaxVideos, limit)
		case "audio":
			video.References.MaxAudios = min(video.References.MaxAudios, limit)
		}
	}
	if len(contract.Operations) > 0 {
		video.Operations = slices.Clone(contract.Operations)
		if !slices.Contains(video.Operations, video.DefaultOperation) {
			video.DefaultOperation = video.Operations[0]
		}
	}
	if isSeedance2Family(item.Protocol, item.Model) {
		repairSeedanceBooleanFlagsAndDraftResolution(item.Protocol, item.Model, &video)
	}
	return &result
}

func repairSeedanceBooleanFlagsAndDraftResolution(protocol, modelName string, video *VideoCapabilityConfig) {
	defaults := DefaultModelCapabilityConfigForModel(protocol, modelName)
	if defaults == nil || defaults.Video == nil || video == nil {
		return
	}
	if defaults.Video.Draft.Supported && !video.Draft.Supported {
		video.Draft = defaults.Video.Draft
	}
	if video.Draft.Supported {
		if slices.Contains(defaults.Video.Resolutions, "480p") {
			video.Resolutions = appendUniqueString(video.Resolutions, "480p")
		}
		if slices.Contains(defaults.Video.Operations, "draft_to_final") {
			video.Operations = appendUniqueString(video.Operations, "draft_to_final")
		}
	}
	if defaults.Video.ReturnLastFrame.Supported && !video.ReturnLastFrame.Supported {
		video.ReturnLastFrame = defaults.Video.ReturnLastFrame
	}
}

func repairLegacyEnterpriseSeedanceVideoProfile(protocol, modelName string, config *ModelCapabilityConfig) *ModelCapabilityConfig {
	if config == nil || config.Video == nil {
		return config
	}
	refs := config.Video.References
	if refs.MaxVideos != 0 || refs.MaxAudios != 0 || refs.MaxVideoDuration != 0 || refs.MaxAudioDuration != 0 {
		result := *config
		video := *config.Video
		repairSeedanceBooleanFlagsAndDraftResolution(protocol, modelName, &video)
		result.Video = &video
		return &result
	}
	defaults := DefaultModelCapabilityConfigForModel(protocol, modelName)
	if defaults == nil || defaults.Video == nil {
		return config
	}
	result := *config
	video := *config.Video
	video.References.MaxImages = max(refs.MaxImages, defaults.Video.References.MaxImages)
	video.References.MaxVideos = defaults.Video.References.MaxVideos
	video.References.MaxAudios = defaults.Video.References.MaxAudios
	video.References.MinVideoDuration = defaults.Video.References.MinVideoDuration
	video.References.MaxVideoDuration = defaults.Video.References.MaxVideoDuration
	video.References.MinAudioDuration = defaults.Video.References.MinAudioDuration
	video.References.MaxAudioDuration = defaults.Video.References.MaxAudioDuration
	video.References.MaxVideoTotalDuration = defaults.Video.References.MaxVideoTotalDuration
	video.References.MaxAudioTotalDuration = defaults.Video.References.MaxAudioTotalDuration
	video.GenerateAudio = defaults.Video.GenerateAudio
	repairSeedanceBooleanFlagsAndDraftResolution(protocol, modelName, &video)
	for _, op := range defaults.Video.Operations {
		video.Operations = appendUniqueString(video.Operations, op)
	}
	video.TaskTypeConstraints = defaults.Video.TaskTypeConstraints
	result.Video = &video
	return &result
}
