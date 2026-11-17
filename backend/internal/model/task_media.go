package model

import (
	"encoding/json"
	"strings"
)

// The operation and frozen input identify an upscale, independently of the
// supplier's model name. Older local records can lack the operation field.
func (task Task) IsUpscale() bool {
	if strings.HasPrefix(task.Operation, "media.upscale.") {
		return true
	}
	if !strings.Contains(task.InputJSON, `"upscale"`) {
		return false
	}
	var input struct {
		Upscale json.RawMessage `json:"upscale"`
	}
	return json.Unmarshal([]byte(task.InputJSON), &input) == nil && len(input.Upscale) > 0 && input.Upscale[0] == '{'
}

func (task Task) IsSubtitleErase() bool {
	if task.Operation == "media.video.subtitle_erase" {
		return true
	}
	if !strings.Contains(task.InputJSON, `"subtitleErase"`) {
		return false
	}
	var input struct {
		SubtitleErase json.RawMessage `json:"subtitleErase"`
	}
	return json.Unmarshal([]byte(task.InputJSON), &input) == nil && len(input.SubtitleErase) > 0 && input.SubtitleErase[0] == '{'
}
