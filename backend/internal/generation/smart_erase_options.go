package generation

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"

	"infinite-canvas/backend/internal/beeftv"
)

const (
	SubtitleEraseModelName     = "video-subtitle-erase"
	SubtitleEraseMegaModelName = "video-subtitle-erase-mega"
	WatermarkEraseModelName    = "video-watermark-erase"
	PrivacyProtectModelName    = "video-privacy-protect"

	smartEraseMaxNormalizedCoord = 0.9999
)

type smartEraseModeSpec struct {
	EraseType        string
	ManagedOperation string
	DefaultModel     string
	Prompt           string
	ActiveStage      string
}

var smartEraseModeSpecs = map[string]smartEraseModeSpec{
	"subtitle": {
		EraseType:        "subtitle",
		ManagedOperation: "subtitle_erase",
		DefaultModel:     SubtitleEraseModelName,
		Prompt:           "视频去字幕",
		ActiveStage:      "正在消除视频字幕",
	},
	"watermark": {
		EraseType:        "watermark",
		ManagedOperation: "watermark_erase",
		DefaultModel:     WatermarkEraseModelName,
		Prompt:           "视频去水印",
		ActiveStage:      "正在消除视频水印",
	},
	"privacy": {
		EraseType:        "privacy",
		ManagedOperation: "privacy_protect",
		DefaultModel:     PrivacyProtectModelName,
		Prompt:           "视频隐私打码",
		ActiveStage:      "正在进行隐私打码",
	},
}

var (
	supportedEraseTypes               = []string{"subtitle", "watermark", "privacy"}
	supportedEraseMethods             = []string{"auto", "custom"}
	supportedSubtitleModels           = []string{"standard", "area", "mega"}
	supportedWatermarkModels          = []string{"advanced", "basic"}
	supportedPrivacyModels            = []string{"blur", "mosaic"}
	supportedPrivacyTargets           = []string{"face", "plate"}
	supportedSubtitleLangs            = []string{"zh_en", "multi"}
	supportedSubtitleFormats          = []string{"srt", "vtt"}
	supportedSmartEraseTranslateLangs = []string{
		"zh", "en", "ja", "ko", "fr", "es", "it", "de",
		"tr", "ru", "pt", "vi", "id", "ms", "th", "ar", "hi",
	}
)

func IsSmartEraseModel(name string) bool {
	switch strings.TrimSpace(name) {
	case SubtitleEraseModelName, SubtitleEraseMegaModelName, WatermarkEraseModelName, PrivacyProtectModelName:
		return true
	default:
		return false
	}
}

func resolveSmartEraseSpec(opts *SubtitleEraseOptions, modelName string) smartEraseModeSpec {
	if opts != nil {
		if spec, ok := smartEraseModeSpecs[strings.ToLower(strings.TrimSpace(opts.EraseType))]; ok {
			return spec
		}
	}
	switch strings.TrimSpace(modelName) {
	case WatermarkEraseModelName:
		return smartEraseModeSpecs["watermark"]
	case PrivacyProtectModelName:
		return smartEraseModeSpecs["privacy"]
	default:
		return smartEraseModeSpecs["subtitle"]
	}
}

func SmartEraseStageForTask(operation, modelName string) string {
	switch strings.TrimSpace(operation) {
	case "media.video.watermark_erase", "watermark_erase":
		return smartEraseModeSpecs["watermark"].ActiveStage
	case "media.video.privacy_protect", "privacy_protect":
		return smartEraseModeSpecs["privacy"].ActiveStage
	case "media.video.subtitle_erase", "subtitle_erase":
		return smartEraseModeSpecs["subtitle"].ActiveStage
	}
	return resolveSmartEraseSpec(nil, modelName).ActiveStage
}

func smartEraseModelForOptions(opts SubtitleEraseOptions) string {
	spec := resolveSmartEraseSpec(&opts, "")
	if spec.EraseType == "subtitle" && opts.SubtitleModel == "mega" {
		return SubtitleEraseMegaModelName
	}
	return spec.DefaultModel
}

func smartEraseManagedOperation(opts *SubtitleEraseOptions, modelName string) string {
	return resolveSmartEraseSpec(opts, modelName).ManagedOperation
}

func (in Input) SmartEraseTaskOperation() string {
	return "media.video." + smartEraseManagedOperation(in.SubtitleErase, in.Config.Model)
}

func smartErasePromptAndStage(opts *SubtitleEraseOptions, modelName string) (string, string) {
	spec := resolveSmartEraseSpec(opts, modelName)
	return spec.Prompt, spec.ActiveStage
}

type SubtitleEraseRegion struct {
	X      *float64 `json:"x,omitempty"`
	Y      *float64 `json:"y,omitempty"`
	Width  *float64 `json:"width,omitempty"`
	Height *float64 `json:"height,omitempty"`
}

type SubtitleEraseOptions struct {
	EraseType        string               `json:"eraseType,omitempty"`
	EraseMethod      string               `json:"eraseMethod,omitempty"`
	SubtitleModel    string               `json:"subtitleModel,omitempty"`
	WatermarkModel   string               `json:"watermarkModel,omitempty"`
	PrivacyModel     string               `json:"privacyModel,omitempty"`
	PrivacyTargets   []string             `json:"privacyTargets,omitempty"`
	Region           *SubtitleEraseRegion `json:"region,omitempty"`
	OCRExtract       bool                 `json:"ocrExtract,omitempty"`
	SubtitleLang     string               `json:"subtitleLang,omitempty"`
	SubtitleFormat   string               `json:"subtitleFormat,omitempty"`
	Translate        bool                 `json:"translate,omitempty"`
	TranslateDstLang string               `json:"translateDstLang,omitempty"`
	SubtitleEmbedID  *int64               `json:"subtitleEmbedId,omitempty"`
	UseOriginalPos   *bool                `json:"useOriginalPos,omitempty"`
	UseOriginalSize  *bool                `json:"useOriginalSize,omitempty"`
}

type SubtitleEraseRequest struct {
	ResourceID        string               `json:"resourceId"`
	ChannelID         string               `json:"channelId"`
	EraseType         string               `json:"eraseType,omitempty"`
	EraseMethod       string               `json:"eraseMethod,omitempty"`
	SubtitleModel     string               `json:"subtitleModel,omitempty"`
	WatermarkModel    string               `json:"watermarkModel,omitempty"`
	PrivacyModel      string               `json:"privacyModel,omitempty"`
	PrivacyTargets    []string             `json:"privacyTargets,omitempty"`
	Region            *SubtitleEraseRegion `json:"region,omitempty"`
	OCRExtract        bool                 `json:"ocrExtract,omitempty"`
	SubtitleLang      string               `json:"subtitleLang,omitempty"`
	SubtitleFormat    string               `json:"subtitleFormat,omitempty"`
	Translate         bool                 `json:"translate,omitempty"`
	TranslateDstLang  string               `json:"translateDstLang,omitempty"`
	SubtitleEmbedID   *int64               `json:"subtitleEmbedId,omitempty"`
	UseOriginalPos    *bool                `json:"useOriginalPos,omitempty"`
	UseOriginalSize   *bool                `json:"useOriginalSize,omitempty"`
	ClientOperationID string               `json:"clientOperationId,omitempty"`
	ProjectID         string               `json:"projectId,omitempty"`
	NodeID            string               `json:"nodeId,omitempty"`
}

func validateSubtitleEraseRegion(region *SubtitleEraseRegion, required bool) error {
	if region == nil {
		if required {
			return errors.New("框选区域模式必须指定区域坐标")
		}
		return nil
	}
	if region.X == nil || region.Y == nil || region.Width == nil || region.Height == nil {
		return errors.New("擦除区域坐标不完整")
	}
	x, y, w, h := *region.X, *region.Y, *region.Width, *region.Height
	for _, v := range []float64{x, y, w, h} {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return errors.New("擦除区域坐标无效")
		}
	}
	if x < 0 || y < 0 || w <= 0 || h <= 0 || x >= smartEraseMaxNormalizedCoord || y >= smartEraseMaxNormalizedCoord || x+w > 1.000001 || y+h > 1.000001 {
		return errors.New("擦除区域超出视频画面范围")
	}
	return nil
}

// clampNormalizedSmartEraseRegion keeps normalized right/bottom coordinates
// strictly below 1.0 (<= 0.9999) so full-width or bottom-flush UI boxes never
// trigger open-interval [0, 1) validation rejections upstream.
func clampNormalizedSmartEraseRegion(region *SubtitleEraseRegion) *SubtitleEraseRegion {
	if region == nil || region.X == nil || region.Y == nil || region.Width == nil || region.Height == nil {
		return nil
	}
	x := math.Max(0, math.Min(*region.X, smartEraseMaxNormalizedCoord-0.0001))
	y := math.Max(0, math.Min(*region.Y, smartEraseMaxNormalizedCoord-0.0001))
	w := *region.Width
	h := *region.Height
	if x+w > smartEraseMaxNormalizedCoord {
		w = math.Round((smartEraseMaxNormalizedCoord-x)*1_000_000) / 1_000_000
	}
	if y+h > smartEraseMaxNormalizedCoord {
		h = math.Round((smartEraseMaxNormalizedCoord-y)*1_000_000) / 1_000_000
	}
	return &SubtitleEraseRegion{X: &x, Y: &y, Width: &w, Height: &h}
}

func normalizeSmartEraseOptions(raw SubtitleEraseOptions) (SubtitleEraseOptions, error) {
	eraseType := strings.ToLower(strings.TrimSpace(raw.EraseType))
	if eraseType != "" && !slices.Contains(supportedEraseTypes, eraseType) {
		return SubtitleEraseOptions{}, errors.New("智能擦除类型仅支持去字幕、去水印或隐私打码")
	}

	switch eraseType {
	case "watermark":
		if strings.TrimSpace(raw.SubtitleModel) != "" || raw.OCRExtract || raw.Translate || strings.TrimSpace(raw.PrivacyModel) != "" || len(raw.PrivacyTargets) > 0 {
			return SubtitleEraseOptions{}, errors.New("去水印模式不支持字幕或隐私打码参数")
		}
		method := strings.ToLower(strings.TrimSpace(raw.EraseMethod))
		if method == "" {
			method = "auto"
		}
		if !slices.Contains(supportedEraseMethods, method) {
			return SubtitleEraseOptions{}, errors.New("去水印方式仅支持自动识别或框选区域")
		}
		wmModel := strings.ToLower(strings.TrimSpace(raw.WatermarkModel))
		if wmModel == "" {
			wmModel = "advanced"
		}
		if !slices.Contains(supportedWatermarkModels, wmModel) {
			return SubtitleEraseOptions{}, errors.New("去水印模型仅支持高级版或基础版")
		}
		if err := validateSubtitleEraseRegion(raw.Region, method == "custom"); err != nil {
			return SubtitleEraseOptions{}, err
		}
		var region *SubtitleEraseRegion
		if method == "custom" {
			region = clampNormalizedSmartEraseRegion(raw.Region)
		}
		return SubtitleEraseOptions{
			EraseType:      "watermark",
			EraseMethod:    method,
			WatermarkModel: wmModel,
			Region:         region,
		}, nil

	case "privacy":
		if strings.TrimSpace(raw.EraseMethod) != "" || raw.Region != nil || strings.TrimSpace(raw.SubtitleModel) != "" || strings.TrimSpace(raw.WatermarkModel) != "" || raw.OCRExtract || raw.Translate {
			return SubtitleEraseOptions{}, errors.New("隐私打码模式仅支持全画面自动识别，不支持手绘框选或字幕参数")
		}
		privModel := strings.ToLower(strings.TrimSpace(raw.PrivacyModel))
		if privModel == "" {
			privModel = "blur"
		}
		if !slices.Contains(supportedPrivacyModels, privModel) {
			return SubtitleEraseOptions{}, errors.New("隐私打码样式仅支持高斯模糊或马赛克")
		}
		var targets []string
		seen := make(map[string]bool, 2)
		for _, item := range raw.PrivacyTargets {
			norm := strings.ToLower(strings.TrimSpace(item))
			if norm == "license_plate" {
				norm = "plate"
			}
			if !slices.Contains(supportedPrivacyTargets, norm) {
				return SubtitleEraseOptions{}, errors.New("隐私保护目标仅支持人脸或车牌")
			}
			if !seen[norm] {
				seen[norm] = true
				targets = append(targets, norm)
			}
		}
		if len(targets) == 0 {
			targets = append([]string(nil), supportedPrivacyTargets...)
		}
		return SubtitleEraseOptions{
			EraseType:      "privacy",
			PrivacyModel:   privModel,
			PrivacyTargets: targets,
		}, nil

	default:
		if strings.TrimSpace(raw.WatermarkModel) != "" || strings.TrimSpace(raw.PrivacyModel) != "" || len(raw.PrivacyTargets) > 0 {
			return SubtitleEraseOptions{}, errors.New("去字幕模式不支持水印或隐私打码参数")
		}
		sm := strings.ToLower(strings.TrimSpace(raw.SubtitleModel))
		if sm == "" {
			sm = "standard"
		}
		if !slices.Contains(supportedSubtitleModels, sm) {
			return SubtitleEraseOptions{}, errors.New("字幕样式仅支持标准无痕、花字增强或大模型精擦")
		}
		m := strings.ToLower(strings.TrimSpace(raw.EraseMethod))
		if m == "" {
			m = "auto"
		}
		if !slices.Contains(supportedEraseMethods, m) {
			return SubtitleEraseOptions{}, errors.New("去字幕方式仅支持自动识别或框选区域")
		}
		if sm == "mega" {
			if m != "auto" || raw.Region != nil || raw.OCRExtract || raw.Translate || strings.TrimSpace(raw.SubtitleLang) != "" || strings.TrimSpace(raw.SubtitleFormat) != "" || strings.TrimSpace(raw.TranslateDstLang) != "" || raw.SubtitleEmbedID != nil {
				return SubtitleEraseOptions{}, errors.New("大模型精擦仅支持全画面自动识别，暂不支持框选区域或字幕提取翻译")
			}
			return SubtitleEraseOptions{
				EraseType:     eraseType,
				EraseMethod:   "auto",
				SubtitleModel: "mega",
			}, nil
		}
		if err := validateSubtitleEraseRegion(raw.Region, m == "custom"); err != nil {
			return SubtitleEraseOptions{}, err
		}
		ocr := raw.OCRExtract || raw.Translate
		if ocr && m != "auto" {
			return SubtitleEraseOptions{}, errors.New("字幕提取与翻译仅在自动识别模式下可用")
		}
		var region *SubtitleEraseRegion
		if m == "custom" {
			region = clampNormalizedSmartEraseRegion(raw.Region)
		}
		out := SubtitleEraseOptions{
			EraseType:     eraseType,
			EraseMethod:   m,
			SubtitleModel: sm,
			Region:        region,
		}
		if !ocr {
			if strings.TrimSpace(raw.SubtitleLang) != "" || strings.TrimSpace(raw.SubtitleFormat) != "" || strings.TrimSpace(raw.TranslateDstLang) != "" || raw.SubtitleEmbedID != nil || raw.UseOriginalPos != nil || raw.UseOriginalSize != nil {
				return SubtitleEraseOptions{}, errors.New("请先开启字幕提取或翻译选项")
			}
			return out, nil
		}
		subLang := strings.ToLower(strings.TrimSpace(raw.SubtitleLang))
		if subLang == "" {
			subLang = "zh_en"
		}
		if !slices.Contains(supportedSubtitleLangs, subLang) {
			return SubtitleEraseOptions{}, errors.New("源字幕语种仅支持中英混合或多语种自动识别")
		}
		subFmt := strings.ToLower(strings.TrimSpace(raw.SubtitleFormat))
		if subFmt == "" {
			subFmt = "srt"
		}
		if !slices.Contains(supportedSubtitleFormats, subFmt) {
			return SubtitleEraseOptions{}, errors.New("字幕导出格式仅支持 SRT 或 VTT")
		}
		out.OCRExtract = true
		out.SubtitleLang = subLang
		out.SubtitleFormat = subFmt
		if !raw.Translate {
			if strings.TrimSpace(raw.TranslateDstLang) != "" || raw.SubtitleEmbedID != nil || raw.UseOriginalPos != nil || raw.UseOriginalSize != nil {
				return SubtitleEraseOptions{}, errors.New("目标翻译语种与压制模板需要先开启字幕翻译")
			}
			return out, nil
		}
		dstLang := strings.ToLower(strings.TrimSpace(raw.TranslateDstLang))
		if dstLang == "" {
			dstLang = "en"
		}
		if !slices.Contains(supportedSmartEraseTranslateLangs, dstLang) {
			return SubtitleEraseOptions{}, errors.New("不支持该目标翻译语种")
		}
		out.Translate = true
		out.TranslateDstLang = dstLang
		if raw.SubtitleEmbedID != nil {
			if *raw.SubtitleEmbedID <= 0 {
				return SubtitleEraseOptions{}, errors.New("字幕压制模板 ID 必须为正整数")
			}
			idCopy := *raw.SubtitleEmbedID
			out.SubtitleEmbedID = &idCopy
		}
		if (raw.UseOriginalPos != nil || raw.UseOriginalSize != nil) && out.SubtitleEmbedID == nil {
			return SubtitleEraseOptions{}, errors.New("保留原字幕位置或字号需要先填写字幕压制模板 ID")
		}
		out.UseOriginalPos = raw.UseOriginalPos
		out.UseOriginalSize = raw.UseOriginalSize
		return out, nil
	}
}

func requestToOptions(req SubtitleEraseRequest) SubtitleEraseOptions {
	return SubtitleEraseOptions{
		EraseType:        req.EraseType,
		EraseMethod:      req.EraseMethod,
		SubtitleModel:    req.SubtitleModel,
		WatermarkModel:   req.WatermarkModel,
		PrivacyModel:     req.PrivacyModel,
		PrivacyTargets:   req.PrivacyTargets,
		Region:           req.Region,
		OCRExtract:       req.OCRExtract,
		SubtitleLang:     req.SubtitleLang,
		SubtitleFormat:   req.SubtitleFormat,
		Translate:        req.Translate,
		TranslateDstLang: req.TranslateDstLang,
		SubtitleEmbedID:  req.SubtitleEmbedID,
		UseOriginalPos:   req.UseOriginalPos,
		UseOriginalSize:  req.UseOriginalSize,
	}
}

func ValidateSubtitleEraseInput(input Input) error {
	label := resolveSmartEraseSpec(input.SubtitleErase, input.Config.Model).Prompt
	if input.Mode != "video" || strings.TrimSpace(input.Config.Model) == "" || input.SubtitleErase == nil {
		return fmt.Errorf("%s任务参数无效", label)
	}
	if len(input.ReferenceVideos) != 1 || len(input.ReferenceImages) != 0 || len(input.ReferenceAudios) != 0 || input.Mask != nil {
		return fmt.Errorf("%s需要且仅需要一个源视频", label)
	}
	source := input.ReferenceVideos[0]
	if !upscaleOwnedSource.MatchString(source.StorageKey) || source.URL != "" || source.DataURL != "" {
		return fmt.Errorf("%s只能使用当前素材库中的视频", label)
	}
	_, err := normalizeSmartEraseOptions(*input.SubtitleErase)
	return err
}

func toBeefTVSubtitleRegion(region *SubtitleEraseRegion) *beeftv.SubtitleEraseRegion {
	clamped := clampNormalizedSmartEraseRegion(region)
	if clamped == nil {
		return nil
	}
	return &beeftv.SubtitleEraseRegion{X: clamped.X, Y: clamped.Y, Width: clamped.Width, Height: clamped.Height}
}
