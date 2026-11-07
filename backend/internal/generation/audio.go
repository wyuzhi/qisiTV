package generation

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"infinite-canvas/backend/internal/beefapi"
	"net/http"
	"strings"
)

func RunAudioTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	if input.Mode == "" {
		input.Mode = "audio"
	}
	if resolved, ok := input.Metadata["resolvedCharacterVersions"].([]interface{}); ok && len(resolved) > 0 {
		voice := metadataString(input.Metadata, "resolvedCharacterVoiceKey")
		if voice == "" || strings.TrimSpace(input.Config.AudioVoice) != voice {
			return nil, RequestPreparationError{Cause: errors.New("角色配音缺少已解析的声音绑定")}
		}
	}
	if client, unified, err := useManagedMediaEnvelope(ctx, input.Config, "audio"); err != nil {
		return nil, err
	} else if unified {
		return runManagedAudioTask(ctx, client, input)
	}
	if managedConnection(input.Config) {
		return runLegacyManagedAudio(ctx, input)
	}
	if input.Config.InterfaceType == "" {
		input.Config.InterfaceType = "openai-audio"
	}
	ctx = EnsureOfficialProtocolAdapter(ctx, input.Config.InterfaceType)
	if _, ok := DeclarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType); !ok {
		return nil, RequestPreparationError{Cause: fmt.Errorf("音频协议插件未安装或已停用：%s", input.Config.InterfaceType)}
	}
	return RunDeclarativeProtocolTask(ctx, input)
}

// Frozen managed tasks retain their old speech wire; new admissions use media-v1.
func runLegacyManagedAudio(ctx context.Context, input Input) (map[string]interface{}, error) {
	body, format := beefapi.LegacySpeechPayload(beefapi.LegacySpeechOptions{Model: input.Config.Model, Prompt: input.Prompt, Voice: input.Config.AudioVoice, Format: input.Config.AudioFormat, Speed: input.Config.AudioSpeed, Instructions: input.Config.AudioInstructions})
	data, mimeType, err := managedMediaClient(ctx, input.Config).LegacySpeech(ctx, body)
	if err != nil {
		return nil, err
	}
	if strings.Contains(strings.ToLower(mimeType), "text/event-stream") {
		data, mimeType, err = readSpeechAudioEvents(ctx, data)
	}
	if err != nil {
		return nil, err
	}
	mimeType, err = ValidateGeneratedAudio(mimeType, data, format)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"mode": "audio", "audio": map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType, "format": format}}, nil
}

func isBeefAPIHostFromURL(raw string) bool {
	trimmed := strings.TrimSuffix(strings.TrimRight(raw, "/"), "/v1")
	if trimmed == beefapi.ProductionOrigin {
		return true
	}
	origin, err := beefapi.CanonicalOrigin("")
	return err == nil && trimmed == origin
}

func DecodeProviderDataURL(value string) (string, []byte, error) {
	header, encoded, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(header, "data:") || !strings.HasSuffix(strings.ToLower(header), ";base64") {
		return "", nil, errors.New("data URL 格式无效")
	}
	mimeType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
	data, err := base64.StdEncoding.DecodeString(encoded)
	return mimeType, data, err
}

func ValidateGeneratedAudio(declared string, data []byte, format string) (string, error) {
	if len(data) == 0 {
		return "", errors.New("音频内容为空")
	}
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
	if strings.Contains(detected, "json") || strings.HasPrefix(detected, "text/") || strings.HasPrefix(detected, "image/") || strings.HasPrefix(detected, "video/") {
		return "", fmt.Errorf("上游返回了非音频内容：%s", detected)
	}
	mimeType := strings.ToLower(strings.TrimSpace(strings.Split(declared, ";")[0]))
	resolved := ""
	if strings.HasPrefix(mimeType, "audio/") {
		resolved = mimeType
	} else if strings.HasPrefix(detected, "audio/") {
		resolved = detected
	} else if fallback := AudioFormatMimeType(format); fallback != "" && (mimeType == "" || mimeType == "application/octet-stream") {
		resolved = fallback
	}
	if resolved == "" {
		return "", fmt.Errorf("上游响应类型不是音频：%s", defaultString(mimeType, detected))
	}
	if !AudioSignatureMatches(resolved, data) {
		return "", fmt.Errorf("音频内容与格式不匹配：%s", resolved)
	}
	return resolved, nil
}

func AudioSignatureMatches(mimeType string, data []byte) bool {
	if strings.Contains(mimeType, "pcm") || mimeType == "audio/l16" {
		return len(data) > 0
	}
	if strings.Contains(mimeType, "mpeg") || strings.Contains(mimeType, "mp3") {
		return bytes.HasPrefix(data, []byte("ID3")) || (len(data) >= 2 && data[0] == 0xff && data[1]&0xe0 == 0xe0)
	}
	if strings.Contains(mimeType, "wav") || strings.Contains(mimeType, "wave") {
		return len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WAVE"))
	}
	if strings.Contains(mimeType, "opus") || strings.Contains(mimeType, "ogg") {
		return bytes.HasPrefix(data, []byte("OggS"))
	}
	if strings.Contains(mimeType, "flac") {
		return bytes.HasPrefix(data, []byte("fLaC"))
	}
	if strings.Contains(mimeType, "aac") {
		return bytes.HasPrefix(data, []byte("ADIF")) || (len(data) >= 2 && data[0] == 0xff && data[1]&0xf0 == 0xf0)
	}
	return false
}

func AudioFormatMimeType(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "wav":
		return "audio/wav"
	case "opus":
		return "audio/opus"
	case "aac":
		return "audio/aac"
	case "flac":
		return "audio/flac"
	case "pcm":
		return "audio/pcm"
	case "mp3":
		return "audio/mpeg"
	default:
		return ""
	}
}
