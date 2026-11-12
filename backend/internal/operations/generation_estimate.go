package operations

import (
	"encoding/json"
	"strconv"
	"strings"
	"unicode/utf8"

	"qisitv/backend/internal/beeftv"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/modelcatalog"
	"qisitv/backend/internal/pricing"
)

// EstimateTarget is one planned generation as the canvas would submit it.
type EstimateTarget struct {
	ModelKey        string            `json:"modelKey"`
	Kind            string            `json:"kind"`
	Parameters      map[string]string `json:"parameters,omitempty"`
	ReferenceImages int               `json:"referenceImages,omitempty"`
	ReferenceVideos int               `json:"referenceVideos,omitempty"`
	Text            string            `json:"text,omitempty"`
}

type GenerationEstimate struct {
	Items   []pricing.Estimate `json:"items"`
	Summary pricing.Summary    `json:"summary"`
}

const maxEstimateTargets = 200

func registerGenerationEstimateOp(r *Registry) {
	r.Register(Op{ID: "generation.estimate", Summary: "按已保存的价格目录估算一组生成的费用；不联网、不写入、不建任务，没有价格的项目会写明原因", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params: json.RawMessage(`{"type":"object","properties":{"targets":{"type":"array","minItems":1,"maxItems":200,"items":{"type":"object","properties":{"modelKey":{"type":"string"},"kind":{"type":"string","enum":["image","video","audio"]},"parameters":{"type":"object","additionalProperties":{"type":"string"},"description":"与节点相同的生成参数，如 size、quality、count、vquality、seconds"},"referenceImages":{"type":"integer","minimum":0},"referenceVideos":{"type":"integer","minimum":0},"text":{"type":"string","description":"配音台词"}},"required":["modelKey","kind"]}}},"required":["targets"]}`),
		Handler: func(ctx *Context, raw json.RawMessage) (any, error) {
			var args struct {
				Targets []EstimateTarget `json:"targets"`
			}
			if err := decodeParams(raw, &args); err != nil {
				return nil, err
			}
			if len(args.Targets) == 0 || len(args.Targets) > maxEstimateTargets {
				return nil, InvalidArg("invalid_batch", "targets 必须是 1..200 项的数组")
			}
			for _, target := range args.Targets {
				if target.Kind != "image" && target.Kind != "video" && target.Kind != "audio" {
					return nil, InvalidArg("invalid_kind", "kind 只能是 image、video 或 audio")
				}
				if target.ReferenceImages < 0 || target.ReferenceVideos < 0 {
					return nil, InvalidArg("invalid_params", "参考素材数量不能为负数")
				}
			}
			return EstimateGenerationCost(ctx.Domain, args.Targets), nil
		}})
}

// EstimateGenerationCost prices planned targets from the saved model catalog.
// It reads no network, writes nothing and creates no task.
func EstimateGenerationCost(domain Domain, targets []EstimateTarget) GenerationEstimate {
	var catalog *modelcatalog.CatalogResponse
	if reader, ok := domain.(ModelCatalogReader); ok {
		catalog, _ = reader.AgentModelCatalog()
	}
	items := make([]pricing.Estimate, 0, len(targets))
	for _, target := range targets {
		items = append(items, estimateTarget(catalog, target))
	}
	return GenerationEstimate{Items: items, Summary: pricing.Summarize(items)}
}

func estimateTarget(catalog *modelcatalog.CatalogResponse, target EstimateTarget) pricing.Estimate {
	channelID, model, ok := findEstimateModel(catalog, target.ModelKey)
	if !ok {
		return pricing.Unknown("找不到这个模型，暂无价格")
	}
	table := model.Pricing
	if table == nil && target.Kind == "video" {
		table = pricing.FromVideoQuote(model.VideoPricing)
	}
	if table == nil {
		if channelID != beeftv.ChannelID {
			return pricing.Unknown("自带 Key 的渠道暂无价格，按该渠道实际计费")
		}
		return pricing.Unknown("这个模型暂无价格")
	}
	params := target.Parameters
	count, _ := strconv.Atoi(strings.TrimSpace(params["count"]))
	request := pricing.Target{Kind: target.Kind, Count: count, ReferenceImages: target.ReferenceImages, ReferenceVideos: target.ReferenceVideos}
	capability := estimateCapability(model.CapabilityConfig)
	switch target.Kind {
	case "image":
		var image *modelcatalog.ImageCapabilityConfig
		if capability != nil {
			image = capability.Image
		}
		request.Size, request.Quality = generation.ManagedImageSizeAndQuality(image, params["size"], params["quality"])
		request.Layers = params["seedreamMode"] == "layers"
		// A group request bills each returned image, up to this many.
		if outputs := generation.SequentialMaxImages(params["seedreamMaxImages"], target.ReferenceImages); outputs > 1 && (image == nil || image.SequentialGeneration.Supported) {
			request.Count = outputs
		}
	case "video":
		resolution, seconds := params["vquality"], params["seconds"]
		if capability != nil && capability.Video != nil {
			if strings.TrimSpace(resolution) == "" {
				resolution = capability.Video.DefaultResolution
			}
			if strings.TrimSpace(seconds) == "" && capability.Video.Duration.Default > 0 {
				seconds = strconv.Itoa(capability.Video.Duration.Default)
			}
		}
		request.Resolution = resolution
		request.Seconds, _ = strconv.ParseFloat(strings.TrimSpace(seconds), 64)
	case "audio":
		request.Characters = utf8.RuneCountInString(strings.TrimSpace(target.Text))
	}
	return pricing.Quote(table, request)
}

func findEstimateModel(catalog *modelcatalog.CatalogResponse, modelKey string) (string, modelcatalog.PublicChannelModel, bool) {
	if catalog == nil {
		return "", modelcatalog.PublicChannelModel{}, false
	}
	channelID, shortKey := "", strings.TrimSpace(modelKey)
	if i := strings.Index(shortKey, "::"); i >= 0 {
		channelID, shortKey = strings.TrimSpace(shortKey[:i]), strings.TrimSpace(shortKey[i+2:])
	}
	if shortKey == "" {
		return "", modelcatalog.PublicChannelModel{}, false
	}
	for _, channel := range catalog.Channels {
		if channelID != "" && channel.ID != channelID {
			continue
		}
		for _, model := range channel.Models {
			if model.ModelKey == shortKey || model.ID == shortKey {
				return channel.ID, model, true
			}
		}
	}
	return "", modelcatalog.PublicChannelModel{}, false
}

func estimateCapability(config map[string]any) *modelcatalog.ModelCapabilityConfig {
	if len(config) == 0 {
		return nil
	}
	raw, err := json.Marshal(config)
	if err != nil {
		return nil
	}
	value, err := modelcatalog.DecodeModelCapabilityConfig(string(raw))
	if err != nil {
		return nil
	}
	return value
}

type estimatedGenerationTarget struct {
	GenerationTarget
	Estimate pricing.Estimate `json:"estimate"`
}

// estimateGenerationTargets describes canvas targets for the estimate. A
// reference counts as a video when its node generates video.
func estimateGenerationTargets(nodes map[string]map[string]any, targets []GenerationTarget) []EstimateTarget {
	result := make([]EstimateTarget, 0, len(targets))
	for _, target := range targets {
		item := EstimateTarget{ModelKey: target.ModelKey, Kind: target.Kind, Parameters: target.Parameters}
		for _, id := range target.ReferenceNodeIDs {
			switch nodeGenerationKind(nodes[id]) {
			case "video":
				item.ReferenceVideos++
			case "audio":
			default:
				item.ReferenceImages++
			}
		}
		if target.Kind == "audio" {
			item.Text = target.Prompt
		}
		result = append(result, item)
	}
	return result
}
