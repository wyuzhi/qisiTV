package operations_test

import (
	"encoding/json"
	"testing"

	"qisitv/backend/internal/operations"
)

func externalCaller(clientID, label string) operations.Caller {
	caller := operations.ExternalCaller(false)
	caller.ClientID = clientID
	caller.ClientLabel = label
	return caller
}

func decodeWrites(t *testing.T, result operations.Result) []operations.ExternalCanvasWrite {
	t.Helper()
	raw, err := json.Marshal(result.Result)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Writes []operations.ExternalCanvasWrite `json:"writes"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Writes
}

func TestExternalWriteListAndUndoRespectClientOwnership(t *testing.T) {
	h := newHarness(t)
	codex := externalCaller("codex-cli", "Codex CLI")
	other := externalCaller("other-client", "Other Client")

	updated, err := h.execute(t, codex, "canvas.node.update", "ext-op-1", map[string]any{
		"canvasId":         h.canvasID,
		"nodeId":           "n1",
		"expectedRevision": h.revisionNow(t),
		"patch":            map[string]any{"title": "Codex 修改"},
	})
	if err != nil {
		t.Fatal(err)
	}

	listed, err := h.execute(t, codex, "canvas.external.write.list", "", map[string]any{"canvasId": h.canvasID})
	if err != nil {
		t.Fatalf("list external writes: %v", err)
	}
	writes := decodeWrites(t, listed)
	if len(writes) != 1 || writes[0].OpID != "ext-op-1" || writes[0].ClientID != "codex-cli" {
		t.Fatalf("unexpected external writes: %+v", writes)
	}

	// 其他外部客户端不能撤销 codex 的改动。
	_, err = h.execute(t, other, "canvas.external.write.undo", "undo-foreign", map[string]any{
		"canvasId":  h.canvasID,
		"writeOpId": "ext-op-1",
	})
	if got := opErr(t, err); got.Code != operations.CodePermissionDenied || got.Reason != "permission_denied" {
		t.Fatalf("foreign external client undo must be rejected, got %+v", got)
	}

	// 外部身份但没有客户端标识时没有归属可核对，不能放行撤销。
	_, err = h.execute(t, operations.ExternalCaller(false), "canvas.external.write.undo", "undo-anonymous", map[string]any{
		"canvasId":  h.canvasID,
		"writeOpId": "ext-op-1",
	})
	if got := opErr(t, err); got.Code != operations.CodePermissionDenied {
		t.Fatalf("external client without id must not undo, got %+v", got)
	}

	// 只读客户端连撤销都不能调用。
	_, err = h.execute(t, operations.ExternalCaller(true), "canvas.external.write.undo", "undo-readonly", map[string]any{
		"canvasId":  h.canvasID,
		"writeOpId": "ext-op-1",
	})
	if got := opErr(t, err); got.Code != operations.CodeReadOnly {
		t.Fatalf("read-only client undo must be rejected, got %+v", got)
	}

	undone, err := h.execute(t, codex, "canvas.external.write.undo", "undo-op-1", map[string]any{
		"canvasId":  h.canvasID,
		"writeOpId": "ext-op-1",
	})
	if err != nil {
		t.Fatalf("undo own write: %v", err)
	}
	payload, _ := undone.Result.(map[string]any)
	if payload["undone"] != true || undone.Revision <= updated.Revision {
		t.Fatalf("unexpected undo result: %#v (revision %d)", payload, undone.Revision)
	}

	// 撤销本身不能再记成一次外部写入。
	listedAfter, err := h.execute(t, codex, "canvas.external.write.list", "", map[string]any{"canvasId": h.canvasID})
	if err != nil {
		t.Fatal(err)
	}
	writesAfter := decodeWrites(t, listedAfter)
	if len(writesAfter) != 1 || !writesAfter[0].Undone || writesAfter[0].Op != "canvas.node.update" {
		t.Fatalf("undo must not create a new external write: %+v", writesAfter)
	}

	replayed, err := h.execute(t, codex, "canvas.external.write.undo", "undo-op-1", map[string]any{
		"canvasId":  h.canvasID,
		"writeOpId": "ext-op-1",
	})
	if err != nil || !replayed.Replayed {
		t.Fatalf("same operationId must replay the undo result: %+v (err=%v)", replayed, err)
	}

	// 换一个新 operationId 再撤销同一次写入，必须明确说明已经撤销，不能重复回滚画布。
	_, err = h.execute(t, codex, "canvas.external.write.undo", "undo-op-2", map[string]any{
		"canvasId":  h.canvasID,
		"writeOpId": "ext-op-1",
	})
	if got := opErr(t, err); got.Code != operations.CodeConflict || got.Reason != "already_undone" {
		t.Fatalf("second undo must report already_undone, got %+v", got)
	}
}

func TestExternalWriteUndoRefusesWhenCanvasChangedAfterWrite(t *testing.T) {
	h := newHarness(t)
	codex := externalCaller("codex-cli", "Codex CLI")

	first, err := h.execute(t, codex, "canvas.node.update", "ext-conflict-1", map[string]any{
		"canvasId":         h.canvasID,
		"nodeId":           "n1",
		"expectedRevision": h.revisionNow(t),
		"patch":            map[string]any{"title": "外部修改"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.execute(t, operations.ManualCaller(false), "canvas.node.update", "manual-touch-1", map[string]any{
		"canvasId":         h.canvasID,
		"nodeId":           "n1",
		"expectedRevision": first.Revision,
		"patch":            map[string]any{"title": "之后又改"},
	}); err != nil {
		t.Fatal(err)
	}

	_, err = h.execute(t, codex, "canvas.external.write.undo", "undo-conflict", map[string]any{
		"canvasId":  h.canvasID,
		"writeOpId": "ext-conflict-1",
	})
	if got := opErr(t, err); got.Code != operations.CodeConflict || got.Reason != "canvas_changed_since_write" {
		t.Fatalf("expected canvas_changed_since_write, got %+v", got)
	}
}

func TestOwnerCanUndoLatestExternalWrite(t *testing.T) {
	h := newHarness(t)
	codex := externalCaller("codex-cli", "Codex CLI")
	if _, err := h.execute(t, codex, "canvas.node.update", "ext-owner-undo", map[string]any{
		"canvasId":         h.canvasID,
		"nodeId":           "n1",
		"expectedRevision": h.revisionNow(t),
		"patch":            map[string]any{"title": "外部修改"},
	}); err != nil {
		t.Fatal(err)
	}
	result, err := h.execute(t, operations.ManualCaller(false), "canvas.external.write.undo", "owner-undo-latest", map[string]any{
		"canvasId":  h.canvasID,
		"writeOpId": "latest",
	})
	if err != nil {
		t.Fatalf("owner undo latest: %v", err)
	}
	payload, _ := result.Result.(map[string]any)
	if payload["undone"] != true || payload["opId"] != "ext-owner-undo" {
		t.Fatalf("unexpected owner undo result: %#v", payload)
	}
}
