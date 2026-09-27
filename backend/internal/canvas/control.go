package canvas

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"qisitv/backend/internal/canvascontract"
	"qisitv/backend/internal/kernel"
)

const MaxCanvasOperations = 100

type CanvasOperation struct {
	Op           string         `json:"op"`
	Node         map[string]any `json:"node,omitempty"`
	NodeID       string         `json:"nodeId,omitempty"`
	Patch        map[string]any `json:"patch,omitempty"`
	Connection   map[string]any `json:"connection,omitempty"`
	ConnectionID string         `json:"connectionId,omitempty"`
}

type CanvasOperationsRequest struct {
	BaseRevision *int64            `json:"baseRevision,omitempty"`
	Operations   []CanvasOperation `json:"operations"`
}

var controlNodeTypes = wordSet("image text drawing script skill config video audio frame markdown svg html panorama compare chart colorgrade media-conversion batch-table")
var controlNodeFields = wordSet("title position width height parentId metadata")
var controlMetadataFields = wordSet(canvascontract.MetadataFields)
var controlMetadataNumbers = wordSet(canvascontract.MetadataNumbers)
var controlMetadataBooleans = wordSet(canvascontract.MetadataBooleans)
var controlMetadataLists = wordSet(canvascontract.MetadataLists)
var controlMetadataObjects = wordSet(canvascontract.MetadataObjects)
var controlConnectionFields = wordSet("id fromNodeId toNodeId fromHandleId toHandleId fromAnchorRatio toAnchorRatio relation storyboardRowId")

func wordSet(words string) map[string]bool {
	result := map[string]bool{}
	for _, word := range strings.Fields(words) {
		result[word] = true
	}
	return result
}
func controlString(value any) string    { text, _ := value.(string); return text }
func controlError(message string) error { return kernel.BadAuthRequest(message) }

// Operations are evaluated against one revision and committed once through the
// same history/resource transaction as browser saves. No partial batch survives.
func (s *Service) ApplyCanvasOperations(userID, canvasID string, req CanvasOperationsRequest) (json.RawMessage, error) {
	// Normalize internal callers to the same JSON types as HTTP, and never
	// mutate a caller-owned node/metadata map while preparing a transaction.
	encoded, encodeErr := json.Marshal(req)
	if encodeErr != nil || len(encoded) > 5<<20 {
		return nil, controlError("画布操作数据无效或过大")
	}
	if err := json.Unmarshal(encoded, &req); err != nil {
		return nil, controlError("画布操作数据无效")
	}
	if len(req.Operations) == 0 || len(req.Operations) > MaxCanvasOperations {
		return nil, controlError("画布操作数必须为 1 到 100")
	}
	if _, err := s.scopedCanvasHistoryProject(userID, canvasID); err != nil {
		return nil, err
	}
	raw, err := s.UserCanvasProject(userID, canvasID)
	if err != nil {
		return nil, err
	}
	var document map[string]any
	if err = json.Unmarshal(raw, &document); err != nil {
		return nil, err
	}
	revision, _ := document["revision"].(float64)
	if req.BaseRevision != nil && (*req.BaseRevision < 0 || *req.BaseRevision != int64(revision)) {
		return nil, canvasRevisionConflict()
	}
	nodes, _ := document["nodes"].([]any)
	connections, _ := document["connections"].([]any)
	if nodes == nil {
		nodes = []any{}
	}
	if connections == nil {
		connections = []any{}
	}
	for index, op := range req.Operations {
		if err = applyControlOperation(document, &nodes, &connections, op); err != nil {
			return nil, fmt.Errorf("操作 %d: %w", index+1, err)
		}
	}
	document["nodes"], document["connections"] = nodes, connections
	if err = validateControlGraph(nodes, connections); err != nil {
		return nil, err
	}
	raw, err = json.Marshal(document)
	if err != nil {
		return nil, err
	}
	saved, err := s.upsertUserCanvasProjectWithHistory(userID, raw, "automatic")
	if err != nil {
		return nil, err
	}
	document["revision"], document["updatedAt"], document["createdAt"] = saved.Revision, saved.UpdatedAt, saved.CreatedAt
	return json.Marshal(document)
}

func applyControlOperation(document map[string]any, nodes, connections *[]any, op CanvasOperation) error {
	findNode := func(id string) (int, map[string]any) {
		for i, value := range *nodes {
			if node, ok := value.(map[string]any); ok && controlString(node["id"]) == id {
				return i, node
			}
		}
		return -1, nil
	}
	switch op.Op {
	case "add":
		if op.Node == nil {
			return controlError("缺少 node")
		}
		node := op.Node
		for key := range node {
			if key != "id" && key != "type" && !controlNodeFields[key] {
				return controlError("不支持的节点字段: " + key)
			}
		}
		if !controlNodeTypes[controlString(node["type"])] {
			return controlError("不支持的节点类型")
		}
		if _, exists := node["id"]; !exists {
			node["id"] = kernel.NewID()
		}
		if id := controlString(node["id"]); !validControlID(id) {
			return controlError("节点 ID 无效")
		} else if _, existing := findNode(id); existing != nil {
			return controlError("节点 ID 已存在")
		}
		if _, exists := node["title"]; !exists {
			node["title"] = "新节点"
		}
		if _, exists := node["position"]; !exists {
			node["position"] = map[string]any{"x": float64(0), "y": float64(0)}
		}
		if _, exists := node["width"]; !exists {
			node["width"] = float64(360)
		}
		if _, exists := node["height"]; !exists {
			node["height"] = float64(240)
		}
		if err := validateControlNode(node); err != nil {
			return err
		}
		if metadata, ok := node["metadata"].(map[string]any); ok {
			if err := validateControlMetadata(metadata); err != nil {
				return err
			}
		}
		node["createdAt"], node["updatedAt"] = time.Now().UTC(), time.Now().UTC()
		*nodes = append(*nodes, node)
	case "update":
		_, node := findNode(op.NodeID)
		if node == nil {
			return kernel.NewAppError(http.StatusNotFound, "节点不存在")
		}
		if len(op.Patch) == 0 {
			return controlError("缺少节点 patch")
		}
		for key, value := range op.Patch {
			if !controlNodeFields[key] {
				return controlError("不支持的节点修改字段: " + key)
			}
			if key == "metadata" || key == "position" {
				patch, ok := value.(map[string]any)
				if !ok {
					return controlError(key + " 必须是对象")
				}
				if key == "metadata" {
					if err := validateControlMetadata(patch); err != nil {
						return err
					}
				}
				current, _ := node[key].(map[string]any)
				if current == nil {
					current = map[string]any{}
				}
				for field, item := range patch {
					if item == nil {
						delete(current, field)
					} else {
						current[field] = item
					}
				}
				node[key] = current
			} else if key == "parentId" && value == nil {
				delete(node, key)
			} else {
				node[key] = value
			}
		}
		if err := validateControlNode(node); err != nil {
			return err
		}
		node["updatedAt"] = time.Now().UTC()
	case "delete":
		index, _ := findNode(op.NodeID)
		if index < 0 {
			return kernel.NewAppError(http.StatusNotFound, "节点不存在")
		}
		*nodes = append((*nodes)[:index], (*nodes)[index+1:]...)
		kept := make([]any, 0, len(*connections))
		for _, value := range *connections {
			edge, ok := value.(map[string]any)
			if ok && (controlString(edge["fromNodeId"]) == op.NodeID || controlString(edge["toNodeId"]) == op.NodeID) {
				continue
			}
			kept = append(kept, value)
		}
		*connections = kept
		for _, value := range *nodes {
			removeControlReferences(value, op.NodeID)
		}
		if timeline, ok := document["timeline"].(map[string]any); ok {
			if clips, ok := timeline["clips"].([]any); ok {
				kept := []any{}
				for _, value := range clips {
					clip, _ := value.(map[string]any)
					if controlString(clip["nodeId"]) != op.NodeID {
						kept = append(kept, value)
					}
				}
				timeline["clips"] = kept
			}
		}
	case "connect":
		if op.Connection == nil {
			return controlError("缺少 connection")
		}
		edge := op.Connection
		for key := range edge {
			if !controlConnectionFields[key] {
				return controlError("不支持的连接字段: " + key)
			}
			if key != "fromAnchorRatio" && key != "toAnchorRatio" {
				text, ok := edge[key].(string)
				if !ok || len(text) > 160 {
					return controlError("连接字段必须是有效字符串: " + key)
				}
			}
		}
		if _, exists := edge["id"]; !exists {
			edge["id"] = kernel.NewID()
		}
		*connections = append(*connections, edge)
	case "disconnect":
		found := false
		kept := []any{}
		for _, value := range *connections {
			edge, _ := value.(map[string]any)
			if controlString(edge["id"]) == op.ConnectionID {
				found = true
			} else {
				kept = append(kept, value)
			}
		}
		if !found {
			return kernel.NewAppError(http.StatusNotFound, "连接不存在")
		}
		*connections = kept
	case "project":
		if len(op.Patch) == 0 {
			return controlError("缺少画布 patch")
		}
		for key, value := range op.Patch {
			if key != "title" && key != "canvasTitle" {
				return controlError("不支持的画布修改字段: " + key)
			}
			text, ok := value.(string)
			if !ok || strings.TrimSpace(text) == "" || len([]rune(text)) > 240 {
				return controlError("画布名称无效")
			}
			document[key] = text
		}
	default:
		return controlError("不支持的画布操作: " + op.Op)
	}
	return nil
}

func validControlID(id string) bool {
	return strings.TrimSpace(id) == id && id != "" && len(id) <= 160 && !strings.ContainsAny(id, "/\\\x00")
}
func controlNumber(value any, min, max float64) bool {
	number, ok := value.(float64)
	return ok && !math.IsNaN(number) && !math.IsInf(number, 0) && number >= min && number <= max
}
func validateControlNode(node map[string]any) error {
	if text, ok := node["title"].(string); !ok || len([]rune(text)) > 240 {
		return controlError("节点名称无效")
	}
	position, ok := node["position"].(map[string]any)
	if !ok || len(position) != 2 || !controlNumber(position["x"], -1e7, 1e7) || !controlNumber(position["y"], -1e7, 1e7) {
		return controlError("节点 position 必须包含有限的 x/y 坐标")
	}
	if !controlNumber(node["width"], 1, 100000) || !controlNumber(node["height"], 1, 100000) {
		return controlError("节点尺寸无效")
	}
	if parent, exists := node["parentId"]; exists && !validControlID(controlString(parent)) {
		return controlError("parentId 无效")
	}
	if metadata, exists := node["metadata"]; exists {
		if _, ok := metadata.(map[string]any); !ok {
			return controlError("metadata 必须是对象")
		}
	}
	return nil
}
func validateControlMetadata(metadata map[string]any) error {
	for key, value := range metadata {
		if !controlMetadataFields[key] {
			return controlError("不支持的 metadata 字段: " + key)
		}
		if err := rejectControlPrototype(value); err != nil {
			return err
		}
		if value == nil {
			continue
		}
		switch {
		case controlMetadataNumbers[key]:
			if !controlNumber(value, 0, 1e15) {
				return controlError(key + " 必须是非负有限数值")
			}
		case controlMetadataBooleans[key]:
			if _, ok := value.(bool); !ok {
				return controlError(key + " 必须是布尔值")
			}
		case controlMetadataLists[key]:
			values, ok := value.([]any)
			if !ok {
				return controlError(key + " 必须是字符串数组")
			}
			for _, item := range values {
				if _, ok := item.(string); !ok {
					return controlError(key + " 必须是字符串数组")
				}
			}
		case controlMetadataObjects[key]:
			if _, ok := value.(map[string]any); !ok {
				return controlError(key + " 必须是对象")
			}
		default:
			if _, ok := value.(string); !ok {
				return controlError(key + " 必须是字符串")
			}
		}
	}
	return nil
}
func rejectControlPrototype(value any) error {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			if key == "__proto__" || key == "constructor" || key == "prototype" {
				return controlError("无效对象字段")
			}
			if err := rejectControlPrototype(item); err != nil {
				return err
			}
		}
	case []any:
		for _, item := range typed {
			if err := rejectControlPrototype(item); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateControlGraph(nodes, connections []any) error {
	byID := map[string]map[string]any{}
	for _, value := range nodes {
		node, ok := value.(map[string]any)
		if !ok {
			return controlError("节点格式无效")
		}
		id := controlString(node["id"])
		if !validControlID(id) || byID[id] != nil {
			return controlError("节点 ID 无效或重复")
		}
		byID[id] = node
	}
	for id, node := range byID {
		parent := controlString(node["parentId"])
		seen := map[string]bool{id: true}
		for parent != "" {
			if byID[parent] == nil || seen[parent] || controlString(byID[parent]["type"]) != "frame" {
				return controlError("节点 parentId 必须引用无环背板")
			}
			seen[parent] = true
			parent = controlString(byID[parent]["parentId"])
		}
		if err := validateControlReferences(node["metadata"], byID); err != nil {
			return err
		}
	}
	edgeIDs, pairs := map[string]bool{}, map[string]bool{}
	for _, value := range connections {
		edge, ok := value.(map[string]any)
		if !ok {
			return controlError("连接格式无效")
		}
		id, from, to := controlString(edge["id"]), controlString(edge["fromNodeId"]), controlString(edge["toNodeId"])
		if !validControlID(id) || edgeIDs[id] || from == to || byID[from] == nil || byID[to] == nil {
			return controlError("连接 ID 或端点无效")
		}
		pair := from + "\x00" + to + "\x00" + controlString(edge["fromHandleId"]) + "\x00" + controlString(edge["toHandleId"])
		if pairs[pair] {
			return controlError("连接已存在")
		}
		pairs[pair], edgeIDs[id] = true, true
		for _, key := range []string{"fromAnchorRatio", "toAnchorRatio"} {
			if value, exists := edge[key]; exists && !controlNumber(value, 0, 1) {
				return controlError("连接锚点比例无效")
			}
		}
		if relation := controlString(edge["relation"]); relation != "" && relation != "storyboard-output" && relation != "storyboard-asset-reference" && relation != "batch-output" {
			return controlError("连接关系无效")
		}
	}
	return nil
}
func controlReferenceKey(key string) bool {
	if key == "pluginNodeId" {
		return false
	}
	return key == "nodeId" || key == "parentId" || key == "batchRootId" || key == "primaryImageId" || strings.HasSuffix(key, "NodeId")
}
func validateControlReferences(value any, nodes map[string]map[string]any) error {
	switch object := value.(type) {
	case map[string]any:
		for key, item := range object {
			if key == "importSource" || key == "pluginData" || item == nil {
				continue
			}
			if controlReferenceKey(key) && item != nil {
				id, ok := item.(string)
				if !ok || (id != "" && nodes[id] == nil) {
					return controlError("节点引用不存在: " + key)
				}
				if id != "" && (key == "videoStartFrameNodeId" || key == "videoEndFrameNodeId") && controlString(nodes[id]["type"]) != "image" {
					return controlError("首尾帧必须引用图片节点")
				}
			} else if key == "characterViewNodeIds" {
				views, ok := item.(map[string]any)
				if !ok {
					return controlError("characterViewNodeIds 必须是对象")
				}
				for view, ref := range views {
					if view != "front" && view != "side" && view != "back" {
						return controlError("角色视图无效")
					}
					if node := nodes[controlString(ref)]; node == nil || controlString(node["type"]) != "image" {
						return controlError("角色视图必须引用图片节点")
					}
				}
			} else if strings.HasSuffix(key, "NodeIds") || key == "batchChildIds" {
				refs, ok := item.([]any)
				if !ok {
					return controlError(key + " 必须是节点 ID 数组")
				}
				for _, ref := range refs {
					if nodes[controlString(ref)] == nil {
						return controlError("节点引用不存在: " + key)
					}
				}
			} else if err := validateControlReferences(item, nodes); err != nil {
				return err
			}
		}
	case []any:
		for _, item := range object {
			if err := validateControlReferences(item, nodes); err != nil {
				return err
			}
		}
	}
	return nil
}
func removeControlReferences(value any, removedID string) {
	switch object := value.(type) {
	case map[string]any:
		for key, item := range object {
			if key == "importSource" || key == "pluginData" {
				continue
			}
			if controlReferenceKey(key) && controlString(item) == removedID {
				delete(object, key)
			} else if key == "characterViewNodeIds" {
				if views, ok := item.(map[string]any); ok {
					for view, ref := range views {
						if controlString(ref) == removedID {
							delete(views, view)
						}
					}
				}
			} else if strings.HasSuffix(key, "NodeIds") || key == "batchChildIds" {
				if refs, ok := item.([]any); ok {
					kept := []any{}
					for _, ref := range refs {
						if controlString(ref) != removedID {
							kept = append(kept, ref)
						}
					}
					object[key] = kept
				}
			} else {
				removeControlReferences(item, removedID)
			}
		}
	case []any:
		for _, item := range object {
			removeControlReferences(item, removedID)
		}
	}
}
