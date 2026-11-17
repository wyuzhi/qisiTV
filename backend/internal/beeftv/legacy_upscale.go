package beeftv

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
)

type LegacyUpscaleInput struct {
	Model, MediaType, SourceURL, OutputFormat string
	Factor                                    int
	Width, Height                             int
	DurationSeconds, FrameRate                float64
	EstimateOnly                              bool
}
type UpscaleEstimate struct {
	Model               string  `json:"model"`
	Currency            string  `json:"currency"`
	Reservation         float64 `json:"reservation"`
	BillingMode         string  `json:"billing_mode,omitempty"`
	GenerationSubmitted bool    `json:"generation_submitted"`
}
type UpstreamUpscaleModelCapability struct {
	ID             string `json:"id"`
	Label          string `json:"label"`
	MediaType      string `json:"media_type"`
	Mode           string `json:"mode"`
	BillingMode    string `json:"billing_mode,omitempty"`
	BillingSummary string `json:"billing_summary,omitempty"`
}
type UpstreamUpscaleCapabilities struct {
	SupportedModels []UpstreamUpscaleModelCapability `json:"supported_models"`
	MaxVideoSeconds int                              `json:"max_video_seconds"`
	Billing         json.RawMessage                  `json:"billing,omitempty"`
}
type LegacyUpscaleTask struct {
	TaskID        string  `json:"task_id"`
	Model         string  `json:"model"`
	Status        string  `json:"status"`
	MediaType     string  `json:"media_type"`
	BillingStatus *string `json:"billing_status,omitempty"`
}

func LegacyUpscaleBody(input LegacyUpscaleInput) map[string]any {
	body := map[string]any{"model": input.Model, "upscale_factor": input.Factor}
	if input.MediaType == "image" {
		format := input.OutputFormat
		if format == "" {
			format = "png"
		}
		if input.SourceURL != "" {
			body["image_url"] = input.SourceURL
		}
		body["output_format"], body["face_enhancement"] = format, false
	} else {
		if input.SourceURL != "" {
			body["video_url"] = input.SourceURL
		}
		body["H264_output"] = true
		if input.EstimateOnly {
			if input.Width > 0 && input.Height > 0 {
				body["width"], body["height"] = input.Width, input.Height
			}
			if input.DurationSeconds > 0 {
				body["duration_seconds"] = input.DurationSeconds
			}
			if input.FrameRate > 0 {
				body["frame_rate"] = input.FrameRate
			}
		}
	}
	return body
}

func (c *MediaClient) GetUpscaleCapabilities(ctx context.Context) (UpstreamUpscaleCapabilities, error) {
	var caps UpstreamUpscaleCapabilities
	err := c.LegacyJSON(ctx, http.MethodGet, "/media-upscale/capabilities", nil, &caps)
	return caps, err
}

var legacyUpscaleTaskID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func LegacyUpscaleTaskPath(id string) (string, error) {
	if !legacyUpscaleTaskID.MatchString(id) {
		return "", errors.New("超分任务 ID 无效")
	}
	return "/media-upscale/tasks/" + url.PathEscape(id), nil
}

func (c *MediaClient) EstimateLegacyUpscale(ctx context.Context, input LegacyUpscaleInput) (UpscaleEstimate, error) {
	var estimate UpscaleEstimate
	err := c.LegacyJSON(ctx, http.MethodPost, "/media-upscale/estimate", LegacyUpscaleBody(input), &estimate)
	if err == nil && (estimate.Model != input.Model || estimate.Currency != "CNY" || estimate.Reservation <= 0 || estimate.GenerationSubmitted) {
		err = errors.New("超分预估费用无效，请重新获取")
	}
	return estimate, err
}
func (c *MediaClient) CreateLegacyUpscale(ctx context.Context, key string, input LegacyUpscaleInput) (string, error) {
	var task LegacyUpscaleTask
	if err := c.LegacyCreate(ctx, "/media-upscale/tasks", key, LegacyUpscaleBody(input), &task); err != nil {
		return "", err
	}
	if _, err := LegacyUpscaleTaskPath(task.TaskID); err != nil {
		return "", err
	}
	return task.TaskID, nil
}
func (c *MediaClient) QueryLegacyUpscale(ctx context.Context, id, model, mediaType string) (LegacyUpscaleTask, error) {
	var task LegacyUpscaleTask
	path, err := LegacyUpscaleTaskPath(id)
	if err != nil {
		return task, err
	}
	if err = c.LegacyJSON(ctx, http.MethodGet, path, nil, &task); err != nil {
		return task, err
	}
	if task.TaskID != id || task.Model != model || (task.MediaType != "image" && task.MediaType != "video") || (mediaType != "" && task.MediaType != mediaType) {
		return task, errors.New("超分回执与原任务不一致")
	}
	return task, nil
}

// LegacyUpscaleContent downloads a finished upscale. The API answers with a
// redirect to the already-saved file in object storage; only this GET follows
// it, through the storage client. JSON and POST calls still refuse redirects.
func (c *MediaClient) LegacyUpscaleContent(ctx context.Context, id string, limit int64) ([]byte, string, error) {
	path, err := LegacyUpscaleTaskPath(id)
	if err != nil {
		return nil, "", err
	}
	req, err := c.request(ctx, http.MethodGet, path+"/content", nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Del(MediaProtocolHeader)
	data, header, err := c.sendWith(c.storageClient("超分结果重定向次数过多"), req, limit)
	return data, header.Get("Content-Type"), err
}
func (c *MediaClient) CancelLegacyUpscale(ctx context.Context, id string) error {
	path, err := LegacyUpscaleTaskPath(id)
	if err != nil {
		return err
	}
	var response struct {
		TaskID    string `json:"task_id"`
		Requested bool   `json:"cancellation_requested"`
	}
	if err := c.LegacyJSON(ctx, http.MethodPost, path+"/cancel", map[string]any{}, &response); err != nil {
		return err
	}
	if response.TaskID != id || !response.Requested {
		return errors.New("超分取消请求尚未确认")
	}
	return nil
}
