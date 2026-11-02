package beefapi

import (
	"strconv"
	"strings"
)

// LegacySpeechOptions is only for frozen tasks admitted before media-v1.
type LegacySpeechOptions struct {
	Model, Prompt, Voice, Format, Speed, Instructions string
}

func LegacySpeechPayload(options LegacySpeechOptions) (map[string]any, string) {
	format := options.Format
	if format == "" {
		format = "mp3"
	}
	music := strings.Contains(strings.ToLower(options.Model), "minimax-music-")
	if music {
		format = "mp3"
	}
	voice := strings.TrimSpace(options.Voice)
	id := strings.ToLower(options.Model)
	if strings.Contains(id, "minimax-music") {
		voice = ""
	} else if strings.Contains(id, "minimax-speech") {
		switch strings.ToLower(voice) {
		case "", "中文", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar":
			voice = "male-qn-qingse"
		}
	} else if voice == "" {
		voice = "alloy"
	}
	speed, err := strconv.ParseFloat(strings.TrimSpace(options.Speed), 64)
	if err != nil || speed == 0 {
		speed = 1
	}
	body := map[string]any{"model": options.Model, "input": options.Prompt, "response_format": format, "speed": speed}
	if voice != "" {
		body["voice"] = voice
	}
	if options.Instructions != "" {
		body["instructions"] = options.Instructions
	}
	if music {
		body["metadata"] = map[string]any{"audio_setting": map[string]any{"sample_rate": 44100, "bitrate": 256000, "format": "mp3"}}
	}
	return body, format
}
