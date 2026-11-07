package operations

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/canvas"
)

// storyboardRowFieldSchemas 是分镜行可写字段的白名单（与 canvas.StoryboardRowDraft 一一对应）。
// append 与 update 的 JSON Schema 共用这份字段表，避免两处定义漂移。
var storyboardRowFieldSchemas = map[string]map[string]any{
	"durationSeconds":       {"type": "number"},
	"plotDescription":       {"type": "string"},
	"dialogue":              {"type": "string"},
	"imageGenerationPrompt": {"type": "string"},
	"videoMotionPrompt":     {"type": "string"},
}

// storyboardTargetSchema 组装定位参数（canvasId/nodeId/expectedRevision + 一个批次字段）。
func storyboardTargetSchema(field string, itemSchema map[string]any, required []string) json.RawMessage {
	properties := map[string]any{
		"canvasId":         map[string]any{"type": "string"},
		"nodeId":           map[string]any{"type": "string"},
		"expectedRevision": map[string]any{"type": "integer"},
		field:              itemSchema,
	}
	encoded, err := json.Marshal(map[string]any{
		"type": "object", "properties": properties,
		"required": append([]string{"canvasId", "nodeId", "expectedRevision"}, required...),
	})
	if err != nil {
		return json.RawMessage(`{"type":"object"}`)
	}
	return encoded
}

func storyboardRowsAppendSchema() json.RawMessage {
	return storyboardTargetSchema("rows", map[string]any{
		"type": "array",
		"items": map[string]any{
			"type":        "object",
			"description": "行ID与镜号由服务端分配",
			"properties":  storyboardRowFieldSchemas,
		},
	}, []string{"rows"})
}

func storyboardRowUpdateSchema() json.RawMessage {
	return storyboardTargetSchema("patches", map[string]any{
		"type": "array",
		"items": map[string]any{
			"type": "object",
			"properties": func() map[string]any {
				properties := map[string]any{"rowId": map[string]any{"type": "string"},
					"imageNodeId": map[string]any{"type": "string", "description": "绑定图片节点；空串解绑"},
					"videoNodeId": map[string]any{"type": "string", "description": "绑定视频节点；空串解绑"},
				}
				for name, schema := range storyboardRowFieldSchemas {
					properties[name] = schema
				}
				return properties
			}(),
			"required": []string{"rowId"},
		},
	}, []string{"patches"})
}

func storyboardRowRemoveSchema() json.RawMessage {
	return storyboardTargetSchema("rowIds", map[string]any{
		"type":  "array",
		"items": map[string]any{"type": "string"},
	}, []string{"rowIds"})
}

func opStoryboardRowsAppend(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string                      `json:"canvasId"`
		NodeID           string                      `json:"nodeId"`
		ExpectedRevision int64                       `json:"expectedRevision"`
		Rows             []canvas.StoryboardRowDraft `json:"rows"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || strings.TrimSpace(args.NodeID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 与 nodeId 必填")
	}
	_, created, err := ctx.Domain.AppendUserCanvasStoryboardRows(ctx.UserID, args.CanvasID, args.NodeID, args.Rows, args.ExpectedRevision)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return canvasWriteResult(ctx, args.CanvasID, func(doc map[string]any) map[string]any {
		return map[string]any{"canvasId": args.CanvasID, "nodeId": args.NodeID, "created": created, "rowCount": len(docStoryboardRows(doc, args.NodeID))}
	})
}

func opStoryboardRowUpdate(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string                      `json:"canvasId"`
		NodeID           string                      `json:"nodeId"`
		ExpectedRevision int64                       `json:"expectedRevision"`
		Patches          []canvas.StoryboardRowPatch `json:"patches"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || strings.TrimSpace(args.NodeID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 与 nodeId 必填")
	}
	_, update, err := ctx.Domain.UpdateUserCanvasStoryboardRows(ctx.UserID, args.CanvasID, args.NodeID, args.Patches, args.ExpectedRevision)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return canvasWriteResult(ctx, args.CanvasID, func(doc map[string]any) map[string]any {
		result := map[string]any{"canvasId": args.CanvasID, "nodeId": args.NodeID, "updated": update.Updated, "rowCount": len(docStoryboardRows(doc, args.NodeID)),
			"createdEdgeIds": update.CreatedEdgeIDs, "deletedEdgeIds": update.DeletedEdgeIDs,
			"syncedNodeIds": update.SyncedNodeIDs, "skippedNodeIds": update.SkippedNodeIDs}
		if len(update.AlsoChanged) > 0 {
			result["alsoChanged"] = update.AlsoChanged
		}
		return result
	})
}

func opStoryboardRowRemove(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string   `json:"canvasId"`
		NodeID           string   `json:"nodeId"`
		ExpectedRevision int64    `json:"expectedRevision"`
		RowIDs           []string `json:"rowIds"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || strings.TrimSpace(args.NodeID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 与 nodeId 必填")
	}
	before, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var previous map[string]any
	if err := json.Unmarshal(before, &previous); err != nil {
		return nil, AsError(err)
	}
	_, remaining, err := ctx.Domain.RemoveUserCanvasStoryboardRows(ctx.UserID, args.CanvasID, args.NodeID, args.RowIDs, args.ExpectedRevision)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return canvasWriteResult(ctx, args.CanvasID, func(doc map[string]any) map[string]any {
		current := map[string]bool{}
		connections, _ := doc["connections"].([]any)
		for _, raw := range connections {
			if edge, ok := raw.(map[string]any); ok {
				if id, ok := edge["id"].(string); ok {
					current[id] = true
				}
			}
		}
		deleted, _ := removeCanvasEdges(previous, func(edge map[string]any) bool { id, _ := edge["id"].(string); return !current[id] })
		return map[string]any{"canvasId": args.CanvasID, "nodeId": args.NodeID, "removed": len(args.RowIDs), "rowCount": remaining, "deletedEdgeIds": deleted}
	})
}

// docStoryboardRows 从写入后的画布文档里取目标分镜节点的当前行数，用于回执里的行数投影。
func docStoryboardRows(doc map[string]any, nodeID string) []any {
	for _, rawNode := range canvasNodes(doc) {
		node, ok := rawNode.(map[string]any)
		if !ok {
			continue
		}
		if id, _ := node["id"].(string); id != nodeID {
			continue
		}
		metadata, _ := node["metadata"].(map[string]any)
		if metadata == nil {
			return nil
		}
		storyboard, _ := metadata["storyboard"].(map[string]any)
		if storyboard == nil {
			return nil
		}
		rows, _ := storyboard["rows"].([]any)
		return rows
	}
	return nil
}
