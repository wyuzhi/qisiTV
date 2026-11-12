package modelcatalog

import (
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/pricing"
)

// ModelCapabilityConfig 是模型能力声明，不包含供应商字段名；协议适配器负责把统一参数映射到上游请求。
type ModelCapabilityConfig struct {
	Version int                    `json:"version"`
	Text    *TextCapabilityConfig  `json:"text,omitempty"`
	Image   *ImageCapabilityConfig `json:"image,omitempty"`
	Video   *VideoCapabilityConfig `json:"video,omitempty"`
}

type TextCapabilityConfig struct {
	// Streaming controls whether this model accepts upstream SSE text responses.
	// A nil value is treated as true for backwards compatibility with older configs.
	Streaming  *bool               `json:"streaming,omitempty"`
	Thinking   *bool               `json:"thinking,omitempty"`
	References TextReferenceConfig `json:"references"`
}

type TextReferenceConfig struct {
	PromptMaxChars int   `json:"promptMaxChars"`
	MaxImages      int   `json:"maxImages"`
	MaxImageBytes  int64 `json:"maxImageBytes"`
	MaxVideos      int   `json:"maxVideos"`
	MaxVideoBytes  int64 `json:"maxVideoBytes"`
}

type ImageCapabilityConfig struct {
	References            ImageReferenceConfig `json:"references"`
	Size                  ImageSizeConfig      `json:"size"`
	Quality               ImageQualityConfig   `json:"quality"`
	TransparentBackground VideoBooleanConfig   `json:"transparentBackground"`
	SequentialGeneration  VideoBooleanConfig   `json:"sequentialGeneration"`
	ResponseFormat        ImageResponseFormat  `json:"responseFormat"`
	OutputFormat          ParameterSupport     `json:"outputFormat"`
	MaxOutputs            int                  `json:"maxOutputs"`
	GenerationOutputs     []int                `json:"generationOutputs,omitempty"`
	FixedOutputs          int                  `json:"fixedOutputs,omitempty"`
}

type ImageReferenceConfig struct {
	PromptMaxChars int   `json:"promptMaxChars"`
	MaxImages      int   `json:"maxImages"`
	MaxImageBytes  int64 `json:"maxImageBytes"`
	MaskSupported  bool  `json:"maskSupported"`
}

type ImageSizeConfig struct {
	Parameter   string            `json:"parameter"`
	Values      []string          `json:"values"`
	Default     string            `json:"default"`
	AllowCustom bool              `json:"allowCustom"`
	Presets     []ImageSizePreset `json:"presets,omitempty"`
}

type ImageSizePreset struct {
	Tier   string `json:"tier"`
	Ratio  string `json:"ratio"`
	Size   string `json:"size"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type ImageQualityConfig struct {
	Supported bool     `json:"supported"`
	Values    []string `json:"values"`
	Default   string   `json:"default"`
}

type ParameterSupport struct {
	Supported bool `json:"supported"`
}

// ImageResponseFormat 是图片接口 response_format 的开关与取值。
// Value 为空时按 b64_json 处理，保持既有渠道的行为不变；url 让上游返回图片链接，
// 由 BeefTV 下载成字节后再落库——链接会过期，不能直接当作结果保存。
type ImageResponseFormat struct {
	Supported bool   `json:"supported"`
	Value     string `json:"value,omitempty"`
}

const (
	// ImageResponseFormatBase64 让上游内联返回 base64，是默认取值。
	ImageResponseFormatBase64 = "b64_json"
	// ImageResponseFormatURL 让上游返回图片链接，由 BeefTV 下载后转成字节。
	ImageResponseFormatURL = "url"
)

type VideoCapabilityConfig struct {
	References          VideoReferenceConfig                `json:"references"`
	OperationReferences map[string]VideoOperationReferences `json:"operationReferences,omitempty"`
	Duration            VideoDurationConfig                 `json:"duration"`
	DurationSupported   *bool                               `json:"durationSupported,omitempty"`
	Ratios              []string                            `json:"ratios"`
	DefaultRatio        string                              `json:"defaultRatio"`
	Resolutions         []string                            `json:"resolutions"`
	DefaultResolution   string                              `json:"defaultResolution"`
	GenerateAudio       VideoBooleanConfig                  `json:"generateAudio"`
	Watermark           VideoBooleanConfig                  `json:"watermark"`
	Draft               VideoBooleanConfig                  `json:"draft"`
	ReturnLastFrame     VideoBooleanConfig                  `json:"returnLastFrame"`
	Operations          []string                            `json:"operations"`
	DefaultOperation    string                              `json:"defaultOperation"`
	TaskTypeConstraints bool                                `json:"taskTypeConstraints,omitempty"`
}

// Nil inherits the model-wide count; a declared zero forbids that media kind.
type VideoOperationReferences struct {
	MinImages *int `json:"minImages,omitempty"`
	MaxImages *int `json:"maxImages,omitempty"`
	MaxVideos *int `json:"maxVideos,omitempty"`
	MaxAudios *int `json:"maxAudios,omitempty"`
}

type ModelCapabilityDraft struct {
	Capability               string                 `json:"capability,omitempty"`
	Category                 string                 `json:"category,omitempty"`
	Type                     string                 `json:"type,omitempty"`
	Protocol                 string                 `json:"protocol,omitempty"`
	InterfaceType            string                 `json:"interfaceType,omitempty"`
	Model                    string                 `json:"model"`
	BaseURL                  string                 `json:"baseUrl,omitempty"`
	ChannelID                string                 `json:"channelId,omitempty"`
	VideoCapabilitiesVersion *string                `json:"videoCapabilitiesVersion,omitempty"`
	CapabilityConfig         *ModelCapabilityConfig `json:"capabilityConfig,omitempty"`
}

type VideoReferenceConfig struct {
	PromptMaxChars        int     `json:"promptMaxChars"`
	PromptMaxUTF16Units   int     `json:"promptMaxUtf16Units"`
	MinImages             int     `json:"minImages"`
	MaxImages             int     `json:"maxImages"`
	MaxImageBytes         int64   `json:"maxImageBytes"`
	MinImageWidth         int     `json:"minImageWidth,omitempty"`
	MaxImageWidth         int     `json:"maxImageWidth,omitempty"`
	MinImageHeight        int     `json:"minImageHeight,omitempty"`
	MaxImageHeight        int     `json:"maxImageHeight,omitempty"`
	MinImageAspect        float64 `json:"minImageAspect,omitempty"`
	MaxImageAspect        float64 `json:"maxImageAspect,omitempty"`
	MinImagePixels        int64   `json:"minImagePixels,omitempty"`
	MaxImagePixels        int64   `json:"maxImagePixels,omitempty"`
	MaxVideos             int     `json:"maxVideos"`
	MaxVideoBytes         int64   `json:"maxVideoBytes"`
	MaxVideoDuration      int     `json:"maxVideoDurationSeconds"`
	MinVideoDuration      int     `json:"minVideoDurationSeconds,omitempty"`
	MaxVideoTotalDuration int     `json:"maxVideoTotalDurationSeconds,omitempty"`
	MinVideoWidth         int     `json:"minVideoWidth,omitempty"`
	MaxVideoWidth         int     `json:"maxVideoWidth,omitempty"`
	MinVideoHeight        int     `json:"minVideoHeight,omitempty"`
	MaxVideoHeight        int     `json:"maxVideoHeight,omitempty"`
	MinVideoAspect        float64 `json:"minVideoAspect,omitempty"`
	MaxVideoAspect        float64 `json:"maxVideoAspect,omitempty"`
	MinVideoPixels        int64   `json:"minVideoPixels,omitempty"`
	MaxVideoPixels        int64   `json:"maxVideoPixels,omitempty"`
	MaxAudios             int     `json:"maxAudios"`
	MaxAudioBytes         int64   `json:"maxAudioBytes"`
	MaxAudioDuration      int     `json:"maxAudioDurationSeconds"`
	MinAudioDuration      float64 `json:"minAudioDurationSeconds,omitempty"`
	MaxAudioTotalDuration int     `json:"maxAudioTotalDurationSeconds,omitempty"`
}

// DefaultVideoPromptMaxChars 为 0 时不假设供应商未公开的字符硬限。
// 已公布的协议限制与用户配置由对应能力合同提供。
const DefaultVideoPromptMaxChars = 0

type VideoDurationConfig struct {
	Selection     string  `json:"selection"`
	Min           int     `json:"min,omitempty"`
	Max           int     `json:"max,omitempty"`
	Step          int     `json:"step,omitempty"`
	FractionalMin float64 `json:"fractionalMin,omitempty"`
	Continuous    bool    `json:"continuous,omitempty"`
	Values        []int   `json:"values,omitempty"`
	Default       int     `json:"default"`
}

type VideoBooleanConfig struct {
	Supported bool `json:"supported"`
	Default   bool `json:"default"`
}

type CapabilityImageSizePreset struct {
	Size   string `json:"size"`
	Tier   string `json:"tier"`
	Ratio  string `json:"ratio"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type CapabilityImageSize struct {
	Parameter   string                      `json:"parameter,omitempty"`
	AllowCustom bool                        `json:"allowCustom,omitempty"`
	Presets     []CapabilityImageSizePreset `json:"presets,omitempty"`
}

type CapabilitySpec struct {
	Version    int                         `json:"version"`
	Capability string                      `json:"capability"`
	Operations []string                    `json:"operations,omitempty"`
	Inputs     map[string]InputConstraint  `json:"inputs,omitempty"`
	Options    map[string]OptionConstraint `json:"options,omitempty"`
	ImageSize  *CapabilityImageSize        `json:"imageSize,omitempty"`
}

type InputConstraint struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

type OptionConstraint struct {
	Values []any    `json:"values,omitempty"`
	Min    *float64 `json:"min,omitempty"`
	Max    *float64 `json:"max,omitempty"`
	Step   *float64 `json:"step,omitempty"`
}

type ModelRequestIntent struct {
	Capability string         `json:"capability"`
	Operation  string         `json:"operation,omitempty"`
	Inputs     map[string]int `json:"inputs,omitempty"`
	Options    map[string]any `json:"options,omitempty"`
}

type CapabilityMatch struct {
	Matched bool     `json:"matched"`
	Reasons []string `json:"reasons,omitempty"`
}

type PublicChannelCatalog struct {
	ID          string               `json:"id"`
	Name        string               `json:"name"`
	DisplayName string               `json:"displayName"`
	SortOrder   int                  `json:"sortOrder"`
	Models      []PublicChannelModel `json:"models"`
}

type PublicChannelModel struct {
	ID               string                     `json:"id"`
	ModelKey         string                     `json:"modelKey"`
	DisplayName      string                     `json:"displayName"`
	SortOrder        int                        `json:"sortOrder"`
	Icon             string                     `json:"icon"`
	Capability       string                     `json:"capability"`
	Protocol         model.ChannelInterfaceType `json:"protocol"`
	CapabilityConfig map[string]any             `json:"capabilityConfig,omitempty"`
	VideoPricing     map[string]any             `json:"videoPricing,omitempty"`
	// Pricing is the managed channel's published price row; other channels have none.
	Pricing      *pricing.Table          `json:"pricing,omitempty"`
	AudioOptions *AudioGenerationOptions `json:"audioOptions,omitempty"`
	Available    bool                    `json:"available"`
}

type ChannelModelRequest struct {
	ModelKey         string                       `json:"modelKey"`
	ProviderModelKey string                       `json:"providerModelKey"`
	DisplayName      string                       `json:"displayName"`
	Icon             string                       `json:"icon"`
	Capability       string                       `json:"capability"`
	Protocol         string                       `json:"protocol"`
	Enabled          *bool                        `json:"enabled"`
	CapabilityConfig *ModelCapabilityConfig       `json:"capabilityConfig"`
	Variants         []ChannelModelVariantRequest `json:"variants"`
}

type ChannelModelVariantRequest struct {
	Selector         map[string]string `json:"selector"`
	Resolution       string            `json:"resolution"`
	VideoSeconds     int               `json:"videoSeconds"`
	ProviderModelKey string            `json:"providerModelKey"`
	Enabled          *bool             `json:"enabled"`
}

type ChannelModelCatalogOption struct {
	Value string `json:"value"`
	Label string `json:"label,omitempty"`
}

// MediaRef is the catalog/capability view of a reference asset. Adapters copy
// the fields validation actually reads; they do not import app provider types.
type MediaRef struct {
	URL        string
	StorageKey string
	Bytes      int64
	Width      int
	Height     int
	DurationMs int64
}

// TaskConfig is the catalog/capability view of a generation request's model
// selection and declared options.
type TaskConfig struct {
	ImageCapabilitiesVersion *string
	VideoCapabilitiesVersion *string
	ChannelID                string
	ChannelModelKey          string
	Model                    string
	InterfaceType            string
	APIFormat                string
	BaseURL                  string
	Size                     string
	Quality                  string
	Count                    string
	VideoSeconds             string
	VQuality                 string
	CapabilityConfig         *ModelCapabilityConfig
	SystemPrompt             string
	ComposedPromptBytes      int
}

// TaskInput is the explicit adapter target for image/video capability checks.
type TaskInput struct {
	// Template inputs have no media metadata until the user supplies resources.
	// This internal flag is never accepted from a task request.
	DeferReferenceMetadata bool `json:"-"`
	Mode                   string
	Prompt                 string
	Config                 TaskConfig
	ReferenceImages        []MediaRef
	ReferenceVideos        []MediaRef
	ReferenceAudios        []MediaRef
	Mask                   *MediaRef
	Metadata               map[string]any
}
