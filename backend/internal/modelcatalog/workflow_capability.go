package modelcatalog

import (
	"math"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/protocol"
)

// WorkflowLookup resolves a protocol plugin's workflow declaration for a given provider, capability, and model ID.
type WorkflowLookup func(providerID string, capability protocol.Capability, modelID string) (protocol.ManifestWorkflow, bool)

func applyProtocolWorkflowVideoCapability(video *VideoCapabilityConfig, workflow protocol.ManifestWorkflow) {
	if video == nil {
		return
	}
	findParam := func(names ...string) *protocol.Parameter {
		for _, target := range names {
			for index := range workflow.Parameters {
				param := &workflow.Parameters[index]
				mapped := strings.TrimSpace(param.Mapping)
				if mapped == "" {
					mapped = strings.TrimSpace(param.Name)
				}
				if strings.EqualFold(mapped, target) || strings.EqualFold(strings.TrimSpace(param.Name), target) {
					return param
				}
			}
		}
		return nil
	}
	ratioParam := findParam("aspectRatio", "ratio", "size")
	resolutionParam := findParam("resolution")
	durationParam := findParam("duration")

	var ratios []string
	if ratioParam != nil {
		ratios = normalizeWorkflowStrings(ratioParam.Values)
	}
	var resolutions []string
	if resolutionParam != nil {
		resolutions = normalizeWorkflowStrings(resolutionParam.Values)
	}

	if len(ratios) > 0 {
		video.Ratios = ratios
		defRatio := workflowDefaultString(workflow.Defaults, ratioParam.Name, "aspectRatio", "ratio")
		if matched := matchWorkflowString(video.Ratios, defRatio); matched != "" {
			video.DefaultRatio = matched
		} else {
			video.DefaultRatio = video.Ratios[0]
		}
	} else if len(resolutions) > 0 {
		video.Ratios = []string{}
		video.DefaultRatio = ""
	}

	if len(resolutions) > 0 {
		video.Resolutions = resolutions
		defRes := workflowDefaultString(workflow.Defaults, resolutionParam.Name, "resolution")
		if matched := matchWorkflowString(video.Resolutions, defRes); matched != "" {
			video.DefaultResolution = matched
		} else {
			video.DefaultResolution = video.Resolutions[0]
		}
	}

	if durationParam != nil {
		defDuration, hasDefDuration := workflowDefaultInt(workflow.Defaults, durationParam.Name, "duration")
		if len(durationParam.Values) > 0 {
			values := make([]int, 0, len(durationParam.Values))
			for _, raw := range durationParam.Values {
				trimmed := strings.TrimSpace(raw)
				if !strings.HasPrefix(trimmed, "+") {
					if parsed, err := strconv.Atoi(trimmed); err == nil && parsed > 0 && !containsInt(values, parsed) {
						values = append(values, parsed)
					}
				}
			}
			if len(values) > 0 {
				chosen := values[0]
				if hasDefDuration && containsInt(values, defDuration) {
					chosen = defDuration
				}
				video.Duration = VideoDurationConfig{Selection: "enum", Values: values, Default: chosen}
			}
		} else if durationParam.Min != nil && durationParam.Max != nil && *durationParam.Min >= 1 && *durationParam.Max >= *durationParam.Min {
			minSeconds := *durationParam.Min
			maxSeconds := *durationParam.Max
			chosen := min(maxSeconds, max(minSeconds, video.Duration.Default))
			if hasDefDuration && defDuration >= minSeconds && defDuration <= maxSeconds {
				chosen = defDuration
			}
			video.Duration = VideoDurationConfig{Selection: "range", Min: minSeconds, Max: maxSeconds, Step: 1, Default: chosen}
		} else if hasDefDuration && defDuration > 0 {
			video.Duration = VideoDurationConfig{Selection: "enum", Values: []int{defDuration}, Default: defDuration}
		}
	}

	imagesParam := findParam("images", "image")
	videosParam := findParam("videos", "video")
	audiosParam := findParam("audios", "audio")
	if imagesParam != nil || videosParam != nil || audiosParam != nil {
		mediaBounds := func(param *protocol.Parameter, defaultMax int) (int, int) {
			if param == nil {
				return 0, 0
			}
			maxCount := defaultMax
			if strings.TrimSpace(strings.ToLower(param.Type)) != "array" {
				maxCount = 1
			}
			if param.Max != nil && *param.Max >= 0 {
				maxCount = *param.Max
			}
			minCount := 0
			if param.Min != nil && *param.Min > 0 {
				minCount = *param.Min
			} else if param.Required && maxCount > 0 {
				minCount = 1
			}
			if minCount > maxCount {
				minCount = maxCount
			}
			return minCount, maxCount
		}
		imgMin, imgMax := mediaBounds(imagesParam, 9)
		_, vidMax := mediaBounds(videosParam, 3)
		_, audMax := mediaBounds(audiosParam, 3)
		video.References.MinImages = imgMin
		video.References.MaxImages = imgMax
		if videosParam != nil {
			video.References.MaxVideos = vidMax
			if vidMax > 0 && video.References.MaxVideoBytes == 0 {
				video.References.MaxVideoBytes = 200 * 1024 * 1024
				video.References.MaxVideoDuration = 15
			}
		}
		if audiosParam != nil {
			video.References.MaxAudios = audMax
			if audMax > 0 && video.References.MaxAudioBytes == 0 {
				video.References.MaxAudioBytes = 15 * 1024 * 1024
				video.References.MaxAudioDuration = 15
			}
		}
		promptParam := findParam("prompt")
		ops := make([]string, 0, 3)
		allowsTextToVideo := imgMin == 0 &&
			(videosParam == nil || !videosParam.Required) &&
			(audiosParam == nil || !audiosParam.Required) &&
			(promptParam != nil || (imgMax == 0 && vidMax == 0 && audMax == 0))
		if allowsTextToVideo {
			ops = append(ops, "text_to_video")
		}
		if imgMax > 0 {
			ops = append(ops, "image_to_video")
		}
		if imgMax > 1 || vidMax > 0 || audMax > 0 {
			ops = append(ops, "reference_to_video")
		}
		if len(ops) == 0 {
			ops = []string{"text_to_video"}
		}
		video.Operations = ops
		if !containsCapabilityString(video.Operations, video.DefaultOperation) {
			video.DefaultOperation = video.Operations[0]
		}
	}
}

func normalizeWorkflowStrings(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" && !containsCapabilityString(result, trimmed) {
			result = append(result, trimmed)
		}
	}
	return result
}

func matchWorkflowString(options []string, target string) string {
	trimmed := strings.TrimSpace(target)
	if trimmed == "" {
		return ""
	}
	for _, option := range options {
		if strings.EqualFold(strings.TrimSpace(option), trimmed) {
			return option
		}
	}
	return ""
}

func workflowDefaultString(defaults map[string]any, keys ...string) string {
	for _, key := range keys {
		trimmedKey := strings.TrimSpace(key)
		if trimmedKey == "" || defaults == nil {
			continue
		}
		var text string
		switch typed := defaults[trimmedKey].(type) {
		case string:
			text = typed
		case int:
			text = strconv.Itoa(typed)
		case int64:
			text = strconv.FormatInt(typed, 10)
		case float64:
			if !math.IsNaN(typed) && !math.IsInf(typed, 0) {
				text = strconv.FormatFloat(typed, 'f', -1, 64)
			}
		case bool:
			text = strconv.FormatBool(typed)
		}
		if trimmed := strings.TrimSpace(text); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func workflowDefaultInt(defaults map[string]any, keys ...string) (int, bool) {
	for _, key := range keys {
		trimmedKey := strings.TrimSpace(key)
		if trimmedKey == "" || defaults == nil {
			continue
		}
		switch typed := defaults[trimmedKey].(type) {
		case int:
			return typed, true
		case int64:
			return int(typed), true
		case float64:
			if !math.IsNaN(typed) && !math.IsInf(typed, 0) && math.Trunc(typed) == typed {
				return int(typed), true
			}
		case string:
			trimmed := strings.TrimSpace(typed)
			if !strings.HasPrefix(trimmed, "+") {
				if parsed, err := strconv.Atoi(trimmed); err == nil {
					return parsed, true
				}
			}
		}
	}
	return 0, false
}
