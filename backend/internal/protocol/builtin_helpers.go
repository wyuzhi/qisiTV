package protocol

import (
	"encoding/json"
	"fmt"
	"strings"
)

func object(value any) map[string]any { result, _ := value.(map[string]any); return result }
func mergeMaps(primary, fallback map[string]any) map[string]any {
	result := make(map[string]any, len(fallback)+len(primary))
	for k, v := range fallback {
		result[k] = v
	}
	for k, v := range primary {
		result[k] = v
	}
	return result
}
func firstString(payload map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := payload[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
func defaultValue(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
func defaultInt(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	return value
}
func copyIf(body map[string]any, key, value string) {
	if strings.TrimSpace(value) != "" {
		body[key] = value
	}
}
func mergeExtra(body map[string]any, extra map[string]any, keys ...string) {
	for _, key := range keys {
		if value, ok := extra[key]; ok {
			body[key] = value
		}
	}
}
func compactMap(body map[string]any) map[string]any {
	result := make(map[string]any)
	for key, value := range body {
		switch item := value.(type) {
		case string:
			if strings.TrimSpace(item) != "" {
				result[key] = value
			}
		case int:
			if item > 0 {
				result[key] = value
			}
		case bool:
			result[key] = value
		case nil:
		default:
			result[key] = item
		}
	}
	return result
}
func mediaValue(media MediaReference) string { return defaultValue(media.URL, media.DataURL) }
func mediaRole(media MediaReference, fallback string) string {
	return defaultValue(strings.TrimSpace(media.Role), fallback)
}

func splitVideoImages(images []MediaReference) (frames []MediaReference, references []MediaReference, unspecified []MediaReference) {
	firstFrames := make([]MediaReference, 0, 1)
	lastFrames := make([]MediaReference, 0, 1)
	for _, image := range images {
		switch strings.TrimSpace(image.Role) {
		case "first_frame":
			firstFrames = append(firstFrames, image)
		case "last_frame":
			lastFrames = append(lastFrames, image)
		case "reference_image":
			references = append(references, image)
		default:
			unspecified = append(unspecified, image)
		}
	}
	frames = append(frames, firstFrames...)
	frames = append(frames, lastFrames...)
	return frames, references, unspecified
}

func orderedFrameImages(images []MediaReference) []MediaReference {
	frames, _, unspecified := splitVideoImages(images)
	if len(frames) == 0 {
		return unspecified
	}
	return append(frames, unspecified...)
}

func hasVideoImageRole(images []MediaReference, role string) bool {
	for _, image := range images {
		if strings.TrimSpace(image.Role) == role {
			return true
		}
	}
	return false
}

func mediaValues(values []MediaReference) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if item := mediaValue(value); item != "" {
			result = append(result, item)
		}
	}
	return result
}
func mediaFromArray(value any, capability Capability) []MediaReference {
	values, _ := value.([]any)
	result := make([]MediaReference, 0, len(values))
	kind := string(capability)
	for _, item := range values {
		if value, ok := item.(string); ok && strings.TrimSpace(value) != "" {
			result = append(result, MediaReference{URL: strings.TrimSpace(value), Kind: kind})
			continue
		}
		if m, ok := item.(map[string]any); ok {
			if capability == CapabilityImage {
				if value := firstString(m, "b64_json", "data"); value != "" {
					if !strings.HasPrefix(value, "data:") {
						value = "data:image/png;base64," + value
					}
					result = append(result, MediaReference{DataURL: value, Kind: kind})
					continue
				}
			}
			if value := firstString(m, "url", "image_url", "video_url", "audio_url"); value != "" {
				result = append(result, MediaReference{URL: value, Kind: kind})
			}
		}
	}
	return result
}
func dataMIME(value string) string {
	if index := strings.Index(value, ";"); strings.HasPrefix(value, "data:") && index > 5 {
		return strings.TrimPrefix(value[5:index], "")
	}
	return "application/octet-stream"
}
func dataPayload(value string) string {
	if index := strings.Index(value, ","); strings.HasPrefix(value, "data:") && index >= 0 {
		return value[index+1:]
	}
	return value
}

func geminiVeoVideos(response map[string]any) []MediaReference {
	if response == nil {
		return nil
	}
	containers := []map[string]any{response}
	for _, key := range []string{"generateVideoResponse", "generate_video_response"} {
		if nested := object(response[key]); nested != nil {
			containers = append(containers, nested)
		}
	}
	result := make([]MediaReference, 0)
	for _, container := range containers {
		for _, key := range []string{"generatedVideos", "generated_videos", "generatedSamples", "generated_samples", "videos"} {
			items, _ := container[key].([]any)
			for _, item := range items {
				entry := object(item)
				video := object(entry["video"])
				if video == nil {
					video = entry
				}
				if value := firstString(video, "uri", "url", "videoUri", "video_url"); value != "" {
					result = append(result, MediaReference{URL: value, Kind: string(CapabilityVideo)})
				}
			}
		}
	}
	return result
}

func normalizeStatus(raw string) Status {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "queued", "pending", "created", "submitted", "in_queue", "task_status_queued", "preparing":
		return StatusPending
	case "running", "processing", "in_progress", "executing", "task_status_running":
		return StatusProcessing
	case "succeeded", "success", "completed", "complete", "done", "task_status_succeed":
		return StatusSucceeded
	case "cancelled", "canceled", "aborted":
		return StatusCancelled
	case "failed", "fail", "failure", "error", "expired", "task_status_fail":
		return StatusFailed
	default:
		return ""
	}
}

func decodeObject(body []byte) (map[string]any, error) {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("protocol response is not JSON: %w", err)
	}
	return payload, nil
}
