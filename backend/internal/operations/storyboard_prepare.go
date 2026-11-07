package operations

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"infinite-canvas/backend/internal/canvas"
)

// storyboardTitleTemplateMaxRunes 与 schema 的 maxLength 一致；入口不执行 JSON Schema，长度在这里校验。
const storyboardTitleTemplateMaxRunes = 40

func registerStoryboardPreparation(r *Registry) {
	properties := map[string]any{
		"canvasId": map[string]any{"type": "string"}, "nodeId": map[string]any{"type": "string"},
		"expectedRevision": map[string]any{"type": "integer", "minimum": 1},
		"rowIds":           map[string]any{"type": "array", "minItems": 1, "maxItems": 8, "items": map[string]any{"type": "string"}},
		"script": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"title", "rows"}, "properties": map[string]any{
			"title": map[string]any{"type": "string", "minLength": 1},
			"rows":  map[string]any{"type": "array", "minItems": 1, "maxItems": 8, "items": map[string]any{"type": "object", "description": "行ID与镜号由服务端分配", "properties": storyboardRowFieldSchemas}},
		}, "description": "新建分镜（省略 image/video 只建分镜）"},
		"referenceNodeIds": map[string]any{"type": "array", "maxItems": 4, "items": map[string]any{"type": "string"}},
		"image":            map[string]any{"type": "object", "properties": map[string]any{"model": map[string]any{"type": "string"}, "size": map[string]any{"type": "string"}, "title": map[string]any{"type": "string", "maxLength": storyboardTitleTemplateMaxRunes, "description": "标题模板，{n} 为镜号，如「镜 {n} 首帧」；省略默认「镜头 {n} · 首帧」"}}, "required": []string{"model"}},
		"video":            map[string]any{"type": "object", "properties": map[string]any{"model": map[string]any{"type": "string"}, "size": map[string]any{"type": "string"}, "generateAudio": map[string]any{"type": "string", "enum": []string{"true", "false"}}, "title": map[string]any{"type": "string", "maxLength": storyboardTitleTemplateMaxRunes, "description": "标题模板，{n} 为镜号，如「镜 {n} 视频」；省略默认「镜头 {n} · 视频」"}}, "required": []string{"model", "generateAudio"}},
	}
	params, _ := json.Marshal(map[string]any{"type": "object", "additionalProperties": false, "properties": properties,
		"required": []string{"canvasId", "expectedRevision"}})
	r.Register(Op{ID: "canvas.script.prepare", Summary: "准备分镜脚本与可选首帧/视频草稿（不开始生成）", Scope: ScopeCanvas, ReplaySafe: true, AssistantCanvas: true, Params: params, Handler: opStoryboardPrepare})
}

func opStoryboardPrepare(ctx *Context, raw json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string                     `json:"canvasId"`
		NodeID           string                     `json:"nodeId"`
		ExpectedRevision int64                      `json:"expectedRevision"`
		RowIDs           []string                   `json:"rowIds"`
		ReferenceNodeIDs []string                   `json:"referenceNodeIds"`
		Image            map[string]json.RawMessage `json:"image"`
		Video            map[string]json.RawMessage `json:"video"`
		Script           *canvas.StoryboardDraft    `json:"script"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || args.ExpectedRevision <= 0 || (args.Script == nil && strings.TrimSpace(args.NodeID) == "") {
		return nil, InvalidArg("invalid_params", "需要画布、分镜节点和当前版本")
	}
	if args.Script != nil && (args.NodeID != "" || len(args.RowIDs) > 0 || strings.TrimSpace(args.Script.Title) == "" || len(args.Script.Rows) < 1 || len(args.Script.Rows) > 8) {
		return nil, InvalidArg("invalid_params", "新分镜需要名称和1至8行正文，不能同时指定已有分镜")
	}
	input := canvas.StoryboardPreparation{Script: args.Script, RowIDs: args.RowIDs, ReferenceNodeIDs: args.ReferenceNodeIDs}
	for _, item := range []struct {
		kind   string
		raw    map[string]json.RawMessage
		target *map[string]any
		title  *string
	}{{"image", args.Image, &input.Image, &input.ImageTitle}, {"video", args.Video, &input.Video, &input.VideoTitle}} {
		if item.raw == nil {
			continue
		}
		var selected string
		if json.Unmarshal(item.raw["model"], &selected) != nil || strings.TrimSpace(selected) == "" {
			return nil, InvalidArg("invalid_parameter", "请选择明确的生成模型")
		}
		if _, exists := item.raw["prompt"]; exists {
			return nil, InvalidArg("invalid_parameter", "分镜提示词请填写在对应分镜行")
		}
		if _, exists := item.raw["seconds"]; exists {
			return nil, InvalidArg("invalid_parameter", "视频时长请修改对应分镜行")
		}
		if _, exists := item.raw["count"]; exists {
			return nil, InvalidArg("invalid_parameter", "每个分镜创建一张首帧")
		}
		if item.kind == "video" {
			if _, exists := item.raw["generateAudio"]; !exists {
				return nil, InvalidArg("invalid_parameter", "请根据作品需要明确选择是否生成声音")
			}
		}
		if rawTitle, exists := item.raw["title"]; exists {
			var title string
			if string(rawTitle) == "null" || json.Unmarshal(rawTitle, &title) != nil {
				return nil, InvalidArg("invalid_parameter", "草稿标题必须是字符串")
			}
			title = strings.TrimSpace(title)
			if title != "" && !strings.Contains(title, "{n}") {
				return nil, InvalidArg("invalid_parameter", "草稿标题模板必须包含 {n} 以代表镜号，例如「镜 {n} 首帧」")
			}
			if utf8.RuneCountInString(title) > storyboardTitleTemplateMaxRunes {
				return nil, InvalidArg("invalid_parameter", "草稿标题模板最多 40 个字")
			}
			*item.title = title
			delete(item.raw, "title")
		}
		patch, err := resolveGenerationDraft(ctx, item.kind, item.raw, nil)
		if err != nil {
			return nil, err
		}
		*item.target = patch
	}
	_, prepared, err := ctx.Domain.PrepareUserCanvasStoryboard(ctx.UserID, args.CanvasID, args.NodeID, input, args.ExpectedRevision)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if prepared.ScriptNodeID != "" {
		args.NodeID = prepared.ScriptNodeID
	}
	return canvasWriteResult(ctx, args.CanvasID, func(map[string]any) map[string]any {
		return map[string]any{"canvasId": args.CanvasID, "nodeId": args.NodeID, "created": prepared.Created, "createdEdgeIds": prepared.CreatedEdgeIDs, "shots": prepared.Shots}
	})
}
