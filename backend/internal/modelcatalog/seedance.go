package modelcatalog

import (
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

var opaqueVideoAssetPattern = regexp.MustCompile(`^asset://[A-Za-z0-9_-]+$`)
var dreaminaSeedancePattern = regexp.MustCompile(`^dreamina-seedance-2[.-](0|5)(-|$)`)

func isNativeDreaminaSeedance(protocol, modelName string) bool {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(modelName)), "/")
	return model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(protocol)) && dreaminaSeedancePattern.MatchString(parts[len(parts)-1])
}

func referenceDurationIsOpaqueAsset(media MediaRef) bool {
	return media.DurationMs == 0 && !strings.HasPrefix(media.StorageKey, "resource:") && opaqueVideoAssetPattern.MatchString(strings.TrimSpace(media.URL))
}

const (
	OfficialSeedanceImageMinEdge   = 300
	OfficialSeedanceImageMaxEdge   = 6000
	OfficialSeedanceImageMinAspect = 0.4
	OfficialSeedanceImageMaxAspect = 2.5
	OfficialSeedanceVideoMinPixels = 409600
	OfficialSeedanceVideoMaxPixels = 8295044
	// 火山方舟与腾讯 WAND 的 Seedance 文档都把参考音频单段下限写成 2 秒。
	OfficialSeedanceMinAudioSeconds = 2
)

const (
	// 火山方舟与腾讯 WAND 的输出时长下限都是 4 秒（2.0 为 4~15，2.5 为 4~30）。
	documentedSeedanceOutputMinSeconds = 4
)

const (
	officialSeedanceImageMinEdge    = OfficialSeedanceImageMinEdge
	officialSeedanceImageMaxEdge    = OfficialSeedanceImageMaxEdge
	officialSeedanceImageMinAspect  = OfficialSeedanceImageMinAspect
	officialSeedanceImageMaxAspect  = OfficialSeedanceImageMaxAspect
	officialSeedanceVideoMinPixels  = OfficialSeedanceVideoMinPixels
	officialSeedanceVideoMaxPixels  = OfficialSeedanceVideoMaxPixels
	officialSeedanceMinAudioSeconds = OfficialSeedanceMinAudioSeconds
)

func isSeedance2Family(protocol, modelName string) bool {
	normalizedProtocol := strings.TrimSpace(protocol)
	switch normalizedProtocol {
	case "newapi-channel-1", "newapi-channel-2", "newapi", "openai", "openai-videos", "video-generations-json", "seedance-videos-compatible", "full-video":
	default:
		if !model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(normalizedProtocol)) {
			return false
		}
	}
	name := strings.ToLower(strings.TrimSpace(modelName))
	return strings.Contains(name, "seedance-2")
}

func isSeedance25Model(modelName string) bool {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(modelName)), "/")
	base := parts[len(parts)-1]
	return base == "seedance-2.5" || strings.HasPrefix(base, "seedance-2.5-") || strings.HasPrefix(base, "doubao-seedance-2-5") || strings.HasPrefix(base, "doubao-seedance-2.5") || base == "dreamina-seedance-2-5" || strings.HasPrefix(base, "dreamina-seedance-2-5-") || base == "dreamina-seedance-2.5" || strings.HasPrefix(base, "dreamina-seedance-2.5-")
}

var seedance2FastOrMiniPattern = regexp.MustCompile(`^(?:(?:doubao|dreamina)-)?seedance-2[.-]0-(?:fast|mini)(?:-|$)`)

func isSeedance2FastOrMiniModel(modelName string) bool {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(modelName)), "/")
	base := parts[len(parts)-1]
	return seedance2FastOrMiniPattern.MatchString(base)
}

const documentedSeedanceVideoMinPixels = 407696

func applySeedanceDocumentedVideoPixelFloor(config TaskConfig, refs *VideoReferenceConfig) {
	if hasServerVideoCapability(config) {
		return
	}
	if refs == nil || refs.MinVideoPixels != officialSeedanceVideoMinPixels || refs.MaxVideoPixels != officialSeedanceVideoMaxPixels {
		return
	}
	if !isSeedance2Family(config.InterfaceType, config.Model) {
		return
	}
	if model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(config.InterfaceType)) || seedanceMaterialLibraryHost(config.BaseURL) || strings.EqualFold(strings.TrimSpace(config.ChannelID), "beefapi") {
		refs.MinVideoPixels = documentedSeedanceVideoMinPixels
	}
}

func seedanceMaterialLibraryHost(baseURL string) bool {
	u, err := url.Parse(baseURL)
	if err != nil {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "beeftv.app", "enterprise.beefapi.com", "beefapi.com", "www.whatstoken.ai", "whatstoken.ai":
		return true
	default:
		return false
	}
}

// 输出时长下限官方是 4 秒：2.0 为 4~15，2.5 为 4~30。
// 区间、连续（fractionalMin）和枚举三种已保存配置都要收紧，枚举里的 -1（自动）保留。
func tightenSeedanceOutputDuration(duration *VideoDurationConfig) {
	minimum := documentedSeedanceOutputMinSeconds
	if duration == nil {
		return
	}
	if duration.Selection == "enum" {
		values := make([]int, 0, len(duration.Values))
		for _, seconds := range duration.Values {
			if seconds != -1 && seconds < minimum {
				continue
			}
			values = append(values, seconds)
		}
		// 过滤后没有合法时长时保留空列表：这份配置没有可提交的时长，
		// 让校验直接拒绝，而不是退回原来的低于 4 秒的值。
		duration.Values = values
		if len(values) == 0 {
			return
		}
		if duration.Default == -1 && containsInt(values, -1) || containsInt(values, duration.Default) {
			return
		}
		duration.Default = values[0]
		if duration.Default == -1 && len(values) > 1 {
			duration.Default = values[1]
		}
		return
	}
	if duration.Continuous && duration.FractionalMin > 0 && duration.FractionalMin < float64(minimum) {
		duration.FractionalMin = float64(minimum)
	}
	if duration.Min < minimum {
		duration.Min = minimum
	}
	if duration.Default < minimum {
		duration.Default = minimum
	}
}

// 官方文档写的下限只会收紧素材合同，不会放宽管理员已经配得更严的数值。
// 输出时长与参考音频下限对所有 Seedance 2.x 线路都成立。
func tightenSeedanceDocumentedRouteLimits(config TaskConfig, value *VideoCapabilityConfig) {
	if value == nil || !isSeedance2Family(config.InterfaceType, config.Model) {
		return
	}
	tightenSeedanceOutputDuration(&value.Duration)
	if value.References.MinAudioDuration < officialSeedanceMinAudioSeconds {
		value.References.MinAudioDuration = officialSeedanceMinAudioSeconds
	}
}

func tightenedVideoCapability(config TaskConfig, profile *VideoCapabilityConfig) *VideoCapabilityConfig {
	if hasServerVideoCapability(config) {
		return profile
	}
	if profile == nil {
		return nil
	}
	value := *profile
	value.References = profile.References
	if isSeedance2Family(config.InterfaceType, config.Model) {
		defaults := overlayOfficialSeedance2References(VideoReferenceConfig{}, isSeedance25Model(config.Model))
		if value.References.MinImageWidth <= 0 {
			value.References.MinImageWidth = defaults.MinImageWidth
		}
		if value.References.MaxImageWidth <= 0 {
			value.References.MaxImageWidth = defaults.MaxImageWidth
		}
		if value.References.MinImageHeight <= 0 {
			value.References.MinImageHeight = defaults.MinImageHeight
		}
		if value.References.MaxImageHeight <= 0 {
			value.References.MaxImageHeight = defaults.MaxImageHeight
		}
		if value.References.MinImageAspect <= 0 {
			value.References.MinImageAspect = defaults.MinImageAspect
		}
		if value.References.MaxImageAspect <= 0 {
			value.References.MaxImageAspect = defaults.MaxImageAspect
		}
		if value.References.MinVideoWidth <= 0 {
			value.References.MinVideoWidth = defaults.MinVideoWidth
		}
		if value.References.MaxVideoWidth <= 0 {
			value.References.MaxVideoWidth = defaults.MaxVideoWidth
		}
		if value.References.MinVideoHeight <= 0 {
			value.References.MinVideoHeight = defaults.MinVideoHeight
		}
		if value.References.MaxVideoHeight <= 0 {
			value.References.MaxVideoHeight = defaults.MaxVideoHeight
		}
		if value.References.MinVideoAspect <= 0 {
			value.References.MinVideoAspect = defaults.MinVideoAspect
		}
		if value.References.MaxVideoAspect <= 0 {
			value.References.MaxVideoAspect = defaults.MaxVideoAspect
		}
		if value.References.MinVideoPixels <= 0 {
			value.References.MinVideoPixels = defaults.MinVideoPixels
		}
		if value.References.MaxVideoPixels <= 0 {
			value.References.MaxVideoPixels = defaults.MaxVideoPixels
		}
		if value.References.MinVideoDuration <= 0 {
			value.References.MinVideoDuration = defaults.MinVideoDuration
		}
		if value.References.MaxVideoTotalDuration <= 0 {
			value.References.MaxVideoTotalDuration = defaults.MaxVideoTotalDuration
		}
		if value.References.MaxAudioTotalDuration <= 0 {
			value.References.MaxAudioTotalDuration = defaults.MaxAudioTotalDuration
		}
		if isSeedance25Model(config.Model) {
			value.TaskTypeConstraints = true
		}
	}
	tightenSeedanceDocumentedRouteLimits(config, &value)
	return &value
}

func hasServerVideoCapability(config TaskConfig) bool {
	return config.VideoCapabilitiesVersion != nil && strings.TrimSpace(*config.VideoCapabilitiesVersion) != ""
}

func overlayOfficialSeedance2References(base VideoReferenceConfig, is25 bool) VideoReferenceConfig {
	refs := base
	if is25 {
		refs.MaxImages = 30
		refs.MaxVideos = 10
		refs.MaxAudios = 10
		refs.MaxVideoDuration = 30
		refs.MaxAudioDuration = 30
		refs.MaxAudioTotalDuration = 30
		refs.MaxVideoTotalDuration = 30
	} else {
		refs.MaxImages = 9
		refs.MaxVideos = 3
		refs.MaxAudios = 3
		refs.MaxVideoDuration = 15
		refs.MaxAudioDuration = 15
		refs.MaxAudioTotalDuration = 15
		refs.MaxVideoTotalDuration = 15
	}
	refs.MinVideoDuration = 2
	refs.MinAudioDuration = officialSeedanceMinAudioSeconds
	if refs.MaxImageBytes <= 0 {
		refs.MaxImageBytes = 30 * 1024 * 1024
	}
	refs.MaxVideoBytes = 200 * 1024 * 1024
	refs.MaxAudioBytes = 15 * 1024 * 1024
	refs.MinImageWidth, refs.MaxImageWidth = officialSeedanceImageMinEdge, officialSeedanceImageMaxEdge
	refs.MinImageHeight, refs.MaxImageHeight = officialSeedanceImageMinEdge, officialSeedanceImageMaxEdge
	refs.MinImageAspect, refs.MaxImageAspect = officialSeedanceImageMinAspect, officialSeedanceImageMaxAspect
	refs.MinVideoWidth, refs.MaxVideoWidth = officialSeedanceImageMinEdge, officialSeedanceImageMaxEdge
	refs.MinVideoHeight, refs.MaxVideoHeight = officialSeedanceImageMinEdge, officialSeedanceImageMaxEdge
	refs.MinVideoAspect, refs.MaxVideoAspect = officialSeedanceImageMinAspect, officialSeedanceImageMaxAspect
	refs.MinVideoPixels, refs.MaxVideoPixels = officialSeedanceVideoMinPixels, officialSeedanceVideoMaxPixels
	return refs
}

func validateVideoReferenceMedia(profile *VideoCapabilityConfig, input TaskInput) error {
	if profile == nil {
		return kernel.BadAuthRequest("当前视频模型能力参数无效")
	}
	if videoTaskOperation(profile, input) == "draft_to_final" {
		if metadataString(input.Metadata, "videoDraftTaskId") == "" {
			return kernel.BadAuthRequest("高清成片需要关联已完成的有声样片任务 ID")
		}
		if len(input.ReferenceImages) > 0 || len(input.ReferenceVideos) > 0 || len(input.ReferenceAudios) > 0 {
			return kernel.BadAuthRequest("样片转高清成片直接复用原样片设定，不能再附加参考图片、视频或音频")
		}
		return nil
	}
	profile = tightenedVideoCapability(input.Config, profile)
	refs := videoReferencesForOperation(profile, metadataString(input.Metadata, "videoEditOperation"))
	applySeedanceDocumentedVideoPixelFloor(input.Config, &refs)
	if !hasServerVideoCapability(input.Config) && isNativeDreaminaSeedance(input.Config.InterfaceType, input.Config.Model) && isSeedance25Model(input.Config.Model) && metadataString(input.Metadata, "videoEditOperation") == "inpaint" && refs.MinVideoDuration < 4 {
		refs.MinVideoDuration = 4
	}

	if err := validateVideoReferenceCounts(refs, input); err != nil {
		return err
	}
	if !videoCapabilityAllowsAudioOnly(profile) && len(input.ReferenceAudios) > 0 && len(input.ReferenceImages) == 0 && len(input.ReferenceVideos) == 0 {
		return kernel.BadAuthRequest("当前视频模型不支持只用音频生成视频，请同时添加参考图片或参考视频")
	}
	if input.DeferReferenceMetadata {
		return nil
	}
	for index, media := range input.ReferenceImages {
		if err := validateVideoReferenceImage(refs, index, media); err != nil {
			return err
		}
	}
	var totalVideoMs int64
	for index, media := range input.ReferenceVideos {
		totalVideoMs += media.DurationMs
		if err := validateVideoReferenceVideo(refs, index, media); err != nil {
			return err
		}
	}
	if maximum := refs.MaxVideoTotalDuration; maximum > 0 && totalVideoMs > int64(maximum)*1000 {
		return kernel.BadAuthRequest(fmt.Sprintf("参考视频总时长为 %.2f 秒，当前模型最多支持 %d 秒；请裁剪或减少参考视频后再提交", float64(totalVideoMs)/1000, maximum))
	}
	var totalAudioMs int64
	for index, media := range input.ReferenceAudios {
		if err := validateReferenceDurationUnlessOpaqueAsset("音频", index, media, refs.MinAudioDuration, float64(refs.MaxAudioDuration)); err != nil {
			return err
		}
		if err := validateReferenceFileBytes("音频", index, media.Bytes, refs.MaxAudioBytes); err != nil {
			return err
		}
		totalAudioMs += media.DurationMs
	}
	if maximum := refs.MaxAudioTotalDuration; maximum > 0 && totalAudioMs > int64(maximum)*1000 {
		return kernel.BadAuthRequest(fmt.Sprintf("参考音频总时长为 %.2f 秒，当前模型最多支持 %d 秒；请裁剪或减少参考音频后再提交", float64(totalAudioMs)/1000, maximum))
	}
	return nil
}

func validateVideoReferenceImage(refs VideoReferenceConfig, index int, media MediaRef) error {
	if err := validateReferenceFileBytes("图", index, media.Bytes, refs.MaxImageBytes); err != nil {
		return err
	}
	return validateReferenceGeometry("图", index, media.Width, media.Height, refs.MinImageWidth, refs.MaxImageWidth, refs.MinImageHeight, refs.MaxImageHeight, refs.MinImageAspect, refs.MaxImageAspect, refs.MinImagePixels, refs.MaxImagePixels)
}

func validateVideoReferenceVideo(refs VideoReferenceConfig, index int, media MediaRef) error {
	if err := validateReferenceDurationUnlessOpaqueAsset("视频", index, media, float64(refs.MinVideoDuration), float64(refs.MaxVideoDuration)); err != nil {
		return err
	}
	if err := validateReferenceFileBytes("视频", index, media.Bytes, refs.MaxVideoBytes); err != nil {
		return err
	}
	if refs.MinVideoPixels > 0 && (media.Width <= 0 || media.Height <= 0) && !opaqueVideoAssetPattern.MatchString(strings.TrimSpace(media.URL)) {
		return kernel.BadAuthRequest(fmt.Sprintf("第 %d 个参考视频尺寸无法读取，请重新导入素材后再提交", index+1))
	}
	return validateReferenceGeometry("视频", index, media.Width, media.Height, refs.MinVideoWidth, refs.MaxVideoWidth, refs.MinVideoHeight, refs.MaxVideoHeight, refs.MinVideoAspect, refs.MaxVideoAspect, refs.MinVideoPixels, refs.MaxVideoPixels)
}

func validateReferenceFileBytes(kind string, index int, bytes, maximum int64) error {
	if maximum <= 0 || bytes <= 0 || bytes <= maximum {
		return nil
	}
	unit := "张"
	if kind != "图" {
		unit = "个"
		if kind == "音频" {
			unit = "段"
		}
	}
	return kernel.BadAuthRequest(fmt.Sprintf("第 %d %s参考%s文件过大，当前模型单文件上限为 %s；请压缩或更换后再提交", index+1, unit, kind, formatMediaByteLimit(maximum)))
}

func validateReferenceDurationUnlessOpaqueAsset(kind string, index int, media MediaRef, minimum, maximum float64) error {
	if referenceDurationIsOpaqueAsset(media) {
		return nil
	}
	return validateReferenceDuration(kind, index, media.DurationMs, minimum, maximum)
}

func validateReferenceGeometry(kind string, index, width, height, minWidth, maxWidth, minHeight, maxHeight int, minAspect, maxAspect float64, minPixels, maxPixels int64) error {
	if width <= 0 || height <= 0 {
		return nil
	}
	unit := "张"
	if kind != "图" {
		unit = "个"
	}
	label := fmt.Sprintf("第 %d %s参考%s", index+1, unit, kind)
	if minWidth > 0 && width < minWidth || maxWidth > 0 && width > maxWidth {
		return kernel.BadAuthRequest(fmt.Sprintf("%s宽度为 %d 像素，需要 %s 像素；请调整尺寸或更换后再提交", label, width, referenceBound(float64(minWidth), float64(maxWidth))))
	}
	if minHeight > 0 && height < minHeight || maxHeight > 0 && height > maxHeight {
		return kernel.BadAuthRequest(fmt.Sprintf("%s高度为 %d 像素，需要 %s 像素；请调整尺寸或更换后再提交", label, height, referenceBound(float64(minHeight), float64(maxHeight))))
	}
	aspect := float64(width) / float64(height)
	if minAspect > 0 && aspect < minAspect || maxAspect > 0 && aspect > maxAspect {
		return kernel.BadAuthRequest(fmt.Sprintf("%s宽高比为 %.2f，需要 %s；请调整尺寸或更换后再提交", label, aspect, referenceBound(minAspect, maxAspect)))
	}
	pixels := int64(width) * int64(height)
	if minPixels > 0 && pixels < minPixels || maxPixels > 0 && pixels > maxPixels {
		return kernel.BadAuthRequest(fmt.Sprintf("%s像素总量为 %d（%d×%d），需要 %s 像素；请调整这份素材的尺寸或更换原文件，修改生成分辨率不会改变参考素材", label, pixels, width, height, referenceBound(float64(minPixels), float64(maxPixels))))
	}
	return nil
}

func referenceBound(min, max float64) string {
	if min <= 0 {
		return "不超过 " + formatDurationBound(max)
	}
	if max <= 0 {
		return "至少 " + formatDurationBound(min)
	}
	return formatDurationBound(min) + "–" + formatDurationBound(max)
}

func formatMediaByteLimit(bytes int64) string {
	if bytes%(1024*1024) == 0 {
		return fmt.Sprintf("%dMB", bytes/(1024*1024))
	}
	return fmt.Sprintf("%d 字节", bytes)
}

func formatDurationBound(value float64) string {
	if value == math.Trunc(value) {
		return strconv.Itoa(int(value))
	}
	return strconv.FormatFloat(value, 'f', 1, 64)
}

func durationLimitMs(seconds float64) int64 {
	return int64(math.Round(seconds * 1000))
}

func videoCapabilityAllowsAudioOnly(profile *VideoCapabilityConfig) bool {
	if profile == nil {
		return false
	}
	return containsCapabilityString(profile.Operations, "audio_to_video")
}

func ValidateVideoReferenceMedia(profile *VideoCapabilityConfig, input TaskInput) error {
	return validateVideoReferenceMedia(profile, input)
}

func IsSeedance2Family(protocol, modelName string) bool {
	return isSeedance2Family(protocol, modelName)
}

func IsSeedance25Model(modelName string) bool {
	return isSeedance25Model(modelName)
}

func OverlayOfficialSeedance2References(base VideoReferenceConfig, is25 bool) VideoReferenceConfig {
	return overlayOfficialSeedance2References(base, is25)
}

func ApplySeedanceDocumentedVideoPixelFloor(config TaskConfig, refs *VideoReferenceConfig) {
	applySeedanceDocumentedVideoPixelFloor(config, refs)
}

func ValidateVideoReferenceImage(refs VideoReferenceConfig, index int, media MediaRef) error {
	return validateVideoReferenceImage(refs, index, media)
}

func ValidateVideoReferenceVideo(refs VideoReferenceConfig, index int, media MediaRef) error {
	return validateVideoReferenceVideo(refs, index, media)
}

func VideoCapabilityAllowsAudioOnly(profile *VideoCapabilityConfig) bool {
	return videoCapabilityAllowsAudioOnly(profile)
}
