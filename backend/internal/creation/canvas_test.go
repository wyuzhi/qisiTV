package creation

import (
	"encoding/json"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestApprovedUpdateDoesNotOverwriteLaterManualEdit(t *testing.T) {
	before := map[string]any{"id": "canvas", "nodes": []any{map[string]any{"id": "n", "type": "text", "title": "before", "metadata": map[string]any{"content": "original"}}}, "connections": []any{}}
	ops := []CanvasOp{{Type: "update_node", ID: "n", Metadata: map[string]any{"content": "approved"}}}
	raw, _ := json.Marshal(before)
	baseline, err := ApprovalBaseline(string(raw), ops)
	if err != nil {
		t.Fatal(err)
	}
	run := &model.CreationRun{ApprovedCanvasJSON: baseline}
	nodes := before["nodes"].([]any)
	nodes[0].(map[string]any)["metadata"] = map[string]any{"content": "later manual edit"}
	afterRaw, _ := json.Marshal(before)
	var after map[string]any
	_ = json.Unmarshal(afterRaw, &after)
	after["nodes"].([]any)[0].(map[string]any)["metadata"] = map[string]any{"content": "approved"}
	if err := ValidateCanvasDiff(nil, "user", run, before, after, ops); err == nil {
		t.Fatal("approved operation overwrote later manual edit")
	}
}

func TestSubmissionScopeRejectsChangedModelSpecAndReferences(t *testing.T) {
	now := time.Now()
	ops := []CanvasOp{{Type: "add_node", ID: "v", NodeType: "video", Metadata: map[string]any{"prompt": "短片", "model": "managed-video", "size": "9:16", "seconds": "15", "referenceNodeIds": []any{"ref"}}}}
	b, _ := json.Marshal(ops)
	run := &model.CreationRun{CanvasID: "canvas", Status: "running", ApprovedProposalVersion: 1, ApprovedProposalHash: "hash", ApprovedOperationsJSON: string(b), ApprovedAt: &now}
	request := TaskRequest{Type: "canvas_video", ProjectID: "canvas", Prompt: "短片", Model: "managed-video", Input: map[string]any{"nodeId": "v", "config": map[string]any{"size": "9:16", "videoSeconds": "15"}, "referenceImages": []any{map[string]any{"id": "ref"}}}}
	if err := ValidateSubmissionScope(run, 1, request); err != nil {
		t.Fatal(err)
	}
	request.Input["config"].(map[string]any)["videoSeconds"] = "5"
	if err := ValidateSubmissionScope(run, 1, request); err == nil {
		t.Fatal("duration silently changed")
	}
	request.Input["config"].(map[string]any)["videoSeconds"] = "15"
	request.Model = "other"
	if err := ValidateSubmissionScope(run, 1, request); err == nil {
		t.Fatal("model changed")
	}
	request.Model = "managed-video"
	request.Input["referenceImages"] = []any{map[string]any{"id": "other"}}
	if err := ValidateSubmissionScope(run, 1, request); err == nil {
		t.Fatal("reference changed")
	}
}

func TestValidateImageHistoryResultWriteChecksAssetOwnership(t *testing.T) {
	h := newHarness(t)
	now := time.Now().UTC()
	for _, resID := range []string{"res-1", "res-2", "res-other"} {
		res := model.Resource{ID: resID, UserID: h.user, Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: resID + ".png", CreatedAt: now, UpdatedAt: now}
		if err := h.db.Create(&res).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, item := range []model.Asset{
		{ID: "asset-1", UserID: h.user, PayloadJSON: `{"id":"asset-1","data":{"storageKey":"resource:res-1"}}`, CreatedAt: now, UpdatedAt: now},
		{ID: "asset-2", UserID: h.user, PayloadJSON: `{"id":"asset-2","data":{"storageKey":"resource:res-2"}}`, CreatedAt: now, UpdatedAt: now},
		{ID: "asset-wrong", UserID: h.user, PayloadJSON: `{"id":"asset-wrong","data":{"storageKey":"resource:res-other"}}`, CreatedAt: now, UpdatedAt: now},
	} {
		if err := h.db.Create(&item).Error; err != nil {
			t.Fatal(err)
		}
	}

	before := map[string]any{
		"assetId":    "asset-1",
		"storageKey": "resource:res-1",
		"content":    "/api/resources/res-1/file",
	}
	validAfter := []any{
		map[string]any{"id": "t1:0", "assetId": "asset-1", "storageKey": "resource:res-1", "content": "/api/resources/res-1/file"},
		map[string]any{"id": "t2:0", "assetId": "asset-2", "storageKey": "resource:res-2", "content": "/api/resources/res-2/file"},
	}
	if err := validateImageHistoryResultWrite(h.repo, h.user, before, validAfter, "resource:res-2", "/api/resources/res-2/file"); err != nil {
		t.Fatalf("expected valid imageHistory result write, got %v", err)
	}

	invalidAssetAfter := []any{
		map[string]any{"id": "t1:0", "assetId": "asset-1", "storageKey": "resource:res-1", "content": "/api/resources/res-1/file"},
		map[string]any{"id": "t2:0", "assetId": "asset-wrong", "storageKey": "resource:res-2", "content": "/api/resources/res-2/file"},
	}
	if err := validateImageHistoryResultWrite(h.repo, h.user, before, invalidAssetAfter, "resource:res-2", "/api/resources/res-2/file"); err == nil {
		t.Fatal("expected mismatched history assetId to be rejected")
	}
}
