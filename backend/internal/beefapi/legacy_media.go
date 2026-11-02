package beefapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// Existing video/upscale/audio endpoints remain available until their generic
// media execution is advertised. All BeefAPI wire calls still share this adapter.
func (c *MediaClient) LegacyJSON(ctx context.Context, method, path string, body, target any) error {
	req, err := c.request(ctx, method, path, body)
	if err != nil {
		return err
	}
	req.Header.Del(MediaProtocolHeader)
	if method == http.MethodGet && (strings.HasPrefix(path, "/videos/") || strings.HasPrefix(path, "/video/generations/")) {
		req.Header.Set("X-Beeftv-Video-Delivery", "direct")
	}
	data, _, err := c.send(req, 4<<20)
	if len(data) > 0 && target != nil {
		if decodeErr := json.Unmarshal(data, target); decodeErr != nil && err == nil {
			return decodeErr
		}
	}
	return err
}
func (c *MediaClient) LegacyBinary(ctx context.Context, method, path string, body any, limit int64) ([]byte, string, error) {
	req, err := c.request(ctx, method, path, body)
	if err != nil {
		return nil, "", err
	}
	req.Header.Del(MediaProtocolHeader)
	data, header, err := c.send(req, limit)
	return data, header.Get("Content-Type"), err
}
func (c *MediaClient) LegacyCreate(ctx context.Context, path, key string, body, target any) error {
	if key == "" {
		return errors.New("媒体任务缺少持久化提交编号")
	}
	req, err := c.request(ctx, http.MethodPost, path, body)
	if err != nil {
		return err
	}
	req.Header.Del(MediaProtocolHeader)
	req.Header.Set("Idempotency-Key", key)
	data, _, err := c.send(req, 4<<20)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}
func (c *MediaClient) LegacyImageJob(ctx context.Context, id string) (map[string]any, error) {
	if strings.TrimSpace(id) == "" {
		return nil, errors.New("图片任务编号为空")
	}
	var state map[string]any
	err := c.LegacyJSON(ctx, http.MethodGet, "/images/jobs/"+url.PathEscape(id), nil, &state)
	return state, err
}

func (c *MediaClient) LegacySpeech(ctx context.Context, body map[string]any) ([]byte, string, error) {
	// This is the established legacy music wire. Other speech stays OpenAI.
	copy := make(map[string]any, len(body)+1)
	for key, value := range body {
		copy[key] = value
	}
	model, _ := copy["model"].(string)
	if strings.Contains(strings.ToLower(model), "minimax-music-") {
		copy["stream_format"] = "sse"
	}
	return c.LegacyBinary(ctx, http.MethodPost, "/audio/speech", copy, 64<<20)
}
