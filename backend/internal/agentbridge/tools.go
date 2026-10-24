// Package agentbridge defines schemas for the legacy browser bridge.
// Engine clients use the separately authorized native agentops protocol.
package agentbridge

import (
	"strings"

	"qisitv/backend/internal/canvascontract"
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
