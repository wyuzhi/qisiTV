package generation

import (
	"context"
	"slices"
	"strings"
	"time"
)

func SubtitleEraseCapabilities(ctx context.Context, lookupCred func() (string, string, string, string, error), bindRuntime func(context.Context, CallMeta) context.Context) map[string]any {
	out := map[string]any{
		"model":              SubtitleEraseModelName,
		"eraseTypes":         append([]string(nil), supportedEraseTypes...),
		"eraseMethods":       append([]string(nil), supportedEraseMethods...),
		"subtitleModels":     []string{"standard", "area"},
		"watermarkModels":    append([]string(nil), supportedWatermarkModels...),
		"privacyModels":      append([]string(nil), supportedPrivacyModels...),
		"privacyTargets":     append([]string(nil), supportedPrivacyTargets...),
		"subtitleLangs":      append([]string(nil), supportedSubtitleLangs...),
		"subtitleFormats":    append([]string(nil), supportedSubtitleFormats...),
		"translateDstLangs":  append([]string(nil), supportedSmartEraseTranslateLangs...),
		"maxVideoDurationMs": 600000,
		"cloudProcessing":    true,
		"available":          false,
	}
	if lookupCred == nil {
		return out
	}
	cfg, err := UpscaleConfig(SubtitleEraseModelName, lookupCred)
	if err != nil {
		return out
	}
	qctx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	defer cancel()
	if bindRuntime != nil {
		qctx = bindRuntime(qctx, CallMeta{RequestKind: "capabilities"})
	}
	qctx = WithRequestKind(qctx, "capabilities")
	caps, err := managedMediaClient(qctx, cfg).GetSubtitleEraseCapabilities(qctx)
	if err != nil {
		return out
	}
	out["capabilitiesLoaded"] = true
	se := caps.ResolvedMatrix()

	capsMethods := intersectAllowedStrings(caps.EraseMethods, supportedEraseMethods)
	capsSubModels := intersectAllowedStrings(caps.SubtitleModels, supportedSubtitleModels)
	var seEraseTypes, seEraseMethods, seSubModels, seWmModels, sePrivModels, sePrivTargets, seSubLangs, seSubFormats, seDstLangs []string
	if se != nil {
		seEraseTypes = intersectAllowedStrings(se.EraseTypes, supportedEraseTypes)
		seEraseMethods = intersectAllowedStrings(se.EraseMethods, supportedEraseMethods)
		seSubModels = intersectAllowedStrings(se.SubtitleModels, supportedSubtitleModels)
		seWmModels = intersectAllowedStrings(se.WatermarkModels, supportedWatermarkModels)
		sePrivModels = intersectAllowedStrings(se.PrivacyModels, supportedPrivacyModels)
		sePrivTargets = intersectPrivacyTargets(se.PrivacyTargets)
		seSubLangs = intersectAllowedStrings(se.SubtitleLangs, supportedSubtitleLangs)
		seSubFormats = intersectAllowedStrings(se.SubtitleFormats, supportedSubtitleFormats)
		seDstLangs = intersectAllowedStrings(se.TranslateDstLangs, supportedSmartEraseTranslateLangs)
		if len(se.RatesCNYPerMinute) > 0 {
			out["ratesCnyPerMinute"] = se.RatesCNYPerMinute
		}
	}

	hasExplicitAvailableModels := se != nil && se.AvailableModels != nil
	var availableModels []string
	if hasExplicitAvailableModels {
		availableModels = make([]string, 0, len(se.AvailableModels))
		for _, m := range se.AvailableModels {
			m = strings.TrimSpace(m)
			if IsSmartEraseModel(m) && !slices.Contains(availableModels, m) {
				availableModels = append(availableModels, m)
			}
		}
		out["availableModels"] = availableModels
	}

	primaryModel := strings.TrimSpace(caps.Model)
	if primaryModel == "" {
		primaryModel = strings.TrimSpace(caps.DefaultModel)
	}
	if primaryModel != "" {
		out["model"] = primaryModel
	}

	methods := append([]string(nil), supportedEraseMethods...)
	if len(seEraseMethods) > 0 {
		methods = seEraseMethods
	} else if len(capsMethods) > 0 {
		methods = capsMethods
	}
	out["eraseMethods"] = methods

	var subModels []string
	switch {
	case len(seSubModels) > 0:
		subModels = seSubModels
	case len(capsSubModels) > 0:
		subModels = capsSubModels
	case hasExplicitAvailableModels:
		subModels = append([]string(nil), supportedSubtitleModels...)
	case primaryModel == SubtitleEraseMegaModelName:
		subModels = []string{"mega"}
	default:
		subModels = []string{"standard", "area"}
	}
	if hasExplicitAvailableModels {
		subModels = filterSubtitleModelsByAvailable(subModels, availableModels)
	}
	if !slices.Contains(methods, "auto") {
		subModels = slices.DeleteFunc(append([]string(nil), subModels...), func(m string) bool { return m == "mega" })
	}
	out["subtitleModels"] = subModels

	if len(seWmModels) > 0 {
		out["watermarkModels"] = seWmModels
	}
	if len(sePrivModels) > 0 {
		out["privacyModels"] = sePrivModels
	}
	if len(sePrivTargets) > 0 {
		out["privacyTargets"] = sePrivTargets
	}
	if len(seSubLangs) > 0 {
		out["subtitleLangs"] = seSubLangs
	}
	if len(seSubFormats) > 0 {
		out["subtitleFormats"] = seSubFormats
	}
	if len(seDstLangs) > 0 {
		out["translateDstLangs"] = seDstLangs
	}

	hasSubList := len(seSubModels) > 0 || len(capsSubModels) > 0 || len(seSubLangs) > 0 || len(seSubFormats) > 0 || len(seDstLangs) > 0
	hasWmList := len(seWmModels) > 0
	hasPrivList := len(sePrivModels) > 0 || len(sePrivTargets) > 0

	var eraseTypes []string
	switch {
	case len(seEraseTypes) > 0:
		eraseTypes = seEraseTypes
	case hasExplicitAvailableModels:
		eraseTypes = filterEraseTypesByModels(supportedEraseTypes, availableModels)
	case hasSubList || hasWmList || hasPrivList:
		if hasSubList {
			eraseTypes = append(eraseTypes, "subtitle")
		}
		if hasWmList {
			eraseTypes = append(eraseTypes, "watermark")
		}
		if hasPrivList {
			eraseTypes = append(eraseTypes, "privacy")
		}
	case primaryModel == WatermarkEraseModelName:
		eraseTypes = []string{"watermark"}
	case primaryModel == PrivacyProtectModelName:
		eraseTypes = []string{"privacy"}
	default:
		eraseTypes = []string{"subtitle"}
	}
	if hasExplicitAvailableModels {
		eraseTypes = filterEraseTypesByModels(eraseTypes, availableModels)
	}
	if len(subModels) == 0 {
		eraseTypes = slices.DeleteFunc(append([]string(nil), eraseTypes...), func(t string) bool { return t == "subtitle" })
	}
	out["eraseTypes"] = eraseTypes

	hasExplicitEvidence := len(seEraseTypes) > 0 || len(seEraseMethods) > 0 || len(capsMethods) > 0 ||
		hasSubList || hasWmList || hasPrivList || primaryModel != ""
	available := false
	if caps.Available != nil {
		available = *caps.Available
	} else if caps.Enabled != nil {
		available = *caps.Enabled
	} else if hasExplicitAvailableModels {
		available = len(availableModels) > 0 && len(eraseTypes) > 0
	} else {
		available = hasExplicitEvidence && len(eraseTypes) > 0
	}
	if len(eraseTypes) == 0 {
		available = false
	}
	out["available"] = available
	if caps.MaxVideoSeconds > 0 {
		out["maxVideoDurationMs"] = caps.MaxVideoSeconds * 1000
	}
	if strings.TrimSpace(caps.BillingMode) != "" {
		out["billingMode"] = strings.TrimSpace(caps.BillingMode)
	}
	if strings.TrimSpace(caps.BillingSummary) != "" {
		out["billingSummary"] = strings.TrimSpace(caps.BillingSummary)
	}
	if caps.Billing != nil {
		out["billing"] = caps.Billing
	}
	return out
}

func intersectAllowedStrings(candidates, allowed []string) []string {
	if len(candidates) == 0 {
		return nil
	}
	out := make([]string, 0, len(candidates))
	for _, raw := range candidates {
		norm := strings.ToLower(strings.TrimSpace(raw))
		if norm != "" && slices.Contains(allowed, norm) && !slices.Contains(out, norm) {
			out = append(out, norm)
		}
	}
	return out
}

func intersectPrivacyTargets(candidates []string) []string {
	if len(candidates) == 0 {
		return nil
	}
	out := make([]string, 0, len(candidates))
	for _, raw := range candidates {
		norm := strings.ToLower(strings.TrimSpace(raw))
		if norm == "license_plate" {
			norm = "plate"
		}
		if slices.Contains(supportedPrivacyTargets, norm) && !slices.Contains(out, norm) {
			out = append(out, norm)
		}
	}
	return out
}

func filterEraseTypesByModels(candidates, availableModels []string) []string {
	hasSubtitle := slices.Contains(availableModels, SubtitleEraseModelName) || slices.Contains(availableModels, SubtitleEraseMegaModelName)
	hasWatermark := slices.Contains(availableModels, WatermarkEraseModelName)
	hasPrivacy := slices.Contains(availableModels, PrivacyProtectModelName)
	out := make([]string, 0, len(candidates))
	for _, item := range candidates {
		switch item {
		case "subtitle":
			if hasSubtitle {
				out = append(out, item)
			}
		case "watermark":
			if hasWatermark {
				out = append(out, item)
			}
		case "privacy":
			if hasPrivacy {
				out = append(out, item)
			}
		}
	}
	return out
}

func filterSubtitleModelsByAvailable(subtitleModels, availableModels []string) []string {
	if len(availableModels) == 0 {
		return subtitleModels
	}
	allowStandard := slices.Contains(availableModels, SubtitleEraseModelName)
	allowMega := slices.Contains(availableModels, SubtitleEraseMegaModelName)
	out := make([]string, 0, len(subtitleModels))
	for _, m := range subtitleModels {
		if m == "mega" {
			if allowMega {
				out = append(out, m)
			}
		} else if allowStandard {
			out = append(out, m)
		}
	}
	return out
}

func ValidateSmartEraseRequestCapabilities(req *SubtitleEraseRequest, caps map[string]any) error {
	if req == nil || caps == nil {
		return nil
	}
	loaded, _ := caps["capabilitiesLoaded"].(bool)
	if !loaded {
		return nil
	}
	if available, ok := caps["available"].(bool); ok && !available {
		return BadAuthRequest("当前官方算力暂未开放视频智能擦除服务")
	}

	eraseTypes, _ := stringSliceFromAny(caps["eraseTypes"])
	eraseMethods, _ := stringSliceFromAny(caps["eraseMethods"])
	subtitleModels, _ := stringSliceFromAny(caps["subtitleModels"])
	watermarkModels, _ := stringSliceFromAny(caps["watermarkModels"])
	privacyModels, _ := stringSliceFromAny(caps["privacyModels"])
	privacyTargets, _ := stringSliceFromAny(caps["privacyTargets"])
	subtitleLangs, _ := stringSliceFromAny(caps["subtitleLangs"])
	subtitleFormats, _ := stringSliceFromAny(caps["subtitleFormats"])
	translateDstLangs, _ := stringSliceFromAny(caps["translateDstLangs"])

	if strings.TrimSpace(req.EraseType) == "" {
		req.EraseType = "subtitle"
	}
	mode := strings.ToLower(strings.TrimSpace(req.EraseType))
	switch mode {
	case "watermark":
		if strings.TrimSpace(req.EraseMethod) == "" && len(eraseMethods) > 0 {
			req.EraseMethod = eraseMethods[0]
		}
		if strings.TrimSpace(req.WatermarkModel) == "" && len(watermarkModels) > 0 {
			req.WatermarkModel = watermarkModels[0]
		}
	case "privacy":
		if strings.TrimSpace(req.PrivacyModel) == "" && len(privacyModels) > 0 {
			req.PrivacyModel = privacyModels[0]
		}
		if len(req.PrivacyTargets) == 0 && len(privacyTargets) > 0 {
			req.PrivacyTargets = append([]string(nil), privacyTargets...)
		}
	default:
		if strings.TrimSpace(req.SubtitleModel) == "" && len(subtitleModels) > 0 {
			req.SubtitleModel = subtitleModels[0]
		}
		if strings.ToLower(strings.TrimSpace(req.SubtitleModel)) != "mega" && strings.TrimSpace(req.EraseMethod) == "" && len(eraseMethods) > 0 {
			req.EraseMethod = eraseMethods[0]
		}
		if req.OCRExtract || req.Translate {
			if strings.TrimSpace(req.SubtitleLang) == "" && len(subtitleLangs) > 0 {
				req.SubtitleLang = subtitleLangs[0]
			}
			if strings.TrimSpace(req.SubtitleFormat) == "" && len(subtitleFormats) > 0 {
				req.SubtitleFormat = subtitleFormats[0]
			}
		}
		if req.Translate && strings.TrimSpace(req.TranslateDstLang) == "" && len(translateDstLangs) > 0 {
			req.TranslateDstLang = translateDstLangs[0]
		}
	}

	opts, err := normalizeSmartEraseOptions(requestToOptions(*req))
	if err != nil {
		return BadAuthRequest(err.Error())
	}
	spec := resolveSmartEraseSpec(&opts, "")
	if len(eraseTypes) > 0 && !slices.Contains(eraseTypes, spec.EraseType) {
		return BadAuthRequest("当前官方算力暂未开放" + spec.Prompt)
	}
	targetModel := smartEraseModelForOptions(opts)
	if availableModels, ok := stringSliceFromAny(caps["availableModels"]); ok && len(availableModels) > 0 && !slices.Contains(availableModels, targetModel) {
		return BadAuthRequest("当前官方算力暂未开放该擦除模型")
	}

	switch spec.EraseType {
	case "watermark":
		if len(eraseMethods) > 0 && !slices.Contains(eraseMethods, opts.EraseMethod) {
			return BadAuthRequest("当前官方算力暂未开放该去水印识别范围")
		}
		if len(watermarkModels) > 0 && !slices.Contains(watermarkModels, opts.WatermarkModel) {
			return BadAuthRequest("当前官方算力暂未开放该去水印模型档位")
		}
	case "privacy":
		if len(privacyModels) > 0 && !slices.Contains(privacyModels, opts.PrivacyModel) {
			return BadAuthRequest("当前官方算力暂未开放该隐私打码样式")
		}
		if len(privacyTargets) > 0 {
			for _, target := range opts.PrivacyTargets {
				if !slices.Contains(privacyTargets, target) {
					return BadAuthRequest("当前官方算力暂未开放所选隐私保护目标")
				}
			}
		}
	default:
		if len(subtitleModels) > 0 && !slices.Contains(subtitleModels, opts.SubtitleModel) {
			return BadAuthRequest("当前官方算力暂未开放该去字幕模型档位")
		}
		if len(eraseMethods) > 0 && !slices.Contains(eraseMethods, opts.EraseMethod) {
			return BadAuthRequest("当前官方算力暂未开放该去字幕识别范围")
		}
		if opts.OCRExtract {
			if len(subtitleLangs) > 0 && !slices.Contains(subtitleLangs, opts.SubtitleLang) {
				return BadAuthRequest("当前官方算力暂未开放该源字幕语种")
			}
			if len(subtitleFormats) > 0 && !slices.Contains(subtitleFormats, opts.SubtitleFormat) {
				return BadAuthRequest("当前官方算力暂未开放该字幕导出格式")
			}
		}
		if opts.Translate && len(translateDstLangs) > 0 && !slices.Contains(translateDstLangs, opts.TranslateDstLang) {
			return BadAuthRequest("当前官方算力暂未开放该目标翻译语种")
		}
	}
	return nil
}

func stringSliceFromAny(raw any) ([]string, bool) {
	switch v := raw.(type) {
	case []string:
		return v, true
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
				out = append(out, strings.TrimSpace(s))
			}
		}
		return out, true
	default:
		return nil, false
	}
}
