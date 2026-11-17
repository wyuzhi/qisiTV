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

type SmartEraseCapabilityMatrix struct {
	AvailableModels   []string        `json:"available_models,omitempty"`
	EraseTypes        []string        `json:"erase_types,omitempty"`
	EraseMethods      []string        `json:"erase_methods,omitempty"`
	SubtitleModels    []string        `json:"subtitle_models,omitempty"`
	WatermarkModels   []string        `json:"watermark_models,omitempty"`
	PrivacyModels     []string        `json:"privacy_models,omitempty"`
	PrivacyTargets    []string        `json:"privacy_targets,omitempty"`
	SubtitleLangs     []string        `json:"subtitle_langs,omitempty"`
	SubtitleFormats   []string        `json:"subtitle_formats,omitempty"`
	TranslateDstLangs []string        `json:"translate_dst_langs,omitempty"`
	RatesCNYPerMinute json.RawMessage `json:"rates_cny_per_minute,omitempty"`
}

type SubtitleEraseCapabilities struct {
	Enabled           *bool                       `json:"enabled,omitempty"`
	Available         *bool                       `json:"available,omitempty"`
	Model             string                      `json:"model"`
	DefaultModel      string                      `json:"default_model,omitempty"`
	AvailableModels   []string                    `json:"available_models,omitempty"`
	EraseTypes        []string                    `json:"erase_types,omitempty"`
	EraseMethods      []string                    `json:"erase_methods"`
	SubtitleModels    []string                    `json:"subtitle_models"`
	WatermarkModels   []string                    `json:"watermark_models,omitempty"`
	PrivacyModels     []string                    `json:"privacy_models,omitempty"`
	PrivacyTargets    []string                    `json:"privacy_targets,omitempty"`
	SubtitleLangs     []string                    `json:"subtitle_langs,omitempty"`
	SubtitleFormats   []string                    `json:"subtitle_formats,omitempty"`
	TranslateDstLangs []string                    `json:"translate_dst_langs,omitempty"`
	RatesCNYPerMinute json.RawMessage             `json:"rates_cny_per_minute,omitempty"`
	MaxVideoSeconds   int                         `json:"max_video_seconds"`
	BillingMode       string                      `json:"billing_mode,omitempty"`
	BillingSummary    string                      `json:"billing_summary,omitempty"`
	Billing           json.RawMessage             `json:"billing,omitempty"`
	SmartErase        *SmartEraseCapabilityMatrix `json:"smart_erase,omitempty"`
}

func (c SubtitleEraseCapabilities) ResolvedMatrix() *SmartEraseCapabilityMatrix {
	if c.SmartErase != nil {
		return c.SmartErase
	}
	if len(c.AvailableModels) == 0 && len(c.EraseTypes) == 0 && len(c.EraseMethods) == 0 &&
		len(c.SubtitleModels) == 0 && len(c.WatermarkModels) == 0 && len(c.PrivacyModels) == 0 &&
		len(c.PrivacyTargets) == 0 && len(c.SubtitleLangs) == 0 && len(c.SubtitleFormats) == 0 &&
		len(c.TranslateDstLangs) == 0 {
		return nil
	}
	return &SmartEraseCapabilityMatrix{
		AvailableModels:   c.AvailableModels,
		EraseTypes:        c.EraseTypes,
		EraseMethods:      c.EraseMethods,
		SubtitleModels:    c.SubtitleModels,
		WatermarkModels:   c.WatermarkModels,
		PrivacyModels:     c.PrivacyModels,
		PrivacyTargets:    c.PrivacyTargets,
		SubtitleLangs:     c.SubtitleLangs,
		SubtitleFormats:   c.SubtitleFormats,
		TranslateDstLangs: c.TranslateDstLangs,
		RatesCNYPerMinute: c.RatesCNYPerMinute,
	}
}

type SubtitleEraseInput struct {
	Model            string
	SourceURL        string
	EraseType        string
	EraseMethod      string
	SubtitleModel    string
	WatermarkModel   string
	PrivacyModel     string
	PrivacyTargets   []string
	Region           *SubtitleEraseRegion
	OCRExtract       bool
	SubtitleLang     string
	SubtitleFormat   string
	Translate        bool
	TranslateDstLang string
	SubtitleEmbedID  *int64
	UseOriginalPos   *bool
	UseOriginalSize  *bool
	Width            int
	Height           int
	DurationSeconds  float64
	EstimateOnly     bool
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

type SubtitleEraseSubtitles struct {
	TaskID         string `json:"task_id"`
	Format         string `json:"format"`
	OriginText     string `json:"origin_text,omitempty"`
	TranslatedText string `json:"translated_text,omitempty"`
	TargetLang     string `json:"target_lang,omitempty"`
}

func SubtitleEraseBody(input SubtitleEraseInput) map[string]any {
	body := map[string]any{}
	switch input.EraseType {
	case "watermark":
		method := input.EraseMethod
		if method == "" {
			method = "auto"
		}
		wmModel := input.WatermarkModel
		if wmModel == "" {
			wmModel = "advanced"
		}
		body["erase_type"] = "watermark"
		body["erase_method"] = method
		body["watermark_model"] = wmModel
		if input.Region != nil {
			body["region"] = input.Region
		}
	case "privacy":
		privModel := input.PrivacyModel
		if privModel == "" {
			privModel = "blur"
		}
		body["erase_type"] = "privacy"
		body["privacy_model"] = privModel
		if len(input.PrivacyTargets) > 0 {
			body["privacy_targets"] = input.PrivacyTargets
		}
	default:
		method := input.EraseMethod
		if method == "" {
			method = "auto"
		}
		subModel := input.SubtitleModel
		if subModel == "" {
			subModel = "standard"
		}
		if input.EraseType == "subtitle" {
			body["erase_type"] = "subtitle"
		}
		if subModel == "mega" {
			body["erase_method"] = "auto"
			body["subtitle_model"] = "mega"
		} else {
			body["erase_method"] = method
			body["subtitle_model"] = subModel
			if input.Region != nil {
				body["region"] = input.Region
			}
			if input.OCRExtract || input.Translate {
				body["ocr_extract"] = true
				if input.SubtitleLang != "" {
					body["subtitle_lang"] = input.SubtitleLang
				}
				if input.SubtitleFormat != "" {
					body["subtitle_format"] = input.SubtitleFormat
				}
			}
			if input.Translate {
				body["translate"] = true
				if input.TranslateDstLang != "" {
					body["translate_dst_lang"] = input.TranslateDstLang
				}
				if input.SubtitleEmbedID != nil {
					body["subtitle_embed_id"] = *input.SubtitleEmbedID
				}
				if input.UseOriginalPos != nil {
					body["use_original_pos"] = *input.UseOriginalPos
				}
				if input.UseOriginalSize != nil {
					body["use_original_size"] = *input.UseOriginalSize
				}
			}
		}
	}
	if input.Model != "" {
		body["model"] = input.Model
	}
	if input.SourceURL != "" {
		body["video_url"] = input.SourceURL
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
	var smartCaps SubtitleEraseCapabilities
	err := c.LegacyJSON(ctx, http.MethodGet, "/video-smart-erase/capabilities", nil, &smartCaps)
	var httpErr *MediaHTTPError
	if errors.As(err, &httpErr) && (httpErr.StatusCode == http.StatusNotFound || httpErr.StatusCode == http.StatusMethodNotAllowed) {
		var legacyCaps SubtitleEraseCapabilities
		err = c.LegacyJSON(ctx, http.MethodGet, "/video-subtitle-erase/capabilities", nil, &legacyCaps)
		return legacyCaps, err
	}
	return smartCaps, err
}

func (c *MediaClient) EstimateSubtitleErase(ctx context.Context, input SubtitleEraseInput) (SubtitleEraseEstimate, error) {
	var estimate SubtitleEraseEstimate
	input.EstimateOnly = true
	err := c.LegacyJSON(ctx, http.MethodPost, "/video-subtitle-erase/estimate", SubtitleEraseBody(input), &estimate)
	if err == nil && (estimate.Currency != "CNY" || estimate.Reservation <= 0 || estimate.GenerationSubmitted) {
		err = errors.New("视频擦除预估费用无效，请重新获取")
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

func (c *MediaClient) GetSubtitleEraseSubtitles(ctx context.Context, id string) (SubtitleEraseSubtitles, error) {
	var subs SubtitleEraseSubtitles
	path, err := SubtitleEraseTaskPath(id)
	if err != nil {
		return subs, err
	}
	err = c.LegacyJSON(ctx, http.MethodGet, path+"/subtitles", nil, &subs)
	return subs, err
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
