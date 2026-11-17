// Package topaz defines the canvas parameters for the official upscale gateway.
package topaz

import (
	"errors"
	"math"
	"strings"
)

type Request struct {
	ResourceID            string  `json:"resourceId"`
	ChannelID             string  `json:"channelId"`
	Mode                  string  `json:"mode"`
	Model                 string  `json:"model"`
	Scale                 float64 `json:"scale"`
	OutputFormat          string  `json:"outputFormat,omitempty"`
	EnhancementStrength   string  `json:"enhancementStrength,omitempty"`
	ClientOperationID     string  `json:"clientOperationId,omitempty"`
	ProjectID             string  `json:"projectId,omitempty"`
	NodeID                string  `json:"nodeId,omitempty"`
	Resolution            string  `json:"resolution,omitempty"`
	ModelQuality          string  `json:"modelQuality,omitempty"`
	AcceptProviderBilling bool    `json:"acceptProviderBilling,omitempty"`
}

type ModelOption struct {
	ID             string `json:"id"`
	Label          string `json:"label"`
	BillingMode    string `json:"billingMode,omitempty"`
	BillingSummary string `json:"billingSummary,omitempty"`
}

type UpstreamModel struct {
	ID             string
	Label          string
	MediaType      string
	Mode           string
	BillingMode    string
	BillingSummary string
}

type Mode struct {
	MediaType     string        `json:"mediaType"`
	Mode          string        `json:"mode"`
	Models        []string      `json:"models"`
	ModelOptions  []ModelOption `json:"modelOptions,omitempty"`
	Scales        []int         `json:"scales"`
	OutputFormats []string      `json:"outputFormats"`
	FixedScale    int           `json:"fixedScale,omitempty"`
	Provider      string        `json:"provider,omitempty"`
}

func Modes() []Mode {
	base := []Mode{
		{MediaType: "image", Mode: "precision", Models: []string{"Standard V2"}, Scales: []int{1, 2, 3, 4}, OutputFormats: []string{"png", "jpeg"}},
		{MediaType: "image", Mode: "generative", Models: []string{"Wonder 3.5"}, Scales: []int{1, 2, 3, 4}, OutputFormats: []string{"png", "jpeg"}},
		{MediaType: "video", Mode: "precision", Models: []string{"Proteus"}, Scales: []int{1, 2, 3, 4}, OutputFormats: []string{"mp4"}},
		{MediaType: "video", Mode: "generative", Models: []string{"Starlight Fast 2"}, Scales: []int{1, 2, 3, 4}, OutputFormats: []string{"mp4"}},
	}
	for i := range base {
		label := base[i].Models[0]
		base[i].Provider = "topaz"
		base[i].ModelOptions = []ModelOption{{ID: ModelID(label), Label: label}}
	}
	return base
}

// LikeAIModes reports the independent direct-service catalogue; it is not a
// fallback for models that the managed provider omitted from its response.
func LikeAIModes() []Mode {
	return []Mode{
		{MediaType: "image", Mode: "likeai", Models: []string{"huoshan_image_super_resolution"}, Scales: []int{1}, OutputFormats: []string{}, FixedScale: 1, Provider: "likeai"},
		{MediaType: "video", Mode: "likeai", Models: []string{"tengxun_video_super_resolution"}, Scales: []int{1}, OutputFormats: []string{}, FixedScale: 1, Provider: "likeai"},
	}
}

func ModesFromUpstream(items []UpstreamModel) []Mode {
	if len(items) == 0 {
		return Modes()
	}
	type key struct{ mediaType, mode string }
	order := []key{
		{"image", "precision"},
		{"image", "generative"},
		{"video", "precision"},
		{"video", "generative"},
	}
	grouped := map[key][]ModelOption{}
	seen := map[key]map[string]bool{}
	for _, item := range items {
		mt := strings.TrimSpace(item.MediaType)
		md := strings.TrimSpace(item.Mode)
		id := strings.TrimSpace(item.ID)
		if (mt != "image" && mt != "video") || (md != "precision" && md != "generative") || id == "" {
			continue
		}
		k := key{mt, md}
		if seen[k] == nil {
			seen[k] = map[string]bool{}
		}
		if seen[k][id] {
			continue
		}
		seen[k][id] = true
		label := strings.TrimSpace(item.Label)
		if label == "" {
			label = id
		}
		grouped[k] = append(grouped[k], ModelOption{
			ID:             id,
			Label:          label,
			BillingMode:    strings.TrimSpace(item.BillingMode),
			BillingSummary: strings.TrimSpace(item.BillingSummary),
		})
	}
	out := make([]Mode, 0, len(order))
	for _, k := range order {
		opts := grouped[k]
		if len(opts) == 0 {
			continue
		}
		models := make([]string, 0, len(opts))
		for _, opt := range opts {
			models = append(models, opt.ID)
		}
		formats := []string{"png", "jpeg"}
		if k.mediaType == "video" {
			formats = []string{"mp4"}
		}
		out = append(out, Mode{
			Provider:      "topaz",
			MediaType:     k.mediaType,
			Mode:          k.mode,
			Models:        models,
			ModelOptions:  opts,
			Scales:        []int{1, 2, 3, 4},
			OutputFormats: formats,
		})
	}
	return out
}

func ModelID(name string) string {
	return map[string]string{"Standard V2": "topaz-standard-v2", "Wonder 3.5": "topaz-wonder-3.5", "Proteus": "topaz-proteus", "Starlight Fast 2": "topaz-starlight-fast-2"}[name]
}

func Validate(r Request, kind string) error {
	if r.Mode == "likeai" {
		if r.ResourceID == "" || r.ChannelID == "" || r.Scale != 1 || r.OutputFormat != "" || r.EnhancementStrength != "" {
			return errors.New("LikeAI 超清需要素材和配置渠道，不支持自定义倍率或输出格式")
		}
		if kind == "image" && r.Model == "huoshan_image_super_resolution" && (r.ModelQuality == "" || r.ModelQuality == "MQ" || r.ModelQuality == "HQ" || r.ModelQuality == "LQ") && r.Resolution == "" {
			return nil
		}
		if kind == "video" && r.Model == "tengxun_video_super_resolution" && (r.Resolution == "1080p" || r.Resolution == "1440p" || r.Resolution == "2160p") && r.ModelQuality == "" {
			return nil
		}
		return errors.New("LikeAI 超清模型或参数无效")
	}
	_, err := ResolveModelID(r, kind, Modes())
	return err
}

func ResolveModelID(r Request, kind string, modes []Mode) (string, error) {
	if r.ResourceID == "" || r.ChannelID != "beeftv" || math.IsNaN(r.Scale) || math.IsInf(r.Scale, 0) || r.Scale < 1 || r.Scale > 4 || r.Scale != math.Trunc(r.Scale) {
		return "", errors.New("请选择素材、官方算力及 1–4 倍整数倍率")
	}
	requested := strings.TrimSpace(r.Model)
	if requested == "" {
		return "", errors.New("请选择超分模型")
	}
	if modes == nil {
		modes = Modes()
	}
	for _, mode := range modes {
		if mode.MediaType != kind || mode.Mode != r.Mode {
			continue
		}
		resolved := ""
		for _, opt := range mode.ModelOptions {
			if requested == opt.ID || requested == opt.Label || (ModelID(requested) != "" && ModelID(requested) == opt.ID) {
				resolved = opt.ID
				break
			}
		}
		if resolved == "" {
			for _, m := range mode.Models {
				if requested == m {
					if id := ModelID(m); id != "" {
						resolved = id
					} else {
						resolved = m
					}
					break
				}
			}
		}
		if resolved == "" {
			continue
		}
		if r.OutputFormat != "" {
			found := false
			for _, format := range mode.OutputFormats {
				found = found || format == r.OutputFormat
			}
			if !found {
				return "", errors.New("输出格式不受支持")
			}
		}
		if r.EnhancementStrength != "" && r.EnhancementStrength != "low" {
			return "", errors.New("当前超分模型仅支持默认增强强度")
		}
		return resolved, nil
	}
	return "", errors.New("此素材的模式或模型不受支持")
}
