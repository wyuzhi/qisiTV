package operations

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

const deliverDocument = `{"id":"canvas","revision":4,"nodes":[{"id":"source","type":"video","title":"成片","metadata":{"resourceId":"media","assetId":"asset"}}],"connections":[],"timeline":{"version":2,"durationMs":2000,"tracks":[{"id":"v","kind":"video"}],"clips":[{"id":"clip","kind":"video","nodeId":"source","trackId":"v","startMs":0,"durationMs":2000}]}}`

type deliverProbe struct {
	unusedDomain
	doc             json.RawMessage
	created         []canvas.CreatedNode
	createdAt       int64
	render          localtask.TimelineRenderCreateRequest
	commits         int
	renderErr       error
	renderAvailable bool
}

func (p *deliverProbe) UserCanvasProject(user, id string) (json.RawMessage, error) {
	if user != "owner" || id != "canvas" {
		return nil, PermissionDenied("foreign_canvas", "foreign")
	}
	return p.doc, nil
}

func (p *deliverProbe) CommitUserCanvasDocument(user, id string, revision int64, raw json.RawMessage) (canvas.UserDataSummary, json.RawMessage, error) {
	var doc map[string]any
	if json.Unmarshal(p.doc, &doc) != nil || canvasRevision(doc) != revision {
		return canvas.UserDataSummary{}, nil, Conflict("revision_conflict", "stale", nil)
	}
	if json.Unmarshal(raw, &doc) != nil {
		return canvas.UserDataSummary{}, nil, Conflict("invalid", "invalid", nil)
	}
	doc["revision"] = float64(revision + 1)
	p.doc, _ = json.Marshal(doc)
	p.commits++
	return canvas.UserDataSummary{Revision: revision + 1}, p.doc, nil
}

func (p *deliverProbe) CreateUserCanvasNodes(user, id string, drafts []canvas.NodeDraft, revision int64) (canvas.UserDataSummary, []canvas.CreatedNode, error) {
	var doc map[string]any
	if json.Unmarshal(p.doc, &doc) != nil || canvasRevision(doc) != revision {
		return canvas.UserDataSummary{}, nil, Conflict("revision_conflict", "stale", nil)
	}
	p.createdAt = revision
	created := make([]canvas.CreatedNode, 0, len(drafts))
	nodes := canvasNodes(doc)
	for _, draft := range drafts {
		node := canvas.CreatedNode{ID: "result-node", Title: draft.Title, Type: draft.Type}
		created = append(created, node)
		nodes = append(nodes, map[string]any{"id": node.ID, "type": node.Type, "title": node.Title, "metadata": map[string]any{}})
	}
	doc["nodes"] = nodes
	doc["revision"] = float64(revision + 1)
	p.doc, _ = json.Marshal(doc)
	p.created = created
	return canvas.UserDataSummary{Revision: revision + 1}, created, nil
}

func (p *deliverProbe) OwnedReadyResource(user, id string) (*model.Resource, error) {
	if user != "owner" || id != "media" {
		return nil, PermissionDenied("foreign_resource", "foreign")
	}
	return &model.Resource{ID: id, MimeType: "video/mp4", DurationMs: 2000}, nil
}

func (p *deliverProbe) OwnedAsset(user, id string) (*model.Asset, error) {
	if user != "owner" || id != "asset" {
		return nil, PermissionDenied("foreign_asset", "foreign")
	}
	return &model.Asset{ID: id, UserID: user, PayloadJSON: `{"resourceId":"media"}`}, nil
}

func (p *deliverProbe) CreateCanvasTimelineRender(user string, req localtask.TimelineRenderCreateRequest) (*model.Task, error) {
	p.render = req
	if p.renderErr != nil {
		return nil, p.renderErr
	}
	return &model.Task{ID: "render-task", Status: model.TaskStatusQueued}, nil
}

func TestTimelineDeliverSavesTimelineCreatesDedupedNodeAndRegistersBinding(t *testing.T) {
	p := &deliverProbe{doc: json.RawMessage(deliverDocument)}
	params := json.RawMessage(`{"canvasId":"canvas","expectedRevision":4,"timeline":{"version":2,"durationMs":2000,"tracks":[{"id":"v","kind":"video"}],"clips":[{"id":"clip","kind":"video","nodeId":"source","trackId":"v","startMs":0,"durationMs":2000}]}}`)
	value, err := opCanvasTimelineDeliver(&Context{UserID: "owner", Domain: p, OperationID: "deliver-op"}, params)
	if err != nil {
		t.Fatal(err)
	}
	result := value.(map[string]any)
	if result["renderTaskId"] != "render-task" || result["resultNodeId"] != "result-node" || result["timelineRevision"] != int64(5) || result["revision"] != int64(6) {
		t.Fatalf("wrong delivery identity: %v", result)
	}
	if result["title"] != "成片 · 2" {
		t.Fatalf("existing title not deduped: %v", result["title"])
	}
	if p.commits != 1 || p.createdAt != 5 {
		t.Fatalf("timeline or node did not use the saved revision: commits=%d nodeRevision=%d", p.commits, p.createdAt)
	}
	if p.render.ProjectID != "canvas" || p.render.TargetNodeID != "result-node" || !strings.HasPrefix(p.render.ClientOperationID, "canvas-deliver:") || p.render.ClientOperationID != canvasDeliveryTaskKey("deliver-op") {
		t.Fatalf("render admission did not register the binding: %+v", p.render)
	}
	if len(p.render.Timeline.Clips) != 1 || p.render.Timeline.Clips[0].DirectMedia == nil || p.render.Timeline.Clips[0].DirectMedia.StorageKey != "resource:media" {
		t.Fatalf("render did not receive the saved canonical timeline: %+v", p.render.Timeline)
	}
	var saved map[string]any
	if err := json.Unmarshal(p.doc, &saved); err != nil {
		t.Fatal(err)
	}
	if canvasRevision(saved) != 6 {
		t.Fatalf("canvas revision after delivery = %d", canvasRevision(saved))
	}
	if len(p.created) != 1 || p.created[0].Type != "video" {
		t.Fatalf("result node = %+v", p.created)
	}
}

func TestTimelineDeliverValidatesModesBeforeWriting(t *testing.T) {
	for _, tc := range []struct {
		name   string
		opID   string
		params string
		reason string
	}{
		{"both", "op", `{"canvasId":"canvas","expectedRevision":4,"timeline":{"version":2},"refreshNodeIds":["source"]}`, "invalid_params"},
		{"null-timeline", "op", `{"canvasId":"canvas","expectedRevision":4,"timeline":null}`, "invalid_params"},
		{"null-refresh", "op", `{"canvasId":"canvas","expectedRevision":4,"refreshNodeIds":null}`, "invalid_params"},
		{"missing-op", "", `{"canvasId":"canvas","expectedRevision":4}`, "invalid_params"},
		{"long-title", "op", `{"canvasId":"canvas","expectedRevision":4,"title":"` + strings.Repeat("长", 121) + `"}`, "invalid_params"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := &deliverProbe{doc: json.RawMessage(deliverDocument)}
			_, err := opCanvasTimelineDeliver(&Context{UserID: "owner", Domain: p, OperationID: tc.opID}, json.RawMessage(tc.params))
			failure := opErrFrom(t, err)
			if failure.Reason != tc.reason {
				t.Fatalf("reason = %q, want %q", failure.Reason, tc.reason)
			}
			if p.commits != 0 || len(p.created) != 0 || p.render.TargetNodeID != "" || string(p.doc) != deliverDocument {
				t.Fatal("invalid delivery changed the canvas")
			}
		})
	}
}

func TestCanvasDeliveryTitleKeepsDedupedTitleWithinLimit(t *testing.T) {
	requested := strings.Repeat("长", 120)
	doc := map[string]any{"nodes": []any{map[string]any{"id": "old", "title": requested}}}
	title := canvasDeliveryTitle(doc, requested)
	if utf8.RuneCountInString(title) != 120 || !strings.HasSuffix(title, " · 2") {
		t.Fatalf("deduped title = %q (%d runes)", title, utf8.RuneCountInString(title))
	}
}

func TestTimelineDeliverWithoutEditRendersSavedTimeline(t *testing.T) {
	p := &deliverProbe{doc: json.RawMessage(deliverDocument)}
	value, err := opCanvasTimelineDeliver(&Context{UserID: "owner", Domain: p, OperationID: "deliver-saved"},
		json.RawMessage(`{"canvasId":"canvas","expectedRevision":4,"title":"终版"}`))
	if err != nil {
		t.Fatal(err)
	}
	result := value.(map[string]any)
	if p.commits != 0 || p.createdAt != 4 || result["title"] != "终版" || result["timelineRevision"] != int64(4) {
		t.Fatalf("saved timeline path wrote an edit or lost the revision: %v", result)
	}
	if len(p.render.Timeline.Clips) != 1 || p.render.Timeline.Clips[0].DirectMedia == nil {
		t.Fatalf("render did not use the saved timeline: %+v", p.render.Timeline)
	}
}

func TestTimelineDeliverRejectsCanvasWithoutTimeline(t *testing.T) {
	p := &deliverProbe{doc: json.RawMessage(`{"id":"canvas","revision":4,"nodes":[],"connections":[]}`)}
	_, err := opCanvasTimelineDeliver(&Context{UserID: "owner", Domain: p, OperationID: "deliver-empty"},
		json.RawMessage(`{"canvasId":"canvas","expectedRevision":4}`))
	if failure := opErrFrom(t, err); failure.Reason != "invalid_timeline" {
		t.Fatalf("reason = %q", failure.Reason)
	}
	if len(p.created) != 0 || p.render.TargetNodeID != "" {
		t.Fatal("missing timeline created a delivery node or task")
	}
}

func TestTimelineDeliverRejectsStaleRevisionWithoutWriting(t *testing.T) {
	p := &deliverProbe{doc: json.RawMessage(deliverDocument)}
	_, err := opCanvasTimelineDeliver(&Context{UserID: "owner", Domain: p, OperationID: "op"},
		json.RawMessage(`{"canvasId":"canvas","expectedRevision":3}`))
	if failure := opErrFrom(t, err); failure.Reason != "revision_conflict" {
		t.Fatalf("reason = %q", failure.Reason)
	}
	if p.commits != 0 || len(p.created) != 0 {
		t.Fatal("stale revision changed the canvas")
	}
}

func TestTimelineDeliverSchemaCarriesSharedTimelineContract(t *testing.T) {
	registry := NewRegistry(nil, nil)
	RegisterDefaultOps(registry)
	descriptor, ok := registry.Descriptor("canvas.timeline.deliver")
	if !ok {
		t.Fatal("canvas.timeline.deliver is not registered")
	}
	var schema map[string]any
	if err := json.Unmarshal(descriptor.Params, &schema); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"oneOf", "anyOf", "allOf"} {
		if _, exists := schema[key]; exists {
			t.Fatalf("root-level %s reaches model tool schema", key)
		}
	}
	properties, _ := schema["properties"].(map[string]any)
	for _, key := range []string{"canvasId", "expectedRevision", "timeline", "refreshNodeIds", "options", "title"} {
		if _, exists := properties[key]; !exists {
			t.Fatalf("property %s missing", key)
		}
	}
	if descriptor.ReadOnly {
		t.Fatal("delivery must stay a write operation")
	}
	for _, mode := range descriptor.AssistantModes {
		if mode == "canvas" {
			t.Fatal("delivery must stay outside the built-in canvas assistant")
		}
	}
}

type allowAllAuthorizer struct{}

func (allowAllAuthorizer) Visible(*Op) bool                  { return true }
func (allowAllAuthorizer) Allows(*Op, json.RawMessage) error { return nil }

func TestTimelineDeliverIsDeniedToAssistantCallers(t *testing.T) {
	registry := NewRegistry(nil, nil)
	RegisterDefaultOps(registry)
	_, err := registry.Execute(Request{
		Op: "canvas.timeline.deliver", OpID: "deliver-assistant", UserID: "owner",
		Caller: AssistantCaller(allowAllAuthorizer{}, false),
		Params: json.RawMessage(`{"canvasId":"canvas","expectedRevision":1}`),
	})
	if failure := opErrFrom(t, err); failure.Reason != "scope_denied" {
		t.Fatalf("reason = %q, want scope_denied", failure.Reason)
	}
}

func opErrFrom(t *testing.T, err error) *Error {
	t.Helper()
	if err == nil {
		t.Fatal("want an error")
	}
	failure, ok := err.(*Error)
	if !ok {
		t.Fatalf("want operation error, got %T", err)
	}
	return failure
}
