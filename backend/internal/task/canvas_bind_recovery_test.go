package task

import (
	"encoding/json"
	"errors"
	"testing"

	"qisitv/backend/internal/model"
)

func TestNewCanvasBindRefusalKeepsTheRefusingRevision(t *testing.T) {
	details := func(revision any) map[string]any {
		return map[string]any{"canvasBinding": map[string]any{"revision": revision}}
	}
	for _, revision := range []any{int64(7), float64(7), json.Number("7")} {
		marker, ok := NewCanvasBindRefusal("node-1", 2, "node_task_mismatch", details(revision))
		if !ok || marker.Revision != 7 || marker.NodeID != "node-1" || marker.OutputIndex != 2 {
			t.Fatalf("revision %T: ok=%v marker=%+v", revision, ok, marker)
		}
	}
	if _, ok := NewCanvasBindRefusal("node-1", 0, "node_deleted", map[string]any{}); ok {
		t.Fatal("node refusal without revision must not be recorded")
	}
	if marker, ok := NewCanvasBindRefusal("node-1", 0, "canvas_mismatch", nil); !ok || marker.Revision != 0 {
		t.Fatalf("task-decided refusal needs no revision: ok=%v marker=%+v", ok, marker)
	}
	if _, ok := NewCanvasBindRefusal("node-1", 0, "delivery_unreadable", nil); ok {
		t.Fatal("non-terminal reasons must not be recorded")
	}
}

func TestCanvasBindRefusalStillRefusedOnlyWhileCanvasUnchanged(t *testing.T) {
	revision := func(value int64, err error) func() (int64, error) {
		return func() (int64, error) { return value, err }
	}
	node := CanvasBindRecoveryTarget{NodeID: "n", Reason: "node_task_mismatch", Revision: 5}
	if !node.StillRefused(revision(5, nil)) {
		t.Fatal("same revision must skip")
	}
	if node.StillRefused(revision(6, nil)) {
		t.Fatal("any canvas write must retry")
	}
	if node.StillRefused(revision(5, errors.New("db down"))) {
		t.Fatal("unknown revision must retry")
	}
	if (CanvasBindRecoveryTarget{NodeID: "n", Reason: "node_deleted"}).StillRefused(revision(5, nil)) {
		t.Fatal("node marker without revision must retry")
	}
	if !(CanvasBindRecoveryTarget{NodeID: "n", Reason: "canvas_mismatch"}).StillRefused(func() (int64, error) {
		t.Fatal("task-decided refusal must not read the canvas")
		return 0, nil
	}) {
		t.Fatal("task-decided refusal must skip")
	}
}

func TestCanvasBindRecoveryOutcomeClearsWhenEmpty(t *testing.T) {
	var state CanvasBindRecovery
	if outcome, err := state.Outcome(); err != nil || outcome != nil {
		t.Fatalf("empty markers must clear the column: %v %v", outcome, err)
	}
	state.Upsert(CanvasBindRecoveryTarget{NodeID: "n", Reason: "canvas_mismatch"})
	outcome, err := state.Outcome()
	if err != nil || outcome == nil {
		t.Fatalf("markers must encode: %v %v", outcome, err)
	}
	if decoded, ok := DecodeCanvasBindRecovery(outcome); !ok || len(decoded.Targets) != 1 {
		t.Fatalf("round trip failed: %+v %v", decoded, ok)
	}
}

func TestCanvasBindPassClearsLegacyAndUnlistedMarkers(t *testing.T) {
	legacy := `canvas_bind:{"version":2,"targets":[{"nodeId":"n","outputIndex":0,"reason":"node_task_mismatch"}]}`
	pass := NewCanvasBindPass(&legacy)
	if pass.Skip("n", 0, func() (int64, error) { return 1, nil }) {
		t.Fatal("legacy marker must not skip")
	}
	if marker, changed, err := pass.Finish(); err != nil || !changed || marker != nil {
		t.Fatalf("legacy marker must be cleared: %v %v %v", marker, changed, err)
	}

	state := CanvasBindRecovery{}
	state.Upsert(CanvasBindRecoveryTarget{NodeID: "gone", Reason: "canvas_mismatch"})
	state.Upsert(CanvasBindRecoveryTarget{NodeID: "kept", Reason: "canvas_mismatch"})
	raw, _ := EncodeCanvasBindRecovery(state)
	pass = NewCanvasBindPass(raw)
	if !pass.Skip("kept", 0, nil) {
		t.Fatal("task-decided refusal must skip")
	}
	marker, changed, err := pass.Finish()
	decoded, _ := DecodeCanvasBindRecovery(marker)
	if err != nil || !changed || len(decoded.Targets) != 1 || decoded.Targets[0].NodeID != "kept" {
		t.Fatalf("unlisted target must be dropped: %+v %v %v", decoded, changed, err)
	}

	quiet := NewCanvasBindPass(nil)
	quiet.Skip("n", 0, nil)
	quiet.Bound("n", 0)
	if _, changed, _ := quiet.Finish(); changed {
		t.Fatal("a pass with nothing to record must not write")
	}
}

func TestCanvasBindNodeIDUsesFrozenOutputDestinations(t *testing.T) {
	multi := model.Task{ID: "t", Type: "canvas_image", Model: "gpt-image-2", InputJSON: `{"metadata":{"nodeId":"root","outputNodeIds":["root"," child-1 ",""]}}`}
	for index, want := range []string{"root", "child-1", "", ""} {
		if got := CanvasBindNodeID(multi, index, "root"); got != want {
			t.Fatalf("output %d -> %q, want %q", index, got, want)
		}
	}
	single := model.Task{ID: "t", Type: "canvas_text", InputJSON: `{"metadata":{"nodeId":"text-node"}}`}
	if got := CanvasBindNodeID(single, 0, "text-node"); got != "text-node" {
		t.Fatalf("tasks without frozen outputs keep the fallback: %q", got)
	}
}

func TestTaskCanvasIDsAndMissingDistinguishCanvasFromProjectTasks(t *testing.T) {
	ownedProject := func(id string) (bool, error) { return id == "proj-1", nil }

	textTask := model.Task{ID: "t-text", ProjectID: "canvas-1", Type: "canvas_text", InputJSON: `{"metadata":{"nodeId":"node-1"}}`}
	if ids, err := TaskCanvasIDs(textTask, nil, ownedProject); err != nil || len(ids) != 1 || ids[0] != "canvas-1" {
		t.Fatalf("text task canvas IDs = %v err = %v", ids, err)
	}
	if missing, err := TaskCanvasMissing(textTask, nil, ownedProject, func(id string) (bool, error) { return false, nil }); err != nil || !missing {
		t.Fatalf("missing canvas must report missing=true: missing=%v err=%v", missing, err)
	}
	if missing, err := TaskCanvasMissing(textTask, nil, ownedProject, func(id string) (bool, error) { return true, nil }); err != nil || missing {
		t.Fatalf("existing canvas must report missing=false: missing=%v err=%v", missing, err)
	}

	seedreamTask := model.Task{ID: "t-seedream", ProjectID: "canvas-seedream", Type: "canvas_image", Model: "channel::dola-seedream-5-0-pro-260628", InputJSON: `{"metadata":{"nodeId":"root"}}`}
	if ids, err := TaskCanvasIDs(seedreamTask, nil, ownedProject); err != nil || len(ids) != 1 || ids[0] != "canvas-seedream" {
		t.Fatalf("seedream task canvas IDs = %v err = %v", ids, err)
	}

	canvasWorkflowTask := model.Task{ID: "t-wf-canvas", ProjectID: "canvas-wf", Type: "canvas_video", InputJSON: `{"metadata":{"workflowStepId":"step-1","domainProjectId":"proj-1","canvasId":"canvas-wf"}}`}
	if ids, err := TaskCanvasIDs(canvasWorkflowTask, nil, ownedProject); err != nil || len(ids) != 1 || ids[0] != "canvas-wf" {
		t.Fatalf("canvas workflow task canvas IDs = %v err = %v", ids, err)
	}

	canvasWorkflowWithoutDomain := model.Task{ID: "t-wf-canvas-2", ProjectID: "canvas-wf", Type: "canvas_video", InputJSON: `{"metadata":{"workflowStepId":"step-1"}}`}
	if ids, err := TaskCanvasIDs(canvasWorkflowWithoutDomain, nil, ownedProject); err != nil || len(ids) != 1 || ids[0] != "canvas-wf" {
		t.Fatalf("canvas workflow task without domainProjectId canvas IDs = %v err = %v", ids, err)
	}

	projectWorkflowTask := model.Task{ID: "t-wf-proj", ProjectID: "proj-1", Type: "canvas_video", InputJSON: `{"metadata":{"workflowStepId":"step-1","domainProjectId":"proj-1"}}`}
	if ids, err := TaskCanvasIDs(projectWorkflowTask, nil, ownedProject); err != nil || len(ids) != 0 {
		t.Fatalf("short-drama project workflow task must not require a canvas: %v err=%v", ids, err)
	}
	projectWorkflowImplicit := model.Task{ID: "t-wf-proj-implicit", ProjectID: "proj-1", Type: "canvas_video", InputJSON: `{"metadata":{"workflowStepId":"step-1"}}`}
	if ids, err := TaskCanvasIDs(projectWorkflowImplicit, nil, ownedProject); err != nil || len(ids) != 0 {
		t.Fatalf("implicit short-drama project workflow task must not require a canvas: %v err=%v", ids, err)
	}

	characterTurnaroundTask := model.Task{
		ID: "t-turnaround", ProjectID: "proj-1", Type: "canvas_image",
		InputJSON: `{"nodeId":"character-turnaround:asset-1","metadata":{"operation":"character_turnaround","characterAssetId":"asset-1"}}`,
	}
	if ids, err := TaskCanvasIDs(characterTurnaroundTask, []CanvasBindingIntent{{TaskID: "t-turnaround", OutputIndex: 0, TargetBinding: &TargetBinding{NodeID: "character-turnaround:asset-1"}}}, ownedProject); err != nil || len(ids) != 0 {
		t.Fatalf("character turnaround project task with pseudo nodeId must not require a canvas: %v err=%v", ids, err)
	}

	chapterExtractTask := model.Task{
		ID: "t-chapter", ProjectID: "proj-1", Type: "canvas_text",
		InputJSON: `{"nodeId":"chapter_assets_extract:chapter-1","metadata":{"domainProjectId":"proj-1","chapterId":"chapter-1","operation":"chapter_assets_extract"}}`,
	}
	if ids, err := TaskCanvasIDs(chapterExtractTask, nil, ownedProject); err != nil || len(ids) != 0 {
		t.Fatalf("chapter extraction project task with pseudo nodeId must not require a canvas: %v err=%v", ids, err)
	}

	ownedPseudoNodeTask := model.Task{
		ID: "t-owned-pseudo", ProjectID: "proj-1", Type: "canvas_image",
		InputJSON: `{"metadata":{"nodeId":"pseudo-node","canvasId":"stale-canvas"}}`,
	}
	if ids, err := TaskCanvasIDs(ownedPseudoNodeTask, nil, ownedProject); err != nil || len(ids) != 0 {
		t.Fatalf("owned business project task with pseudo nodeId must not require a canvas: %v err=%v", ids, err)
	}

	if missing, err := TaskCanvasMissing(projectWorkflowImplicit, nil, ownedProject, func(string) (bool, error) {
		t.Fatal("non-canvas task must not query canvasExists")
		return false, nil
	}); err != nil || missing {
		t.Fatalf("non-canvas task reported missing=%v err=%v", missing, err)
	}

	messageOnly := model.Task{ID: "t-msg", Type: "canvas_text", InputJSON: `{"metadata":{"conversationId":"conv-1","messageId":"msg-1"}}`}
	if ids, err := TaskCanvasIDs(messageOnly, nil, func(string) (bool, error) {
		t.Fatal("message-only task must not query isOwnedProject")
		return false, nil
	}); err != nil || len(ids) != 0 {
		t.Fatalf("message-only task canvas IDs = %v err = %v", ids, err)
	}
	if got := MessageBindTargets(messageOnly, nil); len(got) != 1 || got[0].ConversationID != "conv-1" || got[0].MessageID != "msg-1" {
		t.Fatalf("message bind targets = %+v", got)
	}
}
