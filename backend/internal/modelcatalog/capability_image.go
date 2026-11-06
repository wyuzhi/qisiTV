package modelcatalog

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/providerpreset"
)

func isMossImageModel(modelName string) bool {
	name := strings.ToLower(strings.TrimSpace(modelName))
	if idx := strings.LastIndex(name, "/"); idx >= 0 {
		name = name[idx+1:]
	}
	return strings.HasPrefix(name, "moss-image")
}

func DefaultImageCapabilityConfig(protocol string, modelName string) *ImageCapabilityConfig {
	if isMossImageModel(modelName) {
		return &ImageCapabilityConfig{
			References:            ImageReferenceConfig{PromptMaxChars: 4000, MaxImages: 0, MaxImageBytes: 0, MaskSupported: false},
			Size:                  ImageSizeConfig{Parameter: "size", Values: []string{"1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "1024x1024", "1024x768", "768x1024", "1360x1024", "1024x1360", "1280x720", "720x1280", "1536x1024", "1024x1536", "1824x1024", "1024x1824", "2048x2048"}, Default: "1:1", AllowCustom: true},
			Quality:               ImageQualityConfig{Supported: false, Values: []string{}, Default: "auto"},
			TransparentBackground: VideoBooleanConfig{Supported: false, Default: false},
			SequentialGeneration:  VideoBooleanConfig{Supported: false, Default: false},
			ResponseFormat:        ImageResponseFormat{Supported: true, Value: ImageResponseFormatURL},
			OutputFormat:          ParameterSupport{Supported: false},
			MaxOutputs:            1,
		}
	}
	if family := providerpreset.SeedreamFamily(modelName); family != "" {
		modern := family == "pro" || family == "flash"
		sizes := []string{"2K", "4K"}
		refs := 14
		if modern {
			sizes = []string{"1K", "1.5K", "2K"}
			refs = 10
		} else if family == "lite" {
			sizes = []string{"2K", "3K", "4K"}
		} else if family == "4.0" {
			sizes = []string{"1K", "2K", "4K"}
		}
		return &ImageCapabilityConfig{References: ImageReferenceConfig{PromptMaxChars: 32000, MaxImages: refs, MaxImageBytes: 30 * 1024 * 1024}, Size: ImageSizeConfig{Parameter: "size", Values: sizes, Default: "2K", AllowCustom: true}, Quality: ImageQualityConfig{Default: "auto"}, TransparentBackground: VideoBooleanConfig{Supported: modern}, SequentialGeneration: VideoBooleanConfig{Supported: !modern}, ResponseFormat: ImageResponseFormat{Supported: true}, OutputFormat: ParameterSupport{Supported: modern || family == "lite"}, MaxOutputs: 15}
	}
	if contract, ok := providerpreset.BeefAPIImageContract(modelName); ok && protocol == "openai-image" {
		values := make([]string, 0, len(contract.Sizes))
		for ratio := range contract.Sizes {
			values = append(values, ratio)
			if contract.FixedOutputs > 0 {
				values = append(values, contract.Sizes[ratio])
			}
		}
		sort.Strings(values)
		presets := make([]ImageSizePreset, 0, len(contract.Presets))
		for _, preset := range contract.Presets {
			values = appendUniqueString(values, preset.Ratio)
			values = appendUniqueString(values, preset.Size)
			presets = append(presets, ImageSizePreset{Tier: preset.Tier, Ratio: preset.Ratio, Size: preset.Size, Width: preset.Width, Height: preset.Height})
		}
		return &ImageCapabilityConfig{
			References: ImageReferenceConfig{PromptMaxChars: contract.PromptMaxChars, MaxImages: contract.MaxImages, MaxImageBytes: contract.MaxImageBytes},
			Size:       ImageSizeConfig{Parameter: "size", Values: values, Default: "1:1", AllowCustom: contract.MinSide != contract.MaxSide, Presets: presets},
			Quality:    ImageQualityConfig{Default: "auto"}, MaxOutputs: max(1, contract.FixedOutputs), FixedOutputs: contract.FixedOutputs, GenerationOutputs: contract.GenerationOutputs,
			ResponseFormat: ImageResponseFormat{Supported: contract.FixedOutputs > 0},
		}
	}
	image := &ImageCapabilityConfig{
		References:            ImageReferenceConfig{PromptMaxChars: 32000, MaxImages: 16, MaxImageBytes: 30 * 1024 * 1024, MaskSupported: true},
		Size:                  ImageSizeConfig{Parameter: "size", Values: defaultImageSizeValues(), Default: "1:1", AllowCustom: true},
		Quality:               ImageQualityConfig{Supported: true, Values: []string{"auto", "low", "medium", "high"}, Default: "auto"},
		TransparentBackground: VideoBooleanConfig{Supported: true, Default: false},
		ResponseFormat:        ImageResponseFormat{Supported: true},
		OutputFormat:          ParameterSupport{Supported: true},
		MaxOutputs:            15,
	}
	if isExtendedGPTImageModel(protocol, modelName) {
		image.Quality.Values = []string{"auto", "low", "medium", "high", "xhigh", "max"}
	}
	if protocol == "openai-image" && strings.EqualFold(strings.TrimSpace(modelName), "gpt-image-2") {
		image.Quality = ImageQualityConfig{Supported: true, Values: []string{"low", "medium", "high"}, Default: "low"}
	}
	switch model.ChannelInterfaceType(protocol) {
	case model.ChannelInterfaceGrokImage:
		image.References.MaxImages = 1
		image.References.MaskSupported = false
		// grok2api / xAI Imagine：size→aspect_ratio，quality→resolution(1k/2k)。
		image.Size = ImageSizeConfig{Parameter: "aspect_ratio", Values: []string{"1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2"}, Default: "1:1", AllowCustom: false}
		image.Quality = ImageQualityConfig{Supported: true, Values: []string{"1k", "2k"}, Default: "2k"}
		image.TransparentBackground = VideoBooleanConfig{Supported: false, Default: false}
		image.ResponseFormat = ImageResponseFormat{Supported: true}
		image.OutputFormat = ParameterSupport{Supported: false}
		image.MaxOutputs = 1
	case model.ChannelInterfaceVolcengineArkImage, model.ChannelInterfaceVolcengineArkAgentPlanImage:
		image.References.MaskSupported = false
		image.Quality.Supported = false
		image.TransparentBackground.Supported = false
		image.ResponseFormat.Supported = false
		image.OutputFormat.Supported = false
	case model.ChannelInterfaceVolcengineJiMengImage:
		image.References.MaxImages = 14
		image.References.MaskSupported = false
		image.Quality.Supported = false
		image.TransparentBackground.Supported = false
		image.ResponseFormat.Supported = false
		image.OutputFormat.Supported = false
	case model.ChannelInterfaceGeminiImage:
		image.References.MaskSupported = false
		// Gemini Images uses imageConfig.aspectRatio, not the OpenAI-style pixel size field.
		image.Size = ImageSizeConfig{Parameter: "aspect_ratio", Values: []string{"auto", "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"}, Default: "1:1", AllowCustom: false}
		image.TransparentBackground.Supported = false
		image.ResponseFormat.Supported = false
		image.OutputFormat.Supported = false
		image.MaxOutputs = 4
	case "agnes-image":
		agnesImage25Pro := strings.EqualFold(strings.TrimSpace(modelName), "agnes-image-2.5-pro")
		values := []string{"auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"}
		maxImages := 14
		if agnesImage25Pro {
			values = []string{"auto", "1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9", "9:21", "4:5", "5:4", "1:4", "4:1", "1:8", "8:1"}
			maxImages = 9
		}
		image.References.MaxImages = maxImages
		image.References.MaskSupported = false
		image.Size = ImageSizeConfig{Parameter: "aspect_ratio", Values: values, Default: "auto", AllowCustom: false}
		image.Quality = ImageQualityConfig{Supported: false, Values: []string{"auto"}, Default: "auto"}
		image.TransparentBackground = VideoBooleanConfig{Supported: false, Default: false}
		image.ResponseFormat = ImageResponseFormat{Supported: false}
		image.OutputFormat = ParameterSupport{Supported: false}
		image.MaxOutputs = 4
	}
	if model.ChannelInterfaceType(protocol) != model.ChannelInterfaceGrokImage && strings.HasPrefix(strings.ToLower(strings.TrimSpace(modelName)), "grok-imagine-image") {
		image.References.MaxImages = 0
		image.References.MaskSupported = false
		image.Size = ImageSizeConfig{Parameter: "aspect_ratio", Values: []string{"1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2"}, Default: "1:1", AllowCustom: false}
		image.Quality = ImageQualityConfig{Supported: true, Values: []string{"1k", "2k"}, Default: "2k"}
		image.TransparentBackground = VideoBooleanConfig{Supported: false, Default: false}
		image.ResponseFormat = ImageResponseFormat{Supported: true}
		image.OutputFormat = ParameterSupport{Supported: false}
		image.MaxOutputs = 1
	}
	return image
}

func defaultImageSizeValues() []string {
	return []string{
		"auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "21:9", "9:16",
		"1024x1024", "1360x1024", "1024x1360", "1536x1024", "1024x1536", "1024x1280", "1280x1024", "2048x880", "1824x1024", "1024x1824",
		"2048x2048", "2304x1728", "1728x2304", "2496x1664", "1664x2496", "1792x2240", "2240x1792", "3136x1344", "2752x1536", "1536x2752",
		"2880x2880", "3264x2448", "2448x3264", "3504x2336", "2336x3504", "2560x3200", "3200x2560", "3808x1632", "3840x2160", "2160x3840",
	}
}

// legacyImageSizeValues 用于修复旧数据中仅保存了 "*" 的图片尺寸能力。
// 这组值是前后台共同展示的基础预设，不能让历史通配符配置继续污染用户生成参数。
func legacyImageSizeValues() []string {
	return []string{
		"1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "21:9", "9:16",
		"1024x1024", "1536x1024", "1024x1536",
	}
}

func mergeDraftImageCapability(fallback, raw *ImageCapabilityConfig) *ImageCapabilityConfig {
	if raw == nil {
		return fallback
	}
	result := *raw
	if fallback != nil {
		if result.References.PromptMaxChars <= 0 {
			result.References.PromptMaxChars = fallback.References.PromptMaxChars
		}
		if result.MaxOutputs <= 0 {
			result.MaxOutputs = fallback.MaxOutputs
		}
		if result.Size.Parameter == "" {
			result.Size = fallback.Size
		} else if len(result.Size.Values) > 0 {
			allWildcard := true
			for _, item := range result.Size.Values {
				if item != "*" {
					allWildcard = false
					break
				}
			}
			if allWildcard {
				result.Size.Values = defaultImageSizeValues()
			}
		}
	}
	return &result
}

// imageSizeOptionConstraint 保留可见的标准尺寸/比例，同时用 * 表示允许自定义。
// * 不能替代标准值，否则管理端只能看到一个没有业务含义的通配符。
func imageSizeOptionConstraint(size ImageSizeConfig) OptionConstraint {
	values := make([]string, 0, len(size.Values)+1)
	seen := make(map[string]struct{}, len(size.Values)+1)
	for _, value := range size.Values {
		value = strings.TrimSpace(value)
		if value == "" || value == "*" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	if size.AllowCustom {
		if len(values) == 0 {
			for _, value := range legacyImageSizeValues() {
				seen[value] = struct{}{}
				values = append(values, value)
			}
		}
		values = append(values, "*")
	}
	return anyValues(values)
}

func capabilityImageSizeFromConfig(size ImageSizeConfig) *CapabilityImageSize {
	if size.Parameter == "" || size.Parameter == "none" {
		return nil
	}
	result := &CapabilityImageSize{Parameter: size.Parameter, AllowCustom: size.AllowCustom}
	for _, preset := range size.Presets {
		tier := strings.ToLower(strings.TrimSpace(preset.Tier))
		ratio := strings.TrimSpace(preset.Ratio)
		value := strings.TrimSpace(preset.Size)
		if tier == "" || ratio == "" || value == "" {
			continue
		}
		result.Presets = append(result.Presets, CapabilityImageSizePreset{
			Size: value, Tier: tier, Ratio: ratio, Width: preset.Width, Height: preset.Height,
		})
	}
	return result
}

func validateImageCapabilityConfig(value *ImageCapabilityConfig) error {
	if value.References.PromptMaxChars < 0 || value.References.PromptMaxChars > 1000000 {
		return kernel.BadAuthRequest("提示词最大字符数必须在 0-1000000 之间，0 表示交由服务商校验")
	}
	if value.References.MaxImages < 0 || value.References.MaxImages > 100 || value.References.MaxImageBytes < 0 {
		return kernel.BadAuthRequest("图片引用限制无效")
	}
	if value.MaxOutputs < 1 || value.MaxOutputs > 100 {
		return kernel.BadAuthRequest("单次图片数量必须在 1-100 之间")
	}
	if value.FixedOutputs < 0 || value.FixedOutputs > value.MaxOutputs {
		return kernel.BadAuthRequest("固定图片数量必须在单次图片数量范围内")
	}
	// response_format 只支持两个取值；留空交给请求侧按 b64_json 处理。
	if format := strings.ToLower(strings.TrimSpace(value.ResponseFormat.Value)); format != "" {
		if format != ImageResponseFormatBase64 && format != ImageResponseFormatURL {
			return kernel.BadAuthRequest("图片响应格式仅支持 b64_json 或 url")
		}
		value.ResponseFormat.Value = format
	}
	switch value.Size.Parameter {
	case "none":
		value.Size.Values = []string{}
		value.Size.Presets = nil
		value.Size.Default = "auto"
		value.Size.AllowCustom = false
	case "size", "aspect_ratio":
		if strings.TrimSpace(value.Size.Default) == "" {
			return kernel.BadAuthRequest("请配置默认图片尺寸或比例")
		}
		if !value.Size.AllowCustom && !containsCapabilityString(value.Size.Values, value.Size.Default) {
			return kernel.BadAuthRequest("默认图片尺寸必须属于支持值")
		}
	default:
		return kernel.BadAuthRequest("尺寸参数仅支持不发送、size 或 aspect_ratio")
	}
	seenPresets := make(map[string]bool)
	for _, preset := range value.Size.Presets {
		if preset.Tier != "1k" && preset.Tier != "2k" && preset.Tier != "4k" {
			return kernel.BadAuthRequest("图片分辨率档位仅支持 1K、2K、4K")
		}
		parts := strings.Split(preset.Ratio, ":")
		if len(parts) != 2 {
			return kernel.BadAuthRequest("图片预设比例格式无效")
		}
		w, ew := strconv.Atoi(parts[0])
		h, eh := strconv.Atoi(parts[1])
		if ew != nil || eh != nil || w <= 0 || h <= 0 || w > 100000 || h > 100000 || max(w, h) > min(w, h)*3 {
			return kernel.BadAuthRequest("图片预设比例无效")
		}
		if preset.Width <= 0 || preset.Height <= 0 || max(preset.Width, preset.Height) > 3840 || max(preset.Width, preset.Height) > min(preset.Width, preset.Height)*3 || preset.Width*preset.Height < 655360 || preset.Width*preset.Height > 8294400 || preset.Size != fmt.Sprintf("%dx%d", preset.Width, preset.Height) {
			return kernel.BadAuthRequest("图片预设像素尺寸无效")
		}
		// 容许像素取整误差，但不能将横屏尺寸标记成竖屏或其他比例。
		difference := preset.Width*h - preset.Height*w
		if difference < 0 {
			difference = -difference
		}
		if difference*1000 > preset.Height*w*25 {
			return kernel.BadAuthRequest("图片预设像素尺寸与宽高比不一致")
		}
		a, b := w, h
		for b != 0 {
			a, b = b, a%b
		}
		key := fmt.Sprintf("%s:%d:%d", preset.Tier, w/a, h/a)
		if seenPresets[key] {
			return kernel.BadAuthRequest("图片尺寸预设重复")
		}
		seenPresets[key] = true
		requestValue := preset.Size
		if value.Size.Parameter == "aspect_ratio" {
			requestValue = preset.Ratio
		}
		if !containsCapabilityString(value.Size.Values, requestValue) {
			return kernel.BadAuthRequest("图片预设必须包含在尺寸支持值中")
		}
	}
	if value.Quality.Supported {
		if len(value.Quality.Values) == 0 || strings.TrimSpace(value.Quality.Default) == "" || !containsCapabilityString(value.Quality.Values, value.Quality.Default) {
			return kernel.BadAuthRequest("请配置图片质量支持值和默认值")
		}
	} else {
		value.Quality.Values = []string{}
		value.Quality.Default = "auto"
	}
	if err := validateImagePresetSelection(value, value.Quality.Default, value.Size.Default); err != nil {
		return kernel.BadAuthRequest("默认图片分辨率与宽高比不在已配置的组合中")
	}
	if !value.TransparentBackground.Supported {
		value.TransparentBackground.Default = false
	}
	return nil
}

func isExtendedGPTImageModel(protocol, modelName string) bool {
	name := strings.ToLower(strings.TrimSpace(modelName))
	if protocol != "openai-image" || !strings.HasPrefix(name, "gpt-image-") {
		return false
	}
	suffix := strings.TrimPrefix(name, "gpt-image-")
	return suffix == "2.5" || suffix == "2.5-flare" || suffix == "2.5-sunburst" || suffix == "2.6" || suffix == "2.6-flare" || suffix == "2.6-sunburst"
}

// Upgrade only the old built-in GPT image choices; keep other stored limits.
func applyModelSpecificImageCapability(profile *ImageCapabilityConfig, protocol string, modelName string, _ string) *ImageCapabilityConfig {
	if providerpreset.SeedreamFamily(modelName) != "" || isMossImageModel(modelName) {
		return DefaultImageCapabilityConfig(protocol, modelName)
	}
	name := strings.ToLower(strings.TrimSpace(modelName))
	if profile == nil || protocol != "openai-image" || (name != "gpt-image-2" && !isExtendedGPTImageModel(protocol, name)) {
		return profile
	}
	result := *profile
	if profile.Quality.Supported && profile.Quality.Default == "auto" && len(profile.Quality.Values) == 4 && containsCapabilityString(profile.Quality.Values, "auto") && containsCapabilityString(profile.Quality.Values, "low") && containsCapabilityString(profile.Quality.Values, "medium") && containsCapabilityString(profile.Quality.Values, "high") {
		result.Quality = DefaultImageCapabilityConfig(protocol, name).Quality
	}
	result.Size.Values = append([]string(nil), profile.Size.Values...)
	for i, size := range result.Size.Values {
		if size == "2048x878" {
			result.Size.Values[i] = "2048x880"
		}
	}
	if result.Size.Default == "2048x878" {
		result.Size.Default = "2048x880"
	}
	result.Size.Presets = append([]ImageSizePreset(nil), profile.Size.Presets...)
	for i, preset := range result.Size.Presets {
		if preset.Size == "2048x878" {
			result.Size.Presets[i].Size = "2048x880"
			result.Size.Presets[i].Height = 880
		}
	}
	return &result
}

func validateImageTask(profile *ImageCapabilityConfig, input TaskInput) error {
	sourced := input.Config.ImageCapabilitiesVersion != nil && *input.Config.ImageCapabilitiesVersion != ""
	if !sourced {
		profile = applyModelSpecificImageCapability(profile, input.Config.InterfaceType, input.Config.Model, input.Config.APIFormat)
	}
	if !sourced && providerpreset.IsBeefAPIEndpoint(input.Config.BaseURL) {
		if contract, ok := providerpreset.BeefAPIImageContract(input.Config.Model); ok {
			profile = DefaultImageCapabilityConfig(contract.Protocol, input.Config.Model)
			if _, err := contract.PixelSize(input.Config.Size); err != nil {
				return kernel.BadAuthRequest(err.Error())
			}
			if _, err := contract.GenerationPrompt(composedPrompt(input.Config.SystemPrompt, input.Prompt), input.Config.Size); err != nil {
				return kernel.BadAuthRequest(err.Error())
			}
			if q := strings.ToLower(strings.TrimSpace(input.Config.Quality)); q != "" && q != "auto" && q != "any" {
				return kernel.BadAuthRequest("当前图片模型不支持质量选项，请选择自动")
			}
		}
	}
	if profile == nil {
		return nil
	}
	if family := providerpreset.SeedreamFamily(input.Config.Model); family != "" {
		layers := strings.EqualFold(metadataString(input.Metadata, "seedreamMode"), "layers")
		if _, err := providerpreset.ResolveSeedreamSize(family, input.Config.Size, layers); err != nil {
			return kernel.BadAuthRequest(err.Error())
		}
	}
	modelName := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(input.Config.Model)), "models/")
	if len(input.ReferenceImages) > profile.References.MaxImages {
		return kernel.BadAuthRequest(fmt.Sprintf("当前图片模型最多支持 %d 张参考图", profile.References.MaxImages))
	}
	for _, media := range input.ReferenceImages {
		if profile.References.MaxImageBytes > 0 && media.Bytes > profile.References.MaxImageBytes {
			return kernel.BadAuthRequest("参考图片文件超过当前模型大小限制")
		}
	}
	if input.Mask != nil && !profile.References.MaskSupported {
		return kernel.BadAuthRequest("当前图片模型不支持蒙版编辑")
	}
	if profile.Size.Parameter != "none" && !profile.Size.AllowCustom && strings.TrimSpace(input.Config.Size) != "" && !containsCapabilityString(profile.Size.Values, input.Config.Size) {
		return kernel.BadAuthRequest("图片尺寸不在当前模型支持范围内")
	}
	if !sourced && profile.Size.Parameter == "size" && profile.Size.AllowCustom && strings.HasPrefix(modelName, "gpt-image-2") && !containsCapabilityString(profile.Size.Values, input.Config.Size) {
		if err := validateGPTImage2CustomSize(input.Config.Size); err != nil {
			return kernel.BadAuthRequest(err.Error())
		}
	}
	if !sourced && profile.Size.Parameter == "size" && profile.Size.AllowCustom && isMossImageModel(modelName) && !containsCapabilityString(profile.Size.Values, input.Config.Size) {
		if err := validateMossImageCustomSize(input.Config.Size); err != nil {
			return kernel.BadAuthRequest(err.Error())
		}
	}
	quality := strings.TrimSpace(input.Config.Quality)
	if profile.Quality.Supported && quality != "" && !strings.EqualFold(quality, "auto") && !strings.EqualFold(quality, "any") && !imageQualityValueAllowed(profile.Quality.Values, quality) {
		return kernel.BadAuthRequest("图片质量不在当前模型支持范围内")
	}
	if err := validateImagePresetSelection(profile, qualityForImageValidation(quality, profile.Quality.Default), kernel.FirstNonEmpty(input.Config.Size, profile.Size.Default)); err != nil {
		return err
	}
	count, err := strconv.Atoi(strings.TrimSpace(input.Config.Count))
	if profile.FixedOutputs > 0 && (err != nil || count != profile.FixedOutputs) {
		return kernel.BadAuthRequest(fmt.Sprintf("当前图片模型每次固定生成 %d 张", profile.FixedOutputs))
	}
	if err == nil && count > profile.MaxOutputs {
		return kernel.BadAuthRequest(fmt.Sprintf("当前图片模型单次最多生成 %d 张", profile.MaxOutputs))
	}
	return nil
}

func qualityForImageValidation(quality string, fallback string) string {
	if strings.EqualFold(quality, "auto") || strings.EqualFold(quality, "any") {
		return fallback
	}
	return kernel.FirstNonEmpty(quality, fallback)
}

func validateImagePresetSelection(profile *ImageCapabilityConfig, quality, ratio string) error {
	if profile.Size.Parameter != "aspect_ratio" || profile.Size.AllowCustom || len(profile.Size.Presets) == 0 || ratio == "auto" {
		return nil
	}
	tier := imageResolutionTier(quality)
	if tier == "" {
		return nil
	}
	for _, preset := range profile.Size.Presets {
		if preset.Tier == tier && preset.Ratio == ratio {
			return nil
		}
	}
	return kernel.BadAuthRequest("当前分辨率不支持所选图片宽高比")
}

func imageResolutionTier(quality string) string {
	switch strings.ToLower(strings.TrimSpace(quality)) {
	case "1k", "low":
		return "1k"
	case "2k", "medium":
		return "2k"
	case "4k", "high":
		return "4k"
	default:
		return ""
	}
}

func imageQualityValueAllowed(values []string, quality string) bool {
	if containsCapabilityString(values, quality) {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(quality)) {
	case "1k":
		return containsCapabilityString(values, "low")
	case "2k":
		return containsCapabilityString(values, "medium")
	case "4k":
		return containsCapabilityString(values, "high")
	default:
		return false
	}
}

func validateMossImageCustomSize(value string) error {
	value = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(value, "×", "x")))
	if value == "" || value == "auto" {
		return nil
	}
	parts := strings.Split(value, "x")
	if len(parts) != 2 {
		return errors.New("自定义图片尺寸请使用宽x高，例如 1024x1024")
	}
	width, widthErr := strconv.Atoi(parts[0])
	height, heightErr := strconv.Atoi(parts[1])
	if widthErr != nil || heightErr != nil || width < 256 || height < 256 || width > 2048 || height > 2048 {
		return errors.New("图片尺寸宽高需在 256 到 2048px 之间")
	}
	if width%8 != 0 || height%8 != 0 {
		return errors.New("图片尺寸宽高必须是 8 的倍数")
	}
	return nil
}

func validateGPTImage2CustomSize(value string) error {
	value = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(value, "×", "x")))
	if value == "" || value == "auto" {
		return nil
	}
	parts := strings.Split(value, "x")
	if len(parts) != 2 {
		return errors.New("自定义图片尺寸请使用宽x高，例如 3840x1920")
	}
	width, widthErr := strconv.Atoi(parts[0])
	height, heightErr := strconv.Atoi(parts[1])
	if widthErr != nil || heightErr != nil || width <= 0 || height <= 0 {
		return errors.New("图片尺寸必须是正整数")
	}
	if width%16 != 0 || height%16 != 0 {
		return errors.New("图片尺寸宽高必须是 16 的倍数")
	}
	if max(width, height) > 3840 {
		return errors.New("图片尺寸最长边不能超过 3840px")
	}
	if max(width, height) > min(width, height)*3 {
		return errors.New("图片宽高比不能超过 3:1")
	}
	pixels := int64(width) * int64(height)
	if pixels < 655360 || pixels > 8294400 {
		return errors.New("图片总像素需在 655360 到 8294400 之间")
	}
	return nil
}

func ValidateImageTask(profile *ImageCapabilityConfig, input TaskInput) error {
	return validateImageTask(profile, input)
}

func ApplyModelSpecificImageCapability(profile *ImageCapabilityConfig, protocol, modelName, apiFormat string) *ImageCapabilityConfig {
	return applyModelSpecificImageCapability(profile, protocol, modelName, apiFormat)
}

func ValidateImageCapabilityConfig(value *ImageCapabilityConfig) error {
	return validateImageCapabilityConfig(value)
}

func LegacyImageSizeValues() []string {
	return legacyImageSizeValues()
}
