package agentbridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"qisitv/backend/internal/canvascontract"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/google/uuid"
)

type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	ReadOnly    bool           `json:"readOnly"`
	Destructive bool           `json:"destructive"`
}

func object(properties map[string]any, required ...string) map[string]any {
	s := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}
func field(kind string) map[string]any { return map[string]any{"type": kind} }
func str() map[string]any              { return map[string]any{"type": "string", "minLength": 1} }
func point() map[string]any {
	return object(map[string]any{"x": field("number"), "y": field("number")}, "x", "y")
}
func nodeSchema() map[string]any {
	properties := nodePatchProperties()
	properties["id"], properties["type"] = str(), map[string]any{"enum": []string{"text", "image", "video", "audio"}}
	return object(properties, "type")
}

func nodePatchProperties() map[string]any {
	return map[string]any{"title": map[string]any{"type": "string", "maxLength": 240}, "position": point(), "width": map[string]any{"type": "number", "minimum": 1, "maximum": 100000}, "height": map[string]any{"type": "number", "minimum": 1, "maximum": 100000}, "parentId": map[string]any{"type": []string{"string", "null"}}, "metadata": metadataSchema()}
}

func metadataSchema() map[string]any {
	properties := map[string]any{}
	for _, key := range strings.Fields(canvascontract.MetadataFields) {
		properties[key] = map[string]any{"type": []string{"string", "null"}}
	}
	for _, key := range strings.Fields(canvascontract.MetadataNumbers) {
		properties[key] = map[string]any{"type": []string{"number", "null"}, "minimum": 0, "maximum": 1e15}
	}
	for _, key := range strings.Fields(canvascontract.MetadataBooleans) {
		properties[key] = map[string]any{"type": []string{"boolean", "null"}}
	}
	for _, key := range strings.Fields(canvascontract.MetadataLists) {
		properties[key] = map[string]any{"type": []string{"array", "null"}, "items": field("string")}
	}
	for _, key := range strings.Fields(canvascontract.MetadataObjects) {
		properties[key] = map[string]any{"type": []string{"object", "null"}}
	}
	for key, description := range map[string]string{
		"content":               "Text body or display media URL. Import local files with asset_import.",
		"storageKey":            "Persistent resource locator such as resource:<id>; must match assetId.",
		"assetId":               "Owned asset ID matching the media resource. asset_import creates both.",
		"model":                 "Exact configured model api_name. Protocol is configured on its channel, not on node metadata.",
		"prompt":                "Draft generation prompt. Editing it alone does not submit a task.",
		"seconds":               "Video UI duration as a string, e.g. 5. Actual task submission uses input.options.videoSeconds.",
		"vquality":              "Video UI resolution as a string, e.g. 720p. Actual task submission uses input.options.vquality.",
		"generateAudio":         "Video UI audio toggle stored as a string. Actual task submission uses input.options.videoGenerateAudio.",
		"videoStartFrameNodeId": "Image node used as the video first frame; use canvas_set_reference for atomic connection and assignment.",
		"videoEndFrameNodeId":   "Image node used as the video last frame; use canvas_set_reference for atomic connection and assignment.",
		"referenceNodeIds":      "Explicit reference node IDs; normal incoming media connections are also available to generation.",
	} {
		properties[key].(map[string]any)["description"] = description
	}
	schema := object(properties)
	schema["description"] = "Editable canvas metadata; flat fields only, no protocol, videoSeconds, videoDuration or generationSettings object. Null removes a field in update patches. These fields edit the canvas; paid execution options belong in task_submit.input.options."
	return schema
}

func batchPatchSchema() map[string]any {
	return map[string]any{"anyOf": []any{object(nodePatchProperties()), object(map[string]any{"title": str(), "canvasTitle": str()})}}
}

func taskOptionsSchema() map[string]any {
	properties := map[string]any{}
	for _, key := range strings.Fields("size quality audioVoice audioFormat audioInstructions systemPrompt") {
		properties[key] = field("string")
	}
	for _, key := range strings.Fields("count videoSeconds audioSpeed") {
		properties[key] = map[string]any{"type": []string{"string", "number"}}
	}
	for _, key := range strings.Fields("transparentBackground videoGenerateAudio videoWatermark") {
		properties[key] = map[string]any{"type": []string{"string", "boolean"}}
	}
	properties["vquality"] = map[string]any{"type": "string", "description": "Video resolution such as 720p; use model_list capabilities."}
	properties["videoSeconds"].(map[string]any)["description"] = "Actual generation duration in seconds, such as 5; verify the selected model supports it and that the user approved this duration."
	properties["providerOptions"] = map[string]any{"type": "object", "description": "Protocol-namespaced extensions, e.g. {\"likeai-video\":{\"kwargs\":{\"off_peak\":true}}}. Configured model defaultOptions are merged into the selected protocol namespace. Never put credentials, headers, model overrides or base URLs here."}
	return object(properties)
}

func Tools() []Tool {
	cid := str()
	revision := map[string]any{"type": "integer", "minimum": 0}
	connection := object(map[string]any{"id": str(), "fromNodeId": str(), "toNodeId": str(), "fromHandleId": field("string"), "toHandleId": field("string"), "relation": map[string]any{"enum": []string{"storyboard-output", "storyboard-asset-reference", "batch-output"}}}, "fromNodeId", "toNodeId")
	return []Tool{
		{"canvas_list", "List canvases in the running local workspace.", object(map[string]any{}), true, false},
		{"canvas_current", "Read the recently active browser tab, selected node IDs and viewport. A null interaction means no fresh active tab.", object(map[string]any{}), true, false},
		{"canvas_get", "Read the current persisted canvas, IDs, nodes, references and revision. Read before a revision-checked edit.", object(map[string]any{"canvasId": cid}, "canvasId"), true, false},
		{"canvas_create", "Create an empty, locally saved canvas. The optional ID must be new.", object(map[string]any{"canvasId": cid, "title": str()}, "title"), false, false},
		{"canvas_add_node", "Add one text/image/video/audio node atomically. Put text or a media URL in metadata.content; use asset_import for local files. Use reference connections to express input relationships.", object(map[string]any{"canvasId": cid, "node": nodeSchema(), "baseRevision": revision}, "canvasId", "node"), false, false},
		{"canvas_update_node", "Patch a node title, position, size or metadata atomically. Existing metadata keys are preserved; null metadata values remove fields. No generation is triggered.", object(map[string]any{"canvasId": cid, "nodeId": str(), "patch": object(nodePatchProperties()), "baseRevision": revision}, "canvasId", "nodeId", "patch"), false, true},
		{"canvas_delete_node", "Remove one node and its connections from the canvas. This does not delete source media files.", object(map[string]any{"canvasId": cid, "nodeId": str(), "baseRevision": revision}, "canvasId", "nodeId"), false, true},
		{"canvas_connect_nodes", "Connect a source/reference node to a target node. Omit relation for a normal reference. For video first/last frames also set the target metadata.videoStartFrameNodeId/videoEndFrameNodeId using canvas_batch_apply. Connecting alone never generates media.", object(map[string]any{"canvasId": cid, "connection": connection, "baseRevision": revision}, "canvasId", "connection"), false, false},
		{"canvas_disconnect", "Remove a connection by its ID.", object(map[string]any{"canvasId": cid, "connectionId": str(), "baseRevision": revision}, "canvasId", "connectionId"), false, true},
		{"canvas_set_reference", "Connect a media source as a reference for a target. role=first-frame or last-frame requires an image source and a video target and atomically sets the target frame field. Existing reference connections are reused. Does not generate media.", object(map[string]any{"canvasId": cid, "sourceNodeId": str(), "targetNodeId": str(), "role": map[string]any{"enum": []string{"reference", "first-frame", "last-frame"}}, "baseRevision": revision}, "canvasId", "sourceNodeId", "targetNodeId", "role"), false, false},
		{"canvas_batch_apply", "Apply add/update/delete/connect/disconnect/project operations atomically. Use multiple update position patches to arrange nodes. For op=project patch accepts title/canvasTitle only. Conflicts are reported without overwriting newer user edits.", object(map[string]any{"canvasId": cid, "baseRevision": revision, "operations": map[string]any{"type": "array", "minItems": 1, "maxItems": 100, "items": object(map[string]any{"op": map[string]any{"enum": []string{"add", "update", "delete", "connect", "disconnect", "project"}}, "node": nodeSchema(), "nodeId": str(), "patch": batchPatchSchema(), "connection": connection, "connectionId": str()}, "op")}}, "canvasId", "operations"), false, true},
		{"canvas_interaction", "Read selected nodes and viewport for a canvas, optionally for one browser tab. Browser interactions expire after 30 seconds.", object(map[string]any{"canvasId": cid, "tabId": str()}, "canvasId"), true, false},
		{"asset_import", "Import an existing local image/video/audio file into this workspace's resource and asset libraries and add a canvas node. Does not call any generation provider. File path must be absolute.", object(map[string]any{"canvasId": cid, "path": str(), "kind": map[string]any{"enum": []string{"image", "video", "audio"}}, "title": field("string"), "nodeId": str(), "position": point(), "width": map[string]any{"type": "integer", "minimum": 0}, "height": map[string]any{"type": "integer", "minimum": 0}, "durationMs": map[string]any{"type": "integer", "minimum": 0}, "baseRevision": revision}, "canvasId", "path", "kind"), false, false},
		{"model_list", "List configured generation models without returning credentials. Does not submit a paid generation task.", object(map[string]any{}), true, false},
		{"task_list", "List local generation tasks and execution status, optionally for a canvas.", object(map[string]any{"canvasId": cid, "activeOnly": field("boolean")}), true, false},
		{"task_get", "Read task status and generated results; does not resubmit or retry a task.", object(map[string]any{"taskId": str()}, "taskId"), true, false},
		{"task_cancel", "Request cancellation of a local generation task. Already submitted provider work may still be billed.", object(map[string]any{"taskId": str()}, "taskId"), false, true},
		{"task_submit", "Submit ONE potentially paid generation task using a configured model. Only call after the user explicitly approves the model, quantity/duration and cost scope. Set consent.approved=true and record that scope; never infer permission from a general video request. Choose a stable idempotencyKey for this authorized request and reuse it only for the same request if recovering a lost response. No automatic retries. Omit input.referenceNodeIds to use existing incoming references/frame fields; explicit [] clears frame references for this submission. input.options contains public model options from model_list. Specify channelId when model names are ambiguous. Credentials must already be configured in qisiTV.", object(map[string]any{"canvasId": cid, "nodeId": str(), "idempotencyKey": map[string]any{"type": "string", "minLength": 1, "maxLength": 160}, "channelId": str(), "type": map[string]any{"enum": []string{"text", "image", "video", "audio"}}, "model": str(), "prompt": str(), "input": object(map[string]any{"referenceNodeIds": map[string]any{"type": "array", "items": str(), "maxItems": canvascontract.MaxGenerationReferenceNodes, "description": "Up to 50 canvas references in total; the selected model applies its own per-media limits."}, "options": taskOptionsSchema()}), "consent": object(map[string]any{"approved": map[string]any{"const": true}, "scope": map[string]any{"type": "string", "minLength": 1, "maxLength": 2000}}, "approved", "scope")}, "canvasId", "type", "model", "prompt", "consent", "idempotencyKey"), false, false},
		{"task_apply_result", "Recover a terminal task's output or failure/cancellation status on its originally bound canvas and target node. Shares the backend's automatic completion path and never resubmits generation. canvasId and optional nodeId must match the original task binding.", object(map[string]any{"canvasId": cid, "taskId": str(), "nodeId": str(), "baseRevision": revision}, "canvasId", "taskId"), false, false},
	}
}

func validate(name string, args map[string]any) error {
	for _, tool := range Tools() {
		if tool.Name == name {
			b, _ := json.Marshal(tool.InputSchema)
			var schema jsonschema.Schema
			if err := json.Unmarshal(b, &schema); err != nil {
				return err
			}
			resolved, err := schema.Resolve(nil)
			if err != nil {
				return err
			}
			if err := resolved.Validate(args); err != nil {
				return fmt.Errorf("invalid %s arguments: %w", name, err)
			}
			return nil
		}
	}
	return fmt.Errorf("unknown tool %q", name)
}

func (c *Client) Call(ctx context.Context, name string, args map[string]any) (map[string]any, error) {
	if args == nil {
		args = map[string]any{}
	}
	if err := validate(name, args); err != nil {
		return nil, err
	}
	switch name {
	case "canvas_list":
		return c.request(ctx, http.MethodGet, "/canvas-projects", nil)
	case "canvas_current":
		return c.request(ctx, http.MethodGet, "/canvas-interaction", nil)
	case "model_list":
		return c.request(ctx, http.MethodGet, "/agent/models", nil)
	case "canvas_create":
		id := stringArg(args, "canvasId")
		if id == "" {
			id = uuid.NewString()
		}
		safe, err := idPath(id)
		if err != nil {
			return nil, err
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		return c.request(ctx, http.MethodPut, "/canvas-projects/"+safe, map[string]any{"project": map[string]any{"id": id, "title": args["title"], "canvasTitle": args["title"], "nodes": []any{}, "connections": []any{}, "viewport": map[string]any{"x": 0, "y": 0, "k": 1}, "revision": 0, "createdAt": now, "updatedAt": now}})
	case "task_list":
		q := url.Values{}
		if id := stringArg(args, "canvasId"); id != "" {
			q.Set("projectId", id)
		}
		if args["activeOnly"] == true {
			q.Set("activeOnly", "true")
		}
		return c.request(ctx, http.MethodGet, "/tasks?"+q.Encode(), nil)
	case "task_get", "task_cancel":
		id, err := idPath(stringArg(args, "taskId"))
		if err != nil {
			return nil, err
		}
		method, path := http.MethodGet, "/tasks/"+id
		if name == "task_cancel" {
			method = http.MethodPost
			path += "/cancel"
		}
		result, err := c.request(ctx, method, path, nil)
		return publicTask(result), err
	case "task_submit":
		if strings.TrimSpace(stringArg(objectArg(args, "consent"), "scope")) == "" {
			return nil, errors.New("consent.scope must describe the user's approved cost scope")
		}
		if hasSecretField(args) {
			return nil, errors.New("do not pass credentials through Agent tools; configure the model in qisiTV")
		}
		result, err := c.request(ctx, http.MethodPost, "/agent/tasks", args)
		return publicTask(result), err
	case "asset_import":
		return c.importAsset(ctx, args)
	case "canvas_set_reference":
		return c.setReference(ctx, args)
	case "task_apply_result":
		return c.applyTaskResult(ctx, args)
	}
	path, err := canvasPath(args)
	if err != nil {
		return nil, err
	}
	if name == "canvas_get" {
		return c.request(ctx, http.MethodGet, path, nil)
	}
	if name == "canvas_interaction" {
		return c.request(ctx, http.MethodGet, path+"/interaction?tabId="+url.QueryEscape(stringArg(args, "tabId")), nil)
	}
	operation := map[string]any{}
	switch name {
	case "canvas_add_node":
		operation = map[string]any{"op": "add", "node": args["node"]}
	case "canvas_update_node":
		operation = map[string]any{"op": "update", "nodeId": args["nodeId"], "patch": args["patch"]}
	case "canvas_delete_node":
		operation = map[string]any{"op": "delete", "nodeId": args["nodeId"]}
	case "canvas_connect_nodes":
		operation = map[string]any{"op": "connect", "connection": args["connection"]}
	case "canvas_disconnect":
		operation = map[string]any{"op": "disconnect", "connectionId": args["connectionId"]}
	case "canvas_batch_apply":
		return c.operations(ctx, path, args, args["operations"])
	default:
		return nil, errors.New("unsupported canvas operation")
	}
	return c.operations(ctx, path, args, []any{operation})
}

func (c *Client) setReference(ctx context.Context, args map[string]any) (map[string]any, error) {
	path, err := canvasPath(args)
	if err != nil {
		return nil, err
	}
	data, err := c.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	project := objectArg(data, "project")
	nodes, _ := project["nodes"].([]any)
	sourceID, targetID := stringArg(args, "sourceNodeId"), stringArg(args, "targetNodeId")
	var source, target map[string]any
	for _, raw := range nodes {
		node, _ := raw.(map[string]any)
		if stringArg(node, "id") == sourceID {
			source = node
		}
		if stringArg(node, "id") == targetID {
			target = node
		}
	}
	if source == nil || target == nil || sourceID == targetID {
		return nil, errors.New("distinct source and target nodes must exist")
	}
	sourceType := stringArg(source, "type")
	role := stringArg(args, "role")
	if sourceType != "image" && sourceType != "video" && sourceType != "audio" {
		return nil, errors.New("reference source must be image, video or audio")
	}
	if role != "reference" && (sourceType != "image" || stringArg(target, "type") != "video") {
		return nil, errors.New("video first/last frame requires an image source and video target")
	}
	ops := []any{}
	connections, _ := project["connections"].([]any)
	connected := false
	for _, raw := range connections {
		connection, _ := raw.(map[string]any)
		if stringArg(connection, "fromNodeId") == sourceID && stringArg(connection, "toNodeId") == targetID {
			connected = true
		}
	}
	if !connected {
		ops = append(ops, map[string]any{"op": "connect", "connection": map[string]any{"fromNodeId": sourceID, "toNodeId": targetID}})
	}
	if role != "reference" {
		key := "videoStartFrameNodeId"
		if role == "last-frame" {
			key = "videoEndFrameNodeId"
		}
		ops = append(ops, map[string]any{"op": "update", "nodeId": targetID, "patch": map[string]any{"metadata": map[string]any{key: sourceID}}})
	}
	if len(ops) == 0 {
		return map[string]any{"project": project, "alreadyConnected": true}, nil
	}
	if _, provided := args["baseRevision"]; !provided {
		args["baseRevision"] = project["revision"]
	}
	return c.operations(ctx, path, args, ops)
}

func (c *Client) operations(ctx context.Context, path string, args map[string]any, operations any) (map[string]any, error) {
	payload := map[string]any{"operations": operations}
	if revision, ok := args["baseRevision"]; ok {
		payload["baseRevision"] = revision
	}
	return c.request(ctx, http.MethodPost, path+"/operations", payload)
}

func hasSecretField(value any) bool {
	switch v := value.(type) {
	case map[string]any:
		for k, item := range v {
			normalized := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(k, "_", ""), "-", ""))
			if normalized == "apikey" || normalized == "secretkey" || normalized == "authorization" || normalized == "cookie" || normalized == "token" || normalized == "accesstoken" || normalized == "bearertoken" || normalized == "headers" || normalized == "credentials" || normalized == "password" || normalized == "config" {
				return true
			}
			if hasSecretField(item) {
				return true
			}
		}
	case []any:
		for _, item := range v {
			if hasSecretField(item) {
				return true
			}
		}
	}
	return false
}
