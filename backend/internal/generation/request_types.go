package generation

import "encoding/json"

func RequestAsMap(value interface{}) (map[string]interface{}, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	result := make(map[string]interface{})
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	return result, nil
}

type SeedanceVideosRequest struct {
	OmniReferenceTaskType string   `json:"omni_reference_task_type,omitempty"`
	Model                 string   `json:"model"`
	Prompt                string   `json:"prompt,omitempty"`
	AspectRatio           string   `json:"aspect_ratio,omitempty"`
	Resolution            string   `json:"resolution,omitempty"`
	Duration              int      `json:"duration,omitempty"`
	GenerateAudio         *bool    `json:"generate_audio,omitempty"`
	Draft                 *bool    `json:"draft,omitempty"`
	DraftTaskID           string   `json:"draft_task_id,omitempty"`
	ReturnLastFrame       *bool    `json:"return_last_frame,omitempty"`
	ImageURL              string   `json:"image_url,omitempty"`
	ReferenceImageURLs    []string `json:"reference_image_urls,omitempty"`
	ImageURLs             []string `json:"image_urls,omitempty"`
	ReferenceVideos       []string `json:"reference_videos,omitempty"`
	ReferenceAudios       []string `json:"reference_audios,omitempty"`
}

type GeminiImageRequest struct {
	Contents          []GeminiImageContent        `json:"contents"`
	SystemInstruction *GeminiImageContent         `json:"systemInstruction,omitempty"`
	GenerationConfig  GeminiImageGenerationConfig `json:"generationConfig"`
}

type GeminiImageContent struct {
	Role  string                   `json:"role,omitempty"`
	Parts []GeminiImageContentPart `json:"parts"`
}

type GeminiImageContentPart struct {
	Text       string                 `json:"text,omitempty"`
	InlineData *GeminiImageInlineData `json:"inlineData,omitempty"`
}

type GeminiImageInlineData struct {
	MIMEType string `json:"mimeType"`
	Data     string `json:"data"`
}

type GeminiImageGenerationConfig struct {
	ResponseModalities []string           `json:"responseModalities"`
	ImageConfig        *GeminiImageConfig `json:"imageConfig,omitempty"`
}

type GeminiImageConfig struct {
	AspectRatio string `json:"aspectRatio,omitempty"`
	ImageSize   string `json:"imageSize,omitempty"`
}

type SeedanceAgentPlanRequest struct {
	OmniReferenceTaskType string                   `json:"omni_reference_task_type,omitempty"`
	Model                 string                   `json:"model"`
	Content               []map[string]interface{} `json:"content"`
	Ratio                 string                   `json:"ratio,omitempty"`
	Resolution            string                   `json:"resolution"`
	Duration              int                      `json:"duration,omitempty"`
	GenerateAudio         *bool                    `json:"generate_audio,omitempty"`
	Watermark             *bool                    `json:"watermark,omitempty"`
	Draft                 *bool                    `json:"draft,omitempty"`
	ReturnLastFrame       *bool                    `json:"return_last_frame,omitempty"`
}
