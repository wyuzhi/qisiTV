package operations_test

import (
	"context"
	"encoding/json"
	"testing"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/operations"
)

func TestExternalWritePersistenceSurgicalUndoAndDesktopExclusion(t *testing.T) {
	h := newHarness(t)
	store := operations.NewStore(h.service.Database())

	extCaller := operations.ExternalCaller(false)
	extCaller.ClientID = "codex-cli"
	extCaller.ClientLabel = "Codex CLI"

	rev0 := h.revisionNow(t)
	res, err := h.execute(t, extCaller, "canvas.node.update", "ext-op-1", map[string]any{
		"canvasId":         h.canvasID,
		"nodeId":           "n1",
		"expectedRevision": rev0,
		"patch":            map[string]any{"title": "Codex 新标题"},
	})
	if err != nil {
		t.Fatalf("external update failed: %v", err)
	}

	var rec model.AgentOpRecord
	if err := h.service.Database().Where("user_id = ? AND op_id = ?", h.userID, "ext-op-1").First(&rec).Error; err != nil {
		t.Fatalf("load op record: %v", err)
	}
	if rec.CallerKind != "external" || rec.ClientID != "codex-cli" || rec.ClientLabel != "Codex CLI" {
		t.Fatalf("unexpected caller metadata on op record: %+v", rec)
	}

	writes, err := store.ListExternalCanvasWrites(h.userID, h.canvasID)
	if err != nil {
		t.Fatalf("list external writes: %v", err)
	}
	if len(writes) != 1 {
		t.Fatalf("expected 1 external write, got %d: %+v", len(writes), writes)
	}
	if writes[0].OpID != "ext-op-1" || writes[0].ClientLabel != "Codex CLI" || writes[0].RevisionBefore != rev0 || writes[0].RevisionAfter != res.Revision {
		t.Fatalf("unexpected external write entry: %+v", writes[0])
	}
	if len(writes[0].UpdatedNodeIDs) != 1 || writes[0].UpdatedNodeIDs[0] != "n1" || writes[0].Undone {
		t.Fatalf("unexpected updated nodes in external write: %+v", writes[0])
	}

	// Desktop UI manual save on unrelated node n2 should not appear in external writes,
	// and should not block surgical undo of ext-op-1 on node n1.
	desktopCaller := operations.ManualCaller(false)
	desktopCaller.ClientID = "desktop-ui"
	desktopCaller.ClientLabel = "桌面端"
	if _, err := h.execute(t, desktopCaller, "canvas.node.update", "desktop-op-2", map[string]any{
		"canvasId":         h.canvasID,
		"nodeId":           "n2",
		"expectedRevision": res.Revision,
		"patch":            map[string]any{"title": "桌面改镜头2"},
	}); err != nil {
		t.Fatalf("desktop update failed: %v", err)
	}

	writesAfterDesktop, err := store.ListExternalCanvasWrites(h.userID, h.canvasID)
	if err != nil {
		t.Fatalf("list external writes after desktop save: %v", err)
	}
	if len(writesAfterDesktop) != 1 {
		t.Fatalf("desktop-ui save must not be listed as external write, got %+v", writesAfterDesktop)
	}

	// Internal manual caller (e.g. task_binding) must also not be listed as an external write.
	if _, err := h.execute(t, operations.ManualCaller(false), "canvas.node.update", "internal-manual-op", map[string]any{
		"canvasId":         h.canvasID,
		"nodeId":           "n2",
		"expectedRevision": h.revisionNow(t),
		"patch":            map[string]any{"title": "桌面改镜头2"},
	}); err != nil {
		t.Fatalf("internal manual update failed: %v", err)
	}
	writesAfterInternal, err := store.ListExternalCanvasWrites(h.userID, h.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	if len(writesAfterInternal) != 1 {
		t.Fatalf("internal manual save must not be listed as external write, got %+v", writesAfterInternal)
	}

	// Foreign external client cannot undo codex-cli's write.
	if _, err := store.UndoExternalCanvasWrite(context.Background(), h.service, h.userID, h.canvasID, "ext-op-1", "other-client-id"); err == nil {
		t.Fatal("expected foreign external client undo to be rejected")
	}

	undoRes, err := store.UndoExternalCanvasWrite(context.Background(), h.service, h.userID, h.canvasID, "ext-op-1", "codex-cli")
	if err != nil {
		t.Fatalf("surgical undo failed: %v", err)
	}
	if undoRes.OpID != "ext-op-1" || !undoRes.Undone || undoRes.Revision <= res.Revision {
		t.Fatalf("unexpected undo result: %+v", undoRes)
	}

	doc := editDocument(t, h)
	nodes := doc["nodes"].([]any)
	nodeTitles := map[string]string{}
	for _, raw := range nodes {
		m := raw.(map[string]any)
		nodeTitles[m["id"].(string)], _ = m["title"].(string)
	}
	if nodeTitles["n1"] != "镜头1" {
		t.Fatalf("expected n1 title restored to 镜头1, got %q", nodeTitles["n1"])
	}
	if nodeTitles["n2"] != "桌面改镜头2" {
		t.Fatalf("expected unrelated node n2 edit preserved as 桌面改镜头2, got %q", nodeTitles["n2"])
	}

	writesAfterUndo, err := store.ListExternalCanvasWrites(h.userID, h.canvasID)
	if err != nil {
		t.Fatalf("list external writes after undo: %v", err)
	}
	if len(writesAfterUndo) != 1 || !writesAfterUndo[0].Undone || writesAfterUndo[0].UndoneRevision != undoRes.Revision {
		t.Fatalf("expected write marked undone, got %+v", writesAfterUndo)
	}
}

func TestExternalWriteUndoRejectsWhenTouchedNodeModifiedLater(t *testing.T) {
	h := newHarness(t)
	store := operations.NewStore(h.service.Database())

	extCaller := operations.ExternalCaller(false)
	extCaller.ClientID = "beeftv-cli"
	extCaller.ClientLabel = "beeftv CLI"

	first, err := h.execute(t, extCaller, "canvas.node.update", "ext-conflict-1", map[string]any{
		"canvasId":         h.canvasID,
		"nodeId":           "n1",
		"expectedRevision": h.revisionNow(t),
		"patch":            map[string]any{"title": "第一次外部修改"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.execute(t, operations.ManualCaller(false), "canvas.node.update", "manual-touch-n1", map[string]any{
		"canvasId":         h.canvasID,
		"nodeId":           "n1",
		"expectedRevision": first.Revision,
		"patch":            map[string]any{"title": "后续覆盖修改"},
	}); err != nil {
		t.Fatal(err)
	}

	_, err = store.UndoExternalCanvasWrite(context.Background(), h.service, h.userID, h.canvasID, "ext-conflict-1")
	if got := opErr(t, err); got.Code != operations.CodeConflict || got.Reason != "canvas_changed_since_write" {
		t.Fatalf("expected canvas_changed_since_write conflict, got %+v (err=%v)", got, err)
	}
}

func TestStaleRevisionConflictDetailsIncludeModifiedNodes(t *testing.T) {
	h := newHarness(t)
	staleRev := h.revisionNow(t)

	extCaller := operations.ExternalCaller(false)
	extCaller.ClientID = "beeftv-mcp"
	extCaller.ClientLabel = "BeefTV MCP"

	updated, err := h.execute(t, extCaller, "canvas.node.update", "ext-advance-rev", map[string]any{
		"canvasId":         h.canvasID,
		"nodeId":           "n1",
		"expectedRevision": staleRev,
		"patch":            map[string]any{"title": "MCP 修改后"},
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = h.execute(t, extCaller, "canvas.node.update", "ext-stale-write", map[string]any{
		"canvasId":         h.canvasID,
		"nodeId":           "n2",
		"expectedRevision": staleRev,
		"patch":            map[string]any{"title": "过期写入"},
	})
	got := opErr(t, err)
	if got.Code != operations.CodeConflict || got.Reason != "stale_revision" {
		t.Fatalf("expected stale_revision conflict, got %+v", got)
	}
	if got.Details == nil {
		t.Fatalf("expected conflict details populated, got nil")
	}
	rawDetails, err := json.Marshal(got.Details)
	if err != nil {
		t.Fatal(err)
	}
	var details struct {
		CurrentRevision  int64                      `json:"currentRevision"`
		ExpectedRevision int64                      `json:"expectedRevision"`
		ModifiedNodeIDs  []string                   `json:"modifiedNodeIds"`
		ModifiedNodes    []operations.CanvasNodeRef `json:"modifiedNodes"`
	}
	if err := json.Unmarshal(rawDetails, &details); err != nil {
		t.Fatal(err)
	}
	if details.CurrentRevision != updated.Revision || details.ExpectedRevision != staleRev {
		t.Fatalf("unexpected revision details: %+v", details)
	}
	if len(details.ModifiedNodeIDs) != 1 || details.ModifiedNodeIDs[0] != "n1" {
		t.Fatalf("expected modifiedNodeIds=[n1], got %+v", details)
	}
	if len(details.ModifiedNodes) != 1 || details.ModifiedNodes[0].ID != "n1" {
		t.Fatalf("expected modifiedNodes to include n1, got %+v", details.ModifiedNodes)
	}
}
