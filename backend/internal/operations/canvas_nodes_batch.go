package operations

import (
	"encoding/json"
	"fmt"
	"strings"

	"qisitv/backend/internal/canvas"
)

const (
	canvasNodesConfigureMax = 20
	canvasNodesGetMax       = 50
)

func registerCanvasNodesBatchOps(r *Registry) {
	patch := map[string]any{"type": "object", "minProperties": 1, "additionalProperties": false,
		"properties": canvasNodeConfigurePatchProperties()}
	configureParams, _ := json.Marshal(map[string]any{"type": "object", "additionalProperties": false,
		"properties": map[string]any{
			"canvasId":         map[string]any{"type": "string"},
			"expectedRevision": map[string]any{"type": "integer", "minimum": 1},
			"nodes": map[string]any{"type": "array", "minItems": 1, "maxItems": canvasNodesConfigureMax,
				"items": map[string]any{"type": "object", "additionalProperties": false,
					"properties": map[string]any{
						"nodeId": map[string]any{"type": "string"},
						"kind":   map[string]any{"type": "string", "enum": []string{"image", "video", "audio"}},
						"patch":  patch,
					},
					"required": []string{"nodeId", "kind", "patch"}}},
		},
		"required": []string{"canvasId", "expectedRevision", "nodes"}})
	r.Register(Op{ExternalOnly: true, ReplaySafe: true, ID: "canvas.nodes.configure", Summary: "一次设置多个媒体节点的提示词草稿与生成参数；全部校验通过后只增加一次画布版本", Scope: ScopeCanvas,
		Params: configureParams, Handler: opCanvasNodesConfigure})

	getParams, _ := json.Marshal(map[string]any{"type": "object", "additionalProperties": false,
		"properties": map[string]any{
			"canvasId": map[string]any{"type": "string"},
			"nodeIds":  map[string]any{"type": "array", "minItems": 1, "maxItems": canvasNodesGetMax, "items": map[string]any{"type": "string"}},
		},
		"required": []string{"canvasId", "nodeIds"}})
	r.Register(Op{ExternalOnly: true, ReadOnly: true, ID: "canvas.nodes.get", Summary: "一次读取指定的多个画布节点", Scope: ScopeCanvas,
		Params: getParams, Handler: opCanvasNodesGet})
}

type canvasNodeConfigureInput struct {
	NodeID string                     `json:"nodeId"`
	Kind   string                     `json:"kind"`
	Patch  map[string]json.RawMessage `json:"patch"`
}

func opCanvasNodesConfigure(ctx *Context, raw json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string                     `json:"canvasId"`
		ExpectedRevision int64                      `json:"expectedRevision"`
		Nodes            []canvasNodeConfigureInput `json:"nodes"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || args.ExpectedRevision <= 0 {
		return nil, InvalidArg("invalid_params", "需要画布和当前版本")
	}
	if len(args.Nodes) == 0 || len(args.Nodes) > canvasNodesConfigureMax {
		return nil, InvalidArg("invalid_batch", fmt.Sprintf("nodes 必须是 1..%d 项的数组", canvasNodesConfigureMax))
	}
	seen := map[string]int{}
	for index, node := range args.Nodes {
		if strings.TrimSpace(node.NodeID) == "" {
			return nil, batchNodeError(index+1, "", InvalidArg("invalid_params", "nodeId 必填"))
		}
		if first, duplicate := seen[node.NodeID]; duplicate {
			return nil, batchNodeError(index+1, node.NodeID,
				InvalidArg("duplicate_node_id", fmt.Sprintf("与第 %d 个节点重复", first+1)))
		}
		seen[node.NodeID] = index
		if len(node.Patch) == 0 {
			return nil, batchNodeError(index+1, node.NodeID, InvalidArg("invalid_params", "patch 至少要有一个字段"))
		}
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
	// 先校验完全部节点再落盘：任何一个不合法都整次拒绝，画布保持原样。
	patches := make([]map[string]any, 0, len(args.Nodes))
	for index, node := range args.Nodes {
		patch, err := prepareCanvasNodeConfigure(ctx, doc, node.NodeID, node.Kind, node.Patch)
		if err != nil {
			return nil, batchNodeError(index+1, node.NodeID, err)
		}
		patches = append(patches, patch)
	}
	// 先在同一份文档上应用全部 patch，再把整份文档提交一次；字段落点与单节点共用，
	// 版本只推进一次，外部写入记录与撤销也按这一次操作整批处理。
	for index, node := range args.Nodes {
		if err := canvas.ApplyCanvasNodeFieldsPatch(doc, node.NodeID, patches[index]); err != nil {
			return nil, batchNodeError(index+1, node.NodeID, mapDomainError(err))
		}
	}
	encoded, err := json.Marshal(doc)
	if err != nil {
		return nil, AsError(err)
	}
	if _, _, err := ctx.Domain.CommitUserCanvasDocument(ctx.UserID, args.CanvasID, args.ExpectedRevision, encoded); err != nil {
		return nil, mapDomainError(err)
	}
	return canvasWriteResult(ctx, args.CanvasID, func(doc map[string]any) map[string]any {
		revision := canvasRevision(doc)
		nodes := make([]map[string]any, 0, len(args.Nodes))
		for _, node := range args.Nodes {
			nodes = append(nodes, map[string]any{"canvasId": args.CanvasID, "nodeId": node.NodeID,
				"node": findDocNode(doc, node.NodeID), "draftConfigured": true, "revision": revision})
		}
		return map[string]any{"canvasId": args.CanvasID, "nodes": nodes}
	})
}

func opCanvasNodesGet(ctx *Context, raw json.RawMessage) (any, error) {
	var args struct {
		CanvasID string   `json:"canvasId"`
		NodeIDs  []string `json:"nodeIds"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 必填")
	}
	if len(args.NodeIDs) == 0 || len(args.NodeIDs) > canvasNodesGetMax {
		return nil, InvalidArg("invalid_batch", fmt.Sprintf("nodeIds 必须是 1..%d 项的数组", canvasNodesGetMax))
	}
	for _, nodeID := range args.NodeIDs {
		if strings.TrimSpace(nodeID) == "" {
			return nil, InvalidArg("invalid_params", "nodeIds 不能包含空值")
		}
	}
	canvasRaw, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(canvasRaw, &doc); err != nil {
		return nil, AsError(err)
	}
	nodes := make([]any, 0, len(args.NodeIDs))
	missing := make([]string, 0)
	seen := make(map[string]bool, len(args.NodeIDs))
	for _, nodeID := range args.NodeIDs {
		// 重复的 nodeId 只按首次出现返回一次，返回节点和缺失列表用同一套语义。
		if seen[nodeID] {
			continue
		}
		seen[nodeID] = true
		node := findDocNode(doc, nodeID)
		if node == nil {
			missing = append(missing, nodeID)
			continue
		}
		nodes = append(nodes, sanitizeForClient(node))
	}
	return map[string]any{"canvasId": args.CanvasID, "revision": canvasRevision(doc), "nodes": nodes, "missingNodeIds": missing}, nil
}

// batchNodeError 保留单节点校验的错误类型与原因，并补上批次位置和目标节点，
// 让外部 Agent 能直接改对那一个节点，而不是猜整批哪里出错。
func batchNodeError(index int, nodeID string, err error) *Error {
	opErr := AsError(err)
	wrapped := *opErr
	label := fmt.Sprintf("第 %d 个节点", index)
	if strings.TrimSpace(nodeID) != "" {
		label += "（" + nodeID + "）"
	}
	wrapped.Message = label + ": " + opErr.Message
	details := make(map[string]any, len(opErr.Details)+2)
	for key, value := range opErr.Details {
		details[key] = value
	}
	details["index"] = index
	details["nodeId"] = nodeID
	wrapped.Details = details
	return &wrapped
}
