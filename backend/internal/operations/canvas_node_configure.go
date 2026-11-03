package operations

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/canvas/capability"
	"infinite-canvas/backend/internal/providerpreset"
)

func registerCanvasNodeConfigureOps(r *Registry) {
	properties := map[string]any{
		"model":              map[string]any{"type": "string"},
		"prompt":             map[string]any{"type": "string"},
		"size":               map[string]any{"type": "string"},
		"seconds":            map[string]any{"type": "string"},
		"generateAudio":      map[string]any{"type": "string", "enum": []string{"true", "false"}},
		"audioVoice":         map[string]any{"type": "string"},
		"videoEditOperation": map[string]any{"type": "string", "enum": []string{"text_to_video", "image_to_video", "reference_to_video", "extend", "inpaint", "replace_element", "camera_motion", "style_transfer", "audio_to_video", "compare_versions", "concat", "draft_to_final"}},
	}
	params, _ := json.Marshal(map[string]any{"type": "object", "additionalProperties": false,
		"properties": map[string]any{"canvasId": map[string]any{"type": "string"}, "nodeId": map[string]any{"type": "string"},
			"kind": map[string]any{"type": "string", "enum": []string{"image", "video", "audio"}}, "expectedRevision": map[string]any{"type": "integer", "minimum": 1},
			"patch": map[string]any{"type": "object", "minProperties": 1, "properties": properties}},
		"required": []string{"canvasId", "nodeId", "kind", "expectedRevision", "patch"}})
	r.Register(Op{ReplaySafe: true, AssistantCanvas: true, ID: "canvas.node.configure", Summary: "设置媒体节点的提示词草稿与生成参数；不启动生成", Scope: ScopeCanvas, Params: params, Handler: opCanvasNodeConfigure})
}

func opCanvasNodeConfigure(ctx *Context, raw json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string                     `json:"canvasId"`
		NodeID           string                     `json:"nodeId"`
		Kind             string                     `json:"kind"`
		ExpectedRevision int64                      `json:"expectedRevision"`
		Patch            map[string]json.RawMessage `json:"patch"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if args.CanvasID == "" || args.NodeID == "" || args.ExpectedRevision <= 0 || len(args.Patch) == 0 {
		return nil, InvalidArg("invalid_params", "需要画布、节点、类型、当前版本和参数")
	}
	if args.Kind != "image" && args.Kind != "video" && args.Kind != "audio" {
		return nil, InvalidArg("unsupported_node_kind", "仅媒体生成节点支持参数配置")
	}
	canvasRaw, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(canvasRaw, &doc); err != nil {
		return nil, AsError(err)
	}
	if revision := canvasRevision(doc); revision != args.ExpectedRevision {
		return nil, Conflict("revision_conflict", "画布已变化，请重新读取", map[string]any{"currentRevision": revision})
	}
	node := findDocNode(doc, args.NodeID)
	if node == nil {
		return nil, NotFound("node_not_found", "节点不在当前画布")
	}
	if node["type"] != args.Kind {
		return nil, InvalidArg("node_kind_mismatch", "参数类型与目标节点不一致")
	}
	// 节点上已有的草稿参数先铺底、patch 再覆盖：只改 size 时也要能看出节点是不是正在拆图层。
	base := stringParameters(dependencyMetadata(node))
	patch, err := resolveGenerationDraft(ctx, args.Kind, args.Patch, base)
	if err != nil {
		return nil, err
	}
	if _, hasModel := patch["model"]; !hasModel {
		// 只改尺寸这类参数时 patch 里没有 model，用节点当前模型补上再校验，
		// 否则同一份规则只在换模型时才生效。
		if err := validateModelGenerationParameters(args.Kind, nodeSelectedModel(node), mergeParameters(base, stringParameters(patch))); err != nil {
			return nil, err
		}
	}
	if _, err := ctx.Domain.UpdateUserCanvasNodeFields(ctx.UserID, args.CanvasID, args.NodeID, patch, args.ExpectedRevision); err != nil {
		return nil, mapDomainError(err)
	}
	return canvasWriteResult(ctx, args.CanvasID, func(doc map[string]any) map[string]any {
		return map[string]any{"canvasId": args.CanvasID, "nodeId": args.NodeID, "node": findDocNode(doc, args.NodeID), "draftConfigured": true}
	})
}

// Single draft validator for a node edit and storyboard production preparation.
// base 是节点上已有的草稿参数（新建节点时为空），校验要看它和 patch 合并后的结果。
func resolveGenerationDraft(ctx *Context, kind string, raw map[string]json.RawMessage, base map[string]string) (map[string]any, error) {
	descriptor, _ := capability.BuiltinRegistry().Resolve(kind)
	patch := map[string]any{}
	for name, value := range raw {
		field, ok := descriptor.PatchFields[name]
		if !ok || name == "title" || name == "content" {
			return nil, InvalidArg("unsupported_field", "该类型不支持参数 "+name)
		}
		if name == "count" {
			var count int
			if err := json.Unmarshal(value, &count); err != nil || count < 1 || count > 8 {
				return nil, InvalidArg("invalid_parameter", "count 必须是 1..8 的整数")
			}
			patch[name] = float64(count)
			continue
		}
		var text string
		if string(value) == "null" || json.Unmarshal(value, &text) != nil || len([]rune(text)) > field.MaxRunes {
			return nil, InvalidArg("invalid_parameter", name+" 必须是长度有限的字符串")
		}
		if err := validateDraftValue(name, text); err != nil {
			return nil, err
		}
		patch[name] = text
	}
	if selected, exists := patch["model"]; exists {
		choice, err := ctx.Domain.ResolveAssistantGenerationModel(kind, selected.(string))
		if err != nil {
			return nil, mapDomainError(err)
		}
		if choice.KindMismatch {
			return nil, InvalidArg("generation_model_kind_mismatch", "所选模型不支持该媒体类型")
		}
		if choice.ModelKey == "" || choice.Display == "" {
			return nil, PreconditionFailed("generation_model_unavailable", "所选模型当前不可用", nil)
		}
		patch["model"] = choice.ModelKey
		if err := validateModelGenerationParameters(kind, choice.ModelKey, mergeParameters(base, stringParameters(patch))); err != nil {
			return nil, err
		}
	}
	return patch, nil
}

// validateModelGenerationParameters 用与真实请求同一份型号族规则，在写草稿、
// 准备分镜和提交整片之前拦住模型不接受的尺寸；等上游拒绝时请求已经发出去了。
func validateModelGenerationParameters(kind, modelKey string, params map[string]string) error {
	if kind != "image" {
		return nil
	}
	modelName := strings.TrimSpace(modelKey)
	if i := strings.LastIndex(modelName, "::"); i >= 0 {
		modelName = strings.TrimSpace(modelName[i+2:])
	}
	family := providerpreset.SeedreamFamily(modelName)
	if family == "" {
		return nil
	}
	if _, err := providerpreset.ResolveSeedreamSize(family, params["size"], params["seedreamMode"] == "layers"); err != nil {
		return InvalidArg("invalid_parameter", err.Error())
	}
	return nil
}

func stringParameters(values map[string]any) map[string]string {
	params := map[string]string{}
	for key, value := range values {
		if text, ok := value.(string); ok {
			params[key] = text
		}
	}
	return params
}

// mergeParameters 把节点现状和本次 patch 合并，patch 覆盖节点。只传 patch 会漏掉
// 「节点正在拆图层、这次只改尺寸」这类组合。
func mergeParameters(base, patch map[string]string) map[string]string {
	merged := make(map[string]string, len(base)+len(patch))
	for key, value := range base {
		merged[key] = value
	}
	for key, value := range patch {
		merged[key] = value
	}
	return merged
}

func validateDraftValue(name, value string) error {
	invalid := func() error { return InvalidArg("invalid_parameter", name+" 的值无效") }
	switch name {
	case "generateAudio", "watermark", "transparentBackground":
		if value != "true" && value != "false" {
			return invalid()
		}
	case "seconds", "audioSpeed", "audioPitch", "audioVolume":
		number, err := strconv.ParseFloat(value, 64)
		if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
			return invalid()
		}
		if (name == "seconds" && (number <= 0 || number > 600)) || (name == "audioSpeed" && (number < 0.25 || number > 4)) ||
			(name == "audioPitch" && (number < -12 || number > 12)) || (name == "audioVolume" && (number < 0 || number > 1)) {
			return invalid()
		}
	case "audioFormat":
		if !strings.Contains("|mp3|wav|pcm|flac|aac|opus|ogg|m4a|", "|"+value+"|") {
			return invalid()
		}
	case "videoEditOperation":
		if !strings.Contains("|text_to_video|image_to_video|reference_to_video|extend|inpaint|replace_element|camera_motion|style_transfer|audio_to_video|compare_versions|concat|draft_to_final|", "|"+value+"|") {
			return invalid()
		}
	case "size", "quality", "vquality", "audioVoice":
		if strings.TrimSpace(value) == "" {
			return invalid()
		}
	}
	return nil
}
