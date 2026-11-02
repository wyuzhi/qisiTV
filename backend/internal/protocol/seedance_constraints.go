package protocol

import (
	"fmt"
	"strings"
)

func isSeedanceConstraintPluginID(id string) bool {
	return id == "volcengine-ark-seedance" || id == "volcengine-ark-video" || id == "volcengine-ark-agent-plan-video" || id == "seedance-videos-compatible"
}

func hasExplicitTaskTypeConstraints(r GenerationRequest) bool {
	enabled, ok := r.Extra["taskTypeConstraints"].(bool)
	return ok && enabled
}

func applyManifestTaskOptions(manifestID string, req GenerationRequest) GenerationRequest {
	if isSeedanceConstraintPluginID(manifestID) || (req.Capability == CapabilityVideo && hasExplicitTaskTypeConstraints(req)) {
		return NormalizeSeedanceTaskOptions(req)
	}
	if req.Capability == CapabilityVideo {
		return NormalizeVideoDraftTaskOptions(req)
	}
	return req
}

func applyManifestBodyFields(manifestID string, spec *RequestSpec, req GenerationRequest) {
	body, ok := spec.Body.(map[string]any)
	if !ok {
		return
	}
	if req.Capability == CapabilityVideo || isSeedanceConstraintPluginID(manifestID) {
		ApplySeedanceBodyFields(body, req)
	} else if req.Capability == CapabilityImage {
		ApplyImageSequentialBodyFields(body, req)
	}
	if manifestID == "newapi-channel-1" && req.Capability == CapabilityVideo {
		if input, ok := body["input"].(map[string]any); ok {
			if _, exists := input["content"]; !exists {
				if prompt, ok := input["prompt"]; ok && strings.TrimSpace(fmt.Sprint(prompt)) != "" {
					input["content"] = []any{map[string]any{"type": "text", "text": fmt.Sprint(prompt)}}
				}
			}
			if content, ok := input["content"]; ok {
				if _, exists := body["content"]; !exists {
					body["content"] = content
				}
			}
		}
	}
}

func attachLastFrameMetadata(references []MediaReference, payload map[string]any) {
	if len(references) == 0 {
		return
	}
	lastFrameURL := firstPathValue(
		payload,
		"last_frame_url", "lastFrameUrl",
		"content.last_frame_url", "content.lastFrameUrl",
		"data.last_frame_url", "data.lastFrameUrl",
		"data.0.last_frame_url", "data.0.lastFrameUrl",
		"content.0.last_frame_url", "content.0.lastFrameUrl",
		"output.0.last_frame_url", "output.0.lastFrameUrl",
		"metadata.last_frame_url", "metadata.lastFrameUrl",
		"output.last_frame_url", "output.lastFrameUrl",
		"result.last_frame_url", "result.lastFrameUrl",
		"task.last_frame_url", "task.lastFrameUrl",
	)
	if lastFrameURL == "" {
		return
	}
	for index := range references {
		if references[index].Metadata == nil {
			references[index].Metadata = map[string]any{}
		}
		if _, exists := references[index].Metadata["last_frame_url"]; !exists {
			references[index].Metadata["last_frame_url"] = lastFrameURL
		}
	}
}

func wrapBuiltinCreate(info Metadata, capability Capability, create func(GenerationRequest) (RequestSpec, error)) func(GenerationRequest) (RequestSpec, error) {
	if create == nil {
		return nil
	}
	return func(r GenerationRequest) (RequestSpec, error) {
		if capability == CapabilityVideo {
			r = applyManifestTaskOptions(info.ID, r)
		}
		spec, err := create(r)
		if err == nil && capability == CapabilityVideo {
			if body, ok := spec.Body.(map[string]any); ok {
				ApplySeedanceBodyFields(body, r)
			}
		}
		return spec, err
	}
}

func isSeedance25ConstraintModel(r GenerationRequest) bool {
	if enabled, ok := r.Extra["taskTypeConstraints"].(bool); ok && enabled {
		return true
	}
	m := strings.ToLower(r.Model)
	return strings.HasSuffix(m, "seedance-2.5") || strings.Contains(m, "seedance-2.5-") || strings.HasSuffix(m, "seedance-2-5") || strings.Contains(m, "seedance-2-5-")
}

// NormalizeSeedanceTaskOptions applies only explicit task intent, never guesses
// edit/extend intent from free-form prompts. See the official Seedance 2.5 guide.
func NormalizeSeedanceTaskOptions(r GenerationRequest) GenerationRequest {
	if isSeedance25ConstraintModel(r) {
		locked := false
		for _, media := range r.Images {
			locked = locked || media.Role == "first_frame" || media.Role == "last_frame"
		}
		if len(r.Videos) > 0 {
			switch r.Operation {
			case "extend":
				locked = true
			case "inpaint", "replace_element", "style_transfer":
				locked = true
				r.Duration = -1
			}
		}
	if locked {
			r.AspectRatio = "adaptive"
		}
	}
	return NormalizeVideoDraftTaskOptions(r)
}

func NormalizeVideoDraftTaskOptions(r GenerationRequest) GenerationRequest {
	if draftTaskID, ok := r.Extra["draft_task_id"].(string); ok && strings.TrimSpace(draftTaskID) != "" {
		r.Operation = "draft_to_final"
		r.Prompt = ""
		r.Images = nil
		r.Videos = nil
		r.Audios = nil
		r.Inputs = nil
		delete(r.Extra, "draft")
		r.Output.AspectRatio, r.Output.Duration, r.Output.Resolution = r.AspectRatio, r.Duration, r.Resolution
		return r
	}
	if draft, ok := r.Extra["draft"].(bool); ok && draft {
		r.Resolution = "480p"
	}
	r.Output.AspectRatio, r.Output.Duration, r.Output.Resolution = r.AspectRatio, r.Duration, r.Resolution
	return r
}

func ApplySeedanceBodyFields(body map[string]any, r GenerationRequest) {
	if draftTaskID, ok := r.Extra["draft_task_id"].(string); ok && strings.TrimSpace(draftTaskID) != "" {
		id := strings.TrimSpace(draftTaskID)
		draftContent := []map[string]any{{"type": "draft_task", "draft_task": map[string]any{"id": id}}}
		body["content"] = draftContent
		if input, ok := body["input"].(map[string]any); ok {
			input["content"] = draftContent
			input["draft_task_id"] = id
			delete(input, "prompt")
			delete(input, "media")
		}
		if parameters, ok := body["parameters"].(map[string]any); ok {
			delete(parameters, "ratio")
			delete(parameters, "aspect_ratio")
			delete(parameters, "duration")
			delete(parameters, "generate_audio")
			delete(parameters, "draft")
			delete(parameters, "omni_reference_task_type")
		}
		for _, key := range []string{"prompt", "images", "image_urls", "videos", "video_urls", "audios", "audio_urls", "ratio", "aspect_ratio", "size", "duration", "seconds", "generate_audio", "draft", "omni_reference_task_type"} {
			delete(body, key)
		}
		return
	}
	if kind := SeedanceOmniTaskType(r); kind != "" {
		body["omni_reference_task_type"] = kind
		if parameters, ok := body["parameters"].(map[string]any); ok {
			parameters["omni_reference_task_type"] = kind
		}
	}
	if isSeedance25ConstraintModel(r) && (hasExplicitTaskTypeConstraints(r) || r.Duration == -1 || r.AspectRatio == "adaptive") {
		if r.AspectRatio == "adaptive" {
			for _, key := range []string{"ratio", "aspect_ratio", "size"} {
				if _, exists := body[key]; exists {
					body[key] = "adaptive"
				}
			}
			if parameters, ok := body["parameters"].(map[string]any); ok {
				if _, exists := parameters["ratio"]; exists {
					parameters["ratio"] = "adaptive"
				}
			}
		}
		if r.Duration == -1 {
			if _, exists := body["duration"]; exists {
				body["duration"] = -1
			}
			if _, exists := body["seconds"]; exists {
				body["seconds"] = "-1"
			}
			if parameters, ok := body["parameters"].(map[string]any); ok {
				if _, exists := parameters["duration"]; exists {
					parameters["duration"] = -1
				}
			}
		}
	}
	if draft, ok := r.Extra["draft"].(bool); ok && draft {
		body["draft"] = true
		if _, hasResolution := body["resolution"]; hasResolution {
			body["resolution"] = "480p"
		}
		if parameters, ok := body["parameters"].(map[string]any); ok {
			parameters["draft"] = true
			parameters["resolution"] = "480P"
		}
	}
	if returnLastFrame, ok := r.Extra["return_last_frame"].(bool); ok && returnLastFrame {
		body["return_last_frame"] = true
		if parameters, ok := body["parameters"].(map[string]any); ok {
			parameters["return_last_frame"] = true
		}
	}
}

func ApplyImageSequentialBodyFields(body map[string]any, r GenerationRequest) {
	if maxImages, ok := r.Extra["sequential_image_generation_max"].(int); ok && maxImages > 1 {
		if _, exists := body["sequential_image_generation"]; !exists {
			body["sequential_image_generation"] = "auto"
		}
		if _, exists := body["sequential_image_generation_options"]; !exists {
			body["sequential_image_generation_options"] = map[string]any{"max_images": maxImages}
		}
	}
}

// SeedanceOmniTaskType preserves explicit operation intent at the wire boundary.
func SeedanceOmniTaskType(r GenerationRequest) string {
	if !isSeedance25ConstraintModel(r) {
		return ""
	}
	switch r.Operation {
	case "reference_to_video":
		return "reference"
	case "extend":
		if len(r.Videos) > 0 {
			return "extend"
		}
	case "inpaint", "replace_element", "style_transfer":
		if len(r.Videos) > 0 {
			return "edit"
		}
	}
	return ""
}
