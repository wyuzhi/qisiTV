package beeftv

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
)

type SubtitleEraseRegion struct {
	X      *float64 `json:"x,omitempty"`
	Y      *float64 `json:"y,omitempty"`
	Width  *float64 `json:"width,omitempty"`
	Height *float64 `json:"height,omitempty"`
}

type SubtitleEraseCapabilities struct {
	Enabled         *bool           `json:"enabled,omitempty"`
	Available       *bool           `json:"available,omitempty"`
	Model           string          `json:"model"`
	EraseMethods    []string        `json:"erase_methods"`
	SubtitleModels  []string        `json:"subtitle_models"`
	MaxVideoSeconds int             `json:"max_video_seconds"`
	BillingMode     string          `json:"billing_mode,omitempty"`
	BillingSummary  string          `json:"billing_summary,omitempty"`
	Billing         json.RawMessage `json:"billing,omitempty"`
}

type SubtitleEraseInput struct {
	Model           string
	SourceURL       string
	EraseMethod     string
	SubtitleModel   string
	Region          *SubtitleEraseRegion
	Width           int
	Height          int
	DurationSeconds float64
	EstimateOnly    bool
}

type SubtitleEraseEstimate struct {
	Model               string  `json:"model"`
	Currency            string  `json:"currency"`
	Reservation         float64 `json:"reservation"`
	Tier                string  `json:"tier,omitempty"`
	ResolutionTier      string  `json:"resolution_tier,omitempty"`
	BilledSeconds       int     `json:"billed_seconds,omitempty"`
	RatePerMinuteCNY    float64 `json:"rate_per_minute_cny,omitempty"`
	RateCNYPerMinute    float64 `json:"rate_cny_per_minute,omitempty"`
	BillingMode         string  `json:"billing_mode,omitempty"`
	BillingSummary      string  `json:"billing_summary,omitempty"`
	GenerationSubmitted bool    `json:"generation_submitted"`
}

type SubtitleEraseTask struct {
	TaskID        string          `json:"task_id"`
	Model         string          `json:"model"`
	Status        string          `json:"status"`
	MediaType     string          `json:"media_type"`
	BillingStatus *string         `json:"billing_status,omitempty"`
	Error         *MediaTaskError `json:"error,omitempty"`
}

func SubtitleEraseBody(input SubtitleEraseInput) map[string]any {
	method := input.EraseMethod
	if method == "" {
		method = "auto"
	}
	subModel := input.SubtitleModel
	if subModel == "" {
		subModel = "standard"
	}
	body := map[string]any{
		"erase_method":   method,
		"subtitle_model": subModel,
	}
	if input.Model != "" {
		body["model"] = input.Model
	}
	if input.SourceURL != "" {
		body["video_url"] = input.SourceURL
	}
	if input.Region != nil {
		body["region"] = input.Region
	}
	if input.EstimateOnly {
		if input.Width > 0 && input.Height > 0 {
			body["width"], body["height"] = input.Width, input.Height
		}
		if input.DurationSeconds > 0 {
			body["duration_seconds"] = input.DurationSeconds
		}
	}
	return body
}

func SubtitleEraseTaskPath(id string) (string, error) {
	if !legacyUpscaleTaskID.MatchString(id) {
		return "", errors.New("去字幕任务 ID 无效")
	}
	return "/video-subtitle-erase/tasks/" + url.PathEscape(id), nil
}

func (c *MediaClient) GetSubtitleEraseCapabilities(ctx context.Context) (SubtitleEraseCapabilities, error) {
	var caps SubtitleEraseCapabilities
	err := c.LegacyJSON(ctx, http.MethodGet, "/video-subtitle-erase/capabilities", nil, &caps)
	return caps, err
}

func (c *MediaClient) EstimateSubtitleErase(ctx context.Context, input SubtitleEraseInput) (SubtitleEraseEstimate, error) {
	var estimate SubtitleEraseEstimate
	input.EstimateOnly = true
	err := c.LegacyJSON(ctx, http.MethodPost, "/video-subtitle-erase/estimate", SubtitleEraseBody(input), &estimate)
	if err == nil && (estimate.Currency != "CNY" || estimate.Reservation <= 0 || estimate.GenerationSubmitted) {
		err = errors.New("去字幕预估费用无效，请重新获取")
	}
	return estimate, err
}

func (c *MediaClient) CreateSubtitleErase(ctx context.Context, key string, input SubtitleEraseInput) (string, error) {
	var task SubtitleEraseTask
	if err := c.LegacyCreate(ctx, "/video-subtitle-erase/tasks", key, SubtitleEraseBody(input), &task); err != nil {
		return "", err
	}
	if _, err := SubtitleEraseTaskPath(task.TaskID); err != nil {
		return "", err
	}
	return task.TaskID, nil
}

func (c *MediaClient) QuerySubtitleErase(ctx context.Context, id, model string) (SubtitleEraseTask, error) {
	var task SubtitleEraseTask
	path, err := SubtitleEraseTaskPath(id)
	if err != nil {
		return task, err
	}
	if err = c.LegacyJSON(ctx, http.MethodGet, path, nil, &task); err != nil {
		return task, err
	}
	if task.TaskID != id || (model != "" && task.Model != "" && task.Model != model) || (task.MediaType != "" && task.MediaType != "video") {
		return task, errors.New("去字幕回执与原任务不一致")
	}
	return task, nil
}

func (c *MediaClient) SubtitleEraseContent(ctx context.Context, id string, limit int64) ([]byte, string, error) {
	path, err := SubtitleEraseTaskPath(id)
	if err != nil {
		return nil, "", err
	}
	req, err := c.request(ctx, http.MethodGet, path+"/content", nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Del(MediaProtocolHeader)
	data, header, err := c.sendWith(c.storageClient("去字幕结果重定向次数过多"), req, limit)
	return data, header.Get("Content-Type"), err
}

func (c *MediaClient) CancelSubtitleErase(ctx context.Context, id string) error {
	path, err := SubtitleEraseTaskPath(id)
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
		return errors.New("去字幕取消请求尚未确认")
	}
	return nil
}
