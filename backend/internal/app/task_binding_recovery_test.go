package app

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"qisitv/backend/internal/conversation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/operations"
	localtask "qisitv/backend/internal/task"
)

func TestCanvasBindRecoveryStopsTerminalFailuresAndResumesWhenNodeReturns(t *testing.T) {
	t.Run("normal binding", func(t *testing.T) {
		svc, canvasID, revision := newAssistantTurnService(t)
		task := seedCanvasBindRecoveryTask(t, svc, canvasID, revision, "bind-normal", "node-normal", "bind-normal")

		if err := svc.recoverCanvasTaskBindings(task); err != nil {
			t.Fatal(err)
		}
		stored, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.RecoveryOutcome != nil {
			t.Fatalf("successful bind left recovery marker: %q", *stored.RecoveryOutcome)
		}
		meta := canvasBindTestNodeMetadata(t, svc, canvasID, "node-normal")
		if meta["content"] != "正常绑定" {
			t.Fatalf("normal bind content = %#v", meta["content"])
		}
	})

	t.Run("switched task resumes after re-point", func(t *testing.T) {
		svc, canvasID, revision := newAssistantTurnService(t)
		task := seedCanvasBindRecoveryTask(t, svc, canvasID, revision, "bind-switched", "node-switched", "other-task")

		if err := svc.recoverCanvasTaskBindings(task); err != nil {
			t.Fatal(err)
		}
		stored, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		marker, ok := localtask.DecodeCanvasBindRecovery(stored.RecoveryOutcome)
		if !ok || len(marker.Targets) != 1 || marker.Targets[0].Reason != "node_task_mismatch" || marker.Targets[0].Revision != canvasBindTestRevision(t, svc, canvasID) {
			t.Fatalf("mismatch marker = %#v, raw=%v", marker, stored.RecoveryOutcome)
		}

		// A second recovery pass must not call canvas.task.bind again while the
		// node still points at the same newer task.
		beforeRetryBinds := canvasBindTraceCount(t, svc)
		if err := svc.recoverCanvasTaskBindings(*stored); err != nil {
			t.Fatal(err)
		}
		if got := canvasBindTraceCount(t, svc); got != beforeRetryBinds {
			t.Fatalf("unchanged mismatch retried canvas.bind: before=%d after=%d", beforeRetryBinds, got)
		}
		still, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if still.RecoveryOutcome == nil || *still.RecoveryOutcome != *stored.RecoveryOutcome {
			var after string
			if still.RecoveryOutcome != nil {
				after = *still.RecoveryOutcome
			}
			t.Fatalf("unchanged mismatch marker was rewritten: before=%q after=%q", *stored.RecoveryOutcome, after)
		}

		setCanvasBindTestNodeTaskID(t, svc, canvasID, "node-switched", task.ID)
		beforeResumeBinds := canvasBindTraceCount(t, svc)
		if err := svc.recoverCanvasTaskBindings(*still); err != nil {
			t.Fatal(err)
		}
		if got := canvasBindTraceCount(t, svc); got != beforeResumeBinds+1 {
			t.Fatalf("re-pointed node did not retry canvas.bind exactly once: before=%d after=%d", beforeResumeBinds, got)
		}
		final, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if final.RecoveryOutcome != nil {
			t.Fatalf("re-pointed node kept terminal marker: %q", *final.RecoveryOutcome)
		}
		meta := canvasBindTestNodeMetadata(t, svc, canvasID, "node-switched")
		if meta["content"] != "节点换回后绑定" {
			t.Fatalf("re-pointed bind content = %#v", meta["content"])
		}
	})

	t.Run("deleted node resumes after recreation", func(t *testing.T) {
		svc, canvasID, revision := newAssistantTurnService(t)
		task := seedCanvasBindRecoveryTask(t, svc, canvasID, revision, "bind-deleted", "node-deleted", "bind-deleted")
		removeCanvasBindTestNode(t, svc, canvasID, "node-deleted")

		if err := svc.recoverCanvasTaskBindings(task); err != nil {
			t.Fatal(err)
		}
		stored, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		marker, ok := localtask.DecodeCanvasBindRecovery(stored.RecoveryOutcome)
		if !ok || len(marker.Targets) != 1 || marker.Targets[0].Reason != "node_deleted" || marker.Targets[0].Revision != canvasBindTestRevision(t, svc, canvasID) {
			t.Fatalf("deleted marker = %#v, raw=%v", marker, stored.RecoveryOutcome)
		}

		before := *stored.RecoveryOutcome
		beforeRetryBinds := canvasBindTraceCount(t, svc)
		if err := svc.recoverCanvasTaskBindings(*stored); err != nil {
			t.Fatal(err)
		}
		if got := canvasBindTraceCount(t, svc); got != beforeRetryBinds {
			t.Fatalf("unchanged deleted node retried canvas.bind: before=%d after=%d", beforeRetryBinds, got)
		}
		still, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if still.RecoveryOutcome == nil || *still.RecoveryOutcome != before {
			t.Fatalf("deleted-node marker changed before recreation: before=%q after=%v", before, still.RecoveryOutcome)
		}

		addCanvasBindTestNode(t, svc, canvasID, "node-deleted", task.ID)
		beforeResumeBinds := canvasBindTraceCount(t, svc)
		if err := svc.recoverCanvasTaskBindings(*still); err != nil {
			t.Fatal(err)
		}
		if got := canvasBindTraceCount(t, svc); got != beforeResumeBinds+1 {
			t.Fatalf("recreated node did not retry canvas.bind exactly once: before=%d after=%d", beforeResumeBinds, got)
		}
		final, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if final.RecoveryOutcome != nil {
			t.Fatalf("recreated node kept terminal marker: %q", *final.RecoveryOutcome)
		}
		meta := canvasBindTestNodeMetadata(t, svc, canvasID, "node-deleted")
		if meta["content"] != "节点重建后绑定" {
			t.Fatalf("recreated bind content = %#v", meta["content"])
		}
	})
}

func canvasBindTraceCount(t *testing.T, svc *Service) int {
	t.Helper()
	recorder := svc.SupportTrace()
	if recorder == nil {
		return 0
	}
	snapshot, err := recorder.Snapshot("local", time.Unix(0, 0), time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, event := range snapshot.Events {
		if event.Name == "canvas.bind" && event.Phase == "start" {
			count++
		}
	}
	return count
}

func TestCanvasBindRecoveryUsesFailureSnapshot(t *testing.T) {
	svc, canvasID, revision := newAssistantTurnService(t)
	task := seedCanvasBindRecoveryTask(t, svc, canvasID, revision, "bind-race", "node-race", "other-task")
	failedAt := canvasBindTestRevision(t, svc, canvasID)
	// The canvas moves on after the refusal. The marker must keep the revision
	// the failed bind read, not the current one, or that write would be missed.
	setCanvasBindTestNodeTaskID(t, svc, canvasID, "node-race", task.ID)

	err := &operations.Error{Reason: "node_task_mismatch", Details: map[string]any{
		"canvasBinding": map[string]any{"nodePresent": true, "nodeTaskId": "other-task", "revision": failedAt},
	}}
	reason, details := canvasBindRefusal(err)
	marker, ok := localtask.NewCanvasBindRefusal("node-race", 0, reason, details)
	if !ok || marker.Revision != failedAt {
		t.Fatalf("marker did not preserve failed transaction revision: ok=%v marker=%+v want=%d", ok, marker, failedAt)
	}
	if marker.StillRefused(svc.canvasRevision(task)) {
		t.Fatal("write after refusal was not detected")
	}

	missing := &operations.Error{Reason: "node_task_mismatch", Details: map[string]any{"canvasBinding": map[string]any{"nodePresent": true}}}
	if _, ok := localtask.NewCanvasBindRefusal("node-race", 0, missing.Reason, missing.Details); ok {
		t.Fatal("refusal without a revision must not be recorded")
	}
}

func TestCanvasBindRecoveryRetriesPendingVideoAfterClientOperationRestored(t *testing.T) {
	svc, canvasID, revision := newAssistantTurnService(t)
	now := time.Now()
	operationID := "operation-video-pending"
	resource := model.Resource{ID: "res-pending-video", UserID: "local", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 128, CreatedAt: now, UpdatedAt: now}
	asset := model.Asset{ID: "asset-pending-video", UserID: "local", PayloadJSON: `{"data":{"storageKey":"resource:res-pending-video"}}`, CreatedAt: now, UpdatedAt: now}
	task := model.Task{
		ID: "bind-video-pending", UserID: "local", ProjectID: canvasID, Type: "canvas_video", Status: model.TaskStatusSucceeded,
		ClientOperationID: &operationID, InputJSON: `{"metadata":{"source":"canvas","nodeId":"node-video-pending"}}`,
		ResultJSON: `{"mode":"video","video":{"resourceId":"res-pending-video","storageKey":"resource:res-pending-video"}}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	output := localtask.CanonicalOutput{OutputIndex: 0, MediaType: "video", MaterializedAssetID: asset.ID, ResourceID: resource.ID, ProviderArtifactRef: "resource:" + resource.ID}
	payload, err := localtask.EncodeOutputPayload(output)
	if err != nil {
		t.Fatal(err)
	}
	result := model.Result{ID: "result-pending-video", UserID: "local", TaskID: task.ID, Kind: "generation_output", Payload: payload, CreatedAt: now}
	for _, item := range []any{&resource, &asset, &task, &result} {
		if err := svc.Database().Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	canvasDoc, err := json.Marshal(map[string]any{
		"id": canvasID, "title": "视频待绑定", "revision": revision,
		"nodes": []any{map[string]any{
			"id": "node-video-pending", "type": "video",
			"metadata": map[string]any{"taskClientOperationId": "operation-other"},
		}}, "connections": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertUserCanvasProject("local", canvasDoc); err != nil {
		t.Fatal(err)
	}
	if err := svc.recoverCanvasTaskBindings(task); err != nil {
		t.Fatal(err)
	}
	stored, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if marker, ok := localtask.DecodeCanvasBindRecovery(stored.RecoveryOutcome); !ok || len(marker.Targets) != 1 {
		t.Fatalf("pending video with another operation id did not record a marker: %v", stored.RecoveryOutcome)
	}
	beforeRetryBinds := canvasBindTraceCount(t, svc)
	if err := svc.recoverCanvasTaskBindings(*stored); err != nil {
		t.Fatal(err)
	}
	if got := canvasBindTraceCount(t, svc); got != beforeRetryBinds {
		t.Fatalf("unchanged canvas retried canvas.bind: before=%d after=%d", beforeRetryBinds, got)
	}

	// Only the client operation id comes back; the task id stays empty.
	setCanvasBindTestNodeMetadata(t, svc, canvasID, "node-video-pending", map[string]any{"taskClientOperationId": operationID})
	if err := svc.recoverCanvasTaskBindings(*stored); err != nil {
		t.Fatal(err)
	}
	final, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.RecoveryOutcome != nil {
		t.Fatalf("restored pending video kept recovery marker: %q", *final.RecoveryOutcome)
	}
	if meta := canvasBindTestNodeMetadata(t, svc, canvasID, "node-video-pending"); meta["taskId"] != task.ID {
		t.Fatalf("restored pending video did not bind: %#v", meta)
	}
}

func TestCanvasBindRecoveryRetriesLegacyMarkers(t *testing.T) {
	// #25 wrote versions 1-3 without a revision. Each must lead to a retry,
	// never a permanent skip.
	for _, legacy := range []string{
		`canvas_bind:{"version":1,"targets":[{"nodeId":"node-legacy","outputIndex":0,"reason":"node_task_mismatch","nodeTaskId":"other-task"}]}`,
		`canvas_bind:{"version":2,"targets":[{"nodeId":"node-legacy","outputIndex":0,"reason":"node_task_mismatch","nodePresent":true,"nodeTaskId":"other-task"}]}`,
		`canvas_bind:{"version":3,"targets":[{"nodeId":"node-legacy","outputIndex":0,"reason":"node_deleted","nodePresent":false,"nodeHasBindingOccupancy":false}]}`,
	} {
		svc, canvasID, revision := newAssistantTurnService(t)
		task := seedCanvasBindRecoveryTask(t, svc, canvasID, revision, "bind-legacy", "node-legacy", "bind-legacy")
		if err := svc.Database().Model(&model.Task{}).Where("id = ?", task.ID).Update("recovery_outcome", legacy).Error; err != nil {
			t.Fatal(err)
		}
		stored, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err := svc.recoverCanvasTaskBindings(*stored); err != nil {
			t.Fatal(err)
		}
		if meta := canvasBindTestNodeMetadata(t, svc, canvasID, "node-legacy"); meta["content"] != "节点重建后绑定" {
			t.Fatalf("legacy marker %s blocked the bind: %#v", legacy, meta)
		}
		if cleared, err := svc.repo.Task(task.ID); err != nil || cleared.RecoveryOutcome != nil {
			t.Fatalf("legacy marker %s was not cleared after the bind: %v %v", legacy, cleared.RecoveryOutcome, err)
		}
	}

	// A current-format node marker without a revision must not skip either.
	marker := localtask.CanvasBindRecoveryTarget{NodeID: "node-legacy", Reason: "node_task_mismatch"}
	svc, canvasID, _ := newAssistantTurnService(t)
	if marker.StillRefused(svc.canvasRevision(model.Task{UserID: "local", ProjectID: canvasID})) {
		t.Fatal("revision-less node marker skipped")
	}
}

func TestCanvasBindRecoveryRetriesOnceAfterUnrelatedEdit(t *testing.T) {
	svc, canvasID, revision := newAssistantTurnService(t)
	task := seedCanvasBindRecoveryTask(t, svc, canvasID, revision, "bind-unrelated", "node-unrelated", "other-task")
	if err := svc.recoverCanvasTaskBindings(task); err != nil {
		t.Fatal(err)
	}
	stored, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	// An edit that does not touch the node still moves the revision: one retry,
	// then the scanner is quiet again until the next edit.
	addCanvasBindTestNode(t, svc, canvasID, "node-elsewhere", "")
	before := canvasBindTraceCount(t, svc)
	for pass := 0; pass < 3; pass++ {
		current, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err := svc.recoverCanvasTaskBindings(*current); err != nil {
			t.Fatal(err)
		}
	}
	if got := canvasBindTraceCount(t, svc); got != before+1 {
		t.Fatalf("unrelated edit retried %d times, want 1", got-before)
	}
	final, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	marker, ok := localtask.DecodeCanvasBindRecovery(final.RecoveryOutcome)
	if !ok || len(marker.Targets) != 1 || marker.Targets[0].Revision != canvasBindTestRevision(t, svc, canvasID) {
		t.Fatalf("retry did not refresh marker revision: %#v (stored=%v)", marker, stored.RecoveryOutcome)
	}
}

func TestCanvasBindRecoveryBindsAfterVideoContentCleared(t *testing.T) {
	svc, canvasID, revision := newAssistantTurnService(t)
	now := time.Now()
	operationID := "operation-video"
	resource := model.Resource{ID: "res-recovery-video", UserID: "local", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 128, CreatedAt: now, UpdatedAt: now}
	asset := model.Asset{ID: "asset-recovery-video", UserID: "local", PayloadJSON: `{"data":{"storageKey":"resource:res-recovery-video"}}`, CreatedAt: now, UpdatedAt: now}
	task := model.Task{
		ID: "bind-video-content", UserID: "local", ProjectID: canvasID, Type: "canvas_video", Status: model.TaskStatusSucceeded,
		ClientOperationID: &operationID, InputJSON: `{"metadata":{"source":"canvas","nodeId":"node-video-content"}}`,
		ResultJSON: `{"mode":"video","video":{"resourceId":"res-recovery-video","storageKey":"resource:res-recovery-video"}}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	output := localtask.CanonicalOutput{OutputIndex: 0, MediaType: "video", MaterializedAssetID: asset.ID, ResourceID: resource.ID, ProviderArtifactRef: "resource:" + resource.ID}
	payload, err := localtask.EncodeOutputPayload(output)
	if err != nil {
		t.Fatal(err)
	}
	result := model.Result{ID: "result-recovery-video", UserID: "local", TaskID: task.ID, Kind: "generation_output", Payload: payload, CreatedAt: now}
	for _, item := range []any{&resource, &asset, &task, &result} {
		if err := svc.Database().Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	canvasDoc, err := json.Marshal(map[string]any{
		"id": canvasID, "title": "视频恢复", "revision": revision,
		"nodes": []any{map[string]any{
			"id": "node-video-content", "type": "video",
			"metadata": map[string]any{"taskClientOperationId": operationID, "content": "existing-result"},
		}}, "connections": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertUserCanvasProject("local", canvasDoc); err != nil {
		t.Fatal(err)
	}
	if err := svc.recoverCanvasTaskBindings(task); err != nil {
		t.Fatal(err)
	}
	stored, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	marker, ok := localtask.DecodeCanvasBindRecovery(stored.RecoveryOutcome)
	if !ok || len(marker.Targets) != 1 || marker.Targets[0].Revision <= 0 {
		t.Fatalf("occupied video marker = %#v, raw=%v", marker, stored.RecoveryOutcome)
	}

	setCanvasBindTestNodeMetadata(t, svc, canvasID, "node-video-content", map[string]any{
		"taskClientOperationId": operationID, "content": "",
	})
	if err := svc.recoverCanvasTaskBindings(*stored); err != nil {
		t.Fatal(err)
	}
	final, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.RecoveryOutcome != nil {
		t.Fatalf("cleared video occupancy kept recovery marker: %q", *final.RecoveryOutcome)
	}
	meta := canvasBindTestNodeMetadata(t, svc, canvasID, "node-video-content")
	if meta["taskId"] != task.ID || meta["content"] != "/api/resources/"+resource.ID+"/file" {
		t.Fatalf("cleared video occupancy did not bind: %#v", meta)
	}
}

func seedCanvasBindRecoveryTask(t *testing.T, svc *Service, canvasID string, revision int64, taskID, nodeID, nodeTaskID string) model.Task {
	t.Helper()
	now := time.Now()
	task := model.Task{
		ID: taskID, UserID: "local", ProjectID: canvasID, Type: "canvas_text",
		Status: model.TaskStatusSucceeded, Stage: "任务完成", Prompt: "绑定测试",
		InputJSON:  `{"mode":"text","metadata":{"source":"canvas","nodeId":"` + nodeID + `"}}`,
		ResultJSON: `{"mode":"text","text":"` + bindTestText(taskID) + `"}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := svc.Database().Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(map[string]any{
		"id": canvasID, "title": "绑定恢复测试", "revision": revision,
		"nodes": []any{map[string]any{
			"id": nodeID, "type": "text", "title": "文本", "metadata": map[string]any{"taskId": nodeTaskID},
		}}, "connections": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	return task
}

func bindTestText(taskID string) string {
	switch taskID {
	case "bind-normal":
		return "正常绑定"
	case "bind-switched":
		return "节点换回后绑定"
	default:
		return "节点重建后绑定"
	}
}

func canvasBindTestRevision(t *testing.T, svc *Service, canvasID string) int64 {
	t.Helper()
	project, err := svc.repo.CanvasProjectMetadata("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	return project.Revision
}

func canvasBindTestDocument(t *testing.T, svc *Service, canvasID string) map[string]any {
	t.Helper()
	raw, err := svc.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func canvasBindTestNodeMetadata(t *testing.T, svc *Service, canvasID, nodeID string) map[string]any {
	t.Helper()
	doc := canvasBindTestDocument(t, svc, canvasID)
	for _, rawNode := range doc["nodes"].([]any) {
		node := rawNode.(map[string]any)
		if node["id"] == nodeID {
			return node["metadata"].(map[string]any)
		}
	}
	t.Fatalf("node %q not found", nodeID)
	return nil
}

func setCanvasBindTestNodeTaskID(t *testing.T, svc *Service, canvasID, nodeID, taskID string) {
	t.Helper()
	doc := canvasBindTestDocument(t, svc, canvasID)
	for _, rawNode := range doc["nodes"].([]any) {
		node := rawNode.(map[string]any)
		if node["id"] == nodeID {
			node["metadata"].(map[string]any)["taskId"] = taskID
		}
	}
	saveCanvasBindTestDocument(t, svc, doc)
}

func setCanvasBindTestNodeMetadata(t *testing.T, svc *Service, canvasID, nodeID string, metadata map[string]any) {
	t.Helper()
	doc := canvasBindTestDocument(t, svc, canvasID)
	for _, rawNode := range doc["nodes"].([]any) {
		node := rawNode.(map[string]any)
		if node["id"] == nodeID {
			node["metadata"] = metadata
		}
	}
	saveCanvasBindTestDocument(t, svc, doc)
}

func removeCanvasBindTestNode(t *testing.T, svc *Service, canvasID, nodeID string) {
	t.Helper()
	doc := canvasBindTestDocument(t, svc, canvasID)
	nodes := doc["nodes"].([]any)[:0]
	for _, rawNode := range doc["nodes"].([]any) {
		if rawNode.(map[string]any)["id"] != nodeID {
			nodes = append(nodes, rawNode)
		}
	}
	doc["nodes"] = nodes
	saveCanvasBindTestDocument(t, svc, doc)
}

func addCanvasBindTestNode(t *testing.T, svc *Service, canvasID, nodeID, taskID string) {
	t.Helper()
	doc := canvasBindTestDocument(t, svc, canvasID)
	doc["nodes"] = append(doc["nodes"].([]any), map[string]any{
		"id": nodeID, "type": "text", "title": "重建文本", "metadata": map[string]any{"taskId": taskID},
	})
	saveCanvasBindTestDocument(t, svc, doc)
}

func saveCanvasBindTestDocument(t *testing.T, svc *Service, doc map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertUserCanvasProject("local", encoded); err != nil {
		t.Fatal(err)
	}
}

func TestCanvasBindRecoveryNeverOverwritesMediaRecoveryConclusions(t *testing.T) {
	svc, canvasID, revision := newAssistantTurnService(t)
	task := seedCanvasBindRecoveryTask(t, svc, canvasID, revision, "bind-conclusion", "node-conclusion", "other-task")
	conclusion := "no_result"
	stamp := time.Now().Add(-time.Hour).Round(time.Second)
	if err := svc.Database().Model(&model.Task{}).Where("id = ?", task.ID).UpdateColumns(map[string]any{"recovery_outcome": conclusion, "updated_at": stamp}).Error; err != nil {
		t.Fatal(err)
	}
	stored, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.recoverCanvasTaskBindings(*stored); err != nil {
		t.Fatal(err)
	}
	after, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.RecoveryOutcome == nil || *after.RecoveryOutcome != conclusion {
		t.Fatalf("canvas marker overwrote the recovery conclusion: %v", after.RecoveryOutcome)
	}
	if !after.UpdatedAt.Equal(stamp) {
		t.Fatalf("scanner marker changed updated_at: %v -> %v", stamp, after.UpdatedAt)
	}
}

func TestCanvasBindRecoveryMarkerDoesNotTouchUpdatedAt(t *testing.T) {
	svc, canvasID, revision := newAssistantTurnService(t)
	task := seedCanvasBindRecoveryTask(t, svc, canvasID, revision, "bind-stamp", "node-stamp", "other-task")
	stamp := time.Now().Add(-time.Hour).Round(time.Second)
	if err := svc.Database().Model(&model.Task{}).Where("id = ?", task.ID).UpdateColumn("updated_at", stamp).Error; err != nil {
		t.Fatal(err)
	}
	stored, _ := svc.repo.Task(task.ID)
	if err := svc.recoverCanvasTaskBindings(*stored); err != nil {
		t.Fatal(err)
	}
	after, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := localtask.DecodeCanvasBindRecovery(after.RecoveryOutcome); !ok {
		t.Fatalf("refusal marker missing: %v", after.RecoveryOutcome)
	}
	if !after.UpdatedAt.Equal(stamp) {
		t.Fatalf("scanner marker changed updated_at: %v -> %v", stamp, after.UpdatedAt)
	}
}

func restoreDeletedTestCanvas(t *testing.T, svc *Service, raw []byte) {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	doc["revision"] = 0
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertUserCanvasProject("local", encoded); err != nil {
		t.Fatal(err)
	}
}

func TestCanvasBindRecoverySkipsDeletedCanvasAndResumesOnRestore(t *testing.T) {
	t.Run("normal text task with marker, media conclusion, and message attach", func(t *testing.T) {
		svc, canvasID, revision := newAssistantTurnService(t)
		db := svc.Database()
		now := time.Now()
		convPayload, err := json.Marshal(map[string]any{
			"id":        "conv-deleted-canvas",
			"title":     "画布删除对话",
			"updatedAt": "2026-10-02T00:00:00.000Z",
			"messages": []any{
				map[string]any{"id": "user-1", "role": "user", "content": "生成文案", "mode": "text"},
				map[string]any{
					"id": "msg-deleted-canvas", "role": "assistant", "mode": "text", "content": "", "status": "pending",
					"taskIds": []any{"bind-deleted-canvas-text"},
				},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		conversations := conversation.New(conversation.NewStore(svc.repo))
		if _, err := conversations.Put("local", "conv-deleted-canvas", 0, convPayload); err != nil {
			t.Fatal(err)
		}

		// Seed with a conflicting node taskId first so recovery writes a canvas_bind: refusal marker.
		task := seedCanvasBindRecoveryTask(t, svc, canvasID, revision, "bind-deleted-canvas-text", "node-text", "other-task")
		if err := svc.recoverCanvasTaskBindings(task); err != nil {
			t.Fatal(err)
		}
		stored, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := localtask.DecodeCanvasBindRecovery(stored.RecoveryOutcome); !ok {
			t.Fatalf("expected refusal marker before canvas delete, got %v", stored.RecoveryOutcome)
		}

		// Attach a conversation/message target before deleting the canvas so the deleted-canvas pass exercises conversation.message.attach.
		stored.InputJSON = `{"mode":"text","metadata":{"source":"canvas","nodeId":"node-text","conversationId":"conv-deleted-canvas","messageId":"msg-deleted-canvas"}}`
		if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("input_json", stored.InputJSON).Error; err != nil {
			t.Fatal(err)
		}

		// Prepare the restored canvas document with the matching taskId before deleting the canvas.
		setCanvasBindTestNodeTaskID(t, svc, canvasID, "node-text", task.ID)
		savedCanvas, err := svc.UserCanvasProject("local", canvasID)
		if err != nil {
			t.Fatal(err)
		}
		if err := svc.CanvasService().DeleteUserCanvasProject("local", canvasID); err != nil {
			t.Fatal(err)
		}

		beforeBinds := canvasBindTraceCount(t, svc)
		if err := svc.recoverCanvasTaskBindings(*stored); err != nil {
			t.Fatalf("deleted canvas returned scan error: %v", err)
		}
		if got := canvasBindTraceCount(t, svc); got != beforeBinds {
			t.Fatalf("deleted canvas called canvas.bind: before=%d after=%d", beforeBinds, got)
		}
		cleared, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if cleared.RecoveryOutcome != nil {
			t.Fatalf("deleted canvas did not clear stale canvas_bind marker: %v", *cleared.RecoveryOutcome)
		}
		convRow, err := conversations.Get("local", "conv-deleted-canvas")
		if err != nil {
			t.Fatal(err)
		}
		var convDoc map[string]any
		if err := json.Unmarshal(convRow.Document, &convDoc); err != nil {
			t.Fatal(err)
		}
		messages, _ := convDoc["messages"].([]any)
		msg, _ := messages[1].(map[string]any)
		if msg["status"] != "done" || msg["content"] != "节点重建后绑定" {
			t.Fatalf("deleted canvas skipped conversation.message.attach: %#v", msg)
		}

		// Media recovery conclusions (no_result / unrecoverable) must be preserved on a deleted canvas without touching updated_at.
		for _, conclusion := range []string{"no_result", "unrecoverable"} {
			stamp := now.Add(-2 * time.Hour).Round(time.Second)
			if err := db.Model(&model.Task{}).Where("id = ?", task.ID).UpdateColumns(map[string]any{"recovery_outcome": conclusion, "updated_at": stamp}).Error; err != nil {
				t.Fatal(err)
			}
			withConclusion, err := svc.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if err := svc.recoverCanvasTaskBindings(*withConclusion); err != nil {
				t.Fatalf("deleted canvas with %s returned error: %v", conclusion, err)
			}
			afterConclusion, err := svc.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if afterConclusion.RecoveryOutcome == nil || *afterConclusion.RecoveryOutcome != conclusion {
				t.Fatalf("deleted canvas overwrote %s conclusion: %v", conclusion, afterConclusion.RecoveryOutcome)
			}
			if !afterConclusion.UpdatedAt.Equal(stamp) {
				t.Fatalf("deleted canvas with %s touched updated_at: %v -> %v", conclusion, stamp, afterConclusion.UpdatedAt)
			}
		}
		if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("recovery_outcome", nil).Error; err != nil {
			t.Fatal(err)
		}
		readyTask, err := svc.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}

		restoreDeletedTestCanvas(t, svc, savedCanvas)
		if err := svc.recoverCanvasTaskBindings(*readyTask); err != nil {
			t.Fatalf("restored canvas failed to bind: %v", err)
		}
		if got := canvasBindTraceCount(t, svc); got != beforeBinds+1 {
			t.Fatalf("restored canvas bind count = %d, want %d", got, beforeBinds+1)
		}
		meta := canvasBindTestNodeMetadata(t, svc, canvasID, "node-text")
		if meta["content"] != "节点重建后绑定" {
			t.Fatalf("restored canvas node content = %#v", meta["content"])
		}
	})

	t.Run("seedream multi-output task", func(t *testing.T) {
		svc, canvasID, revision := newAssistantTurnService(t)
		db := svc.Database()
		now := time.Now()
		task := model.Task{
			ID: "bind-deleted-canvas-seedream", UserID: "local", ProjectID: canvasID,
			Type: "canvas_image", Model: "channel::dola-seedream-5-0-pro-260628",
			Status: model.TaskStatusSucceeded, InputJSON: `{"metadata":{"nodeId":"root"}}`,
			CreatedAt: now, UpdatedAt: now, CompletedAt: &now,
		}
		images := []map[string]any{}
		for i := 0; i < 3; i++ {
			id := fmt.Sprintf("deleted-seedream-res-%d", i)
			if err := db.Create(&model.Resource{
				ID: id, UserID: "local", Kind: "image", MimeType: "image/png",
				Status: model.ResourceStatusReady, Width: 512, Height: 512, Size: 100,
				CreatedAt: now, UpdatedAt: now,
			}).Error; err != nil {
				t.Fatal(err)
			}
			images = append(images, map[string]any{"resourceId": id, "storageKey": "resource:" + id})
		}
		resultBytes, _ := json.Marshal(map[string]any{"images": images})
		task.ResultJSON = string(resultBytes)
		if err := db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
		if err := svc.generationDeliverer().Deliver(task); err != nil {
			t.Fatal(err)
		}
		savedCanvas, err := json.Marshal(map[string]any{
			"id": canvasID, "title": "Seedream 删除恢复", "revision": revision,
			"nodes": []any{map[string]any{
				"id": "root", "type": "image", "position": map[string]any{"x": 0, "y": 0},
				"metadata": map[string]any{"taskId": task.ID},
			}},
			"connections": []any{},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := svc.UpsertUserCanvasProject("local", savedCanvas); err != nil {
			t.Fatal(err)
		}
		if err := svc.CanvasService().DeleteUserCanvasProject("local", canvasID); err != nil {
			t.Fatal(err)
		}

		beforeBinds := canvasBindTraceCount(t, svc)
		if err := svc.recoverCanvasTaskBindings(task); err != nil {
			t.Fatalf("deleted canvas seedream task returned scan error: %v", err)
		}
		if got := canvasBindTraceCount(t, svc); got != beforeBinds {
			t.Fatalf("deleted canvas seedream task called canvas.bind: before=%d after=%d", beforeBinds, got)
		}

		restoreDeletedTestCanvas(t, svc, savedCanvas)
		if err := svc.recoverCanvasTaskBindings(task); err != nil {
			t.Fatalf("restored canvas seedream task failed to bind: %v", err)
		}
		doc := canvasBindTestDocument(t, svc, canvasID)
		nodes := doc["nodes"].([]any)
		if len(nodes) != 3 {
			t.Fatalf("restored seedream canvas got %d nodes, want 3", len(nodes))
		}
		for i, rawNode := range nodes {
			node := rawNode.(map[string]any)
			meta := node["metadata"].(map[string]any)
			if node["id"] != localtask.SeedreamOutputNodeID(task, i) || meta["storageKey"] != fmt.Sprintf("resource:deleted-seedream-res-%d", i) {
				t.Fatalf("restored seedream output %d bound improperly: %#v", i, node)
			}
		}
	})

	t.Run("workflow task on deleted canvas and non-canvas project workflow task", func(t *testing.T) {
		svc, canvasID, revision := newAssistantTurnService(t)
		db := svc.Database()
		now := time.Now()
		project := model.Project{ID: "drama-proj-1", UserID: "local", Name: "短剧项目", Status: model.ProjectStatusActive, Revision: 1, CreatedAt: now, UpdatedAt: now}
		unit := model.ProjectUnit{ID: "drama-unit-1", ProjectID: project.ID, Kind: model.ProjectUnitKindChapter, Title: "第一章", Status: model.ProjectUnitStatusDraft, CreatedAt: now, UpdatedAt: now}
		if err := db.Create(&project).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&unit).Error; err != nil {
			t.Fatal(err)
		}
		if err := svc.EnsureBuiltinProjectWorkflowTemplate(); err != nil {
			t.Fatal(err)
		}
		workflow, err := svc.ProjectService().CreateUnitWorkflow("local", project.ID, unit.ID)
		if err != nil {
			t.Fatal(err)
		}
		var videoStep model.WorkflowStepInstance
		for _, step := range workflow.Steps {
			if step.StepKey == "video" {
				videoStep = step
			}
		}
		shot, err := svc.ProjectService().CreateProjectShot("local", project.ID, CreateProjectShotRequest{
			UnitID: unit.ID, Title: "SC.01", Description: "镜头一", DurationMs: 3000,
		})
		if err != nil {
			t.Fatal(err)
		}
		resCanvas := model.Resource{ID: "res-wf-canvas", UserID: "local", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 256, CreatedAt: now, UpdatedAt: now}
		resProject := model.Resource{ID: "res-wf-project", UserID: "local", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 256, CreatedAt: now, UpdatedAt: now}
		if err := db.Create(&resCanvas).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&resProject).Error; err != nil {
			t.Fatal(err)
		}

		// 1) Workflow task bound to a canvas node (without explicit domainProjectId so it relies on canvas.ProjectID).
		canvasInput, _ := json.Marshal(map[string]any{
			"metadata": map[string]any{
				"source":         "canvas",
				"nodeId":         "node-wf-video",
				"workflowStepId": videoStep.ID,
				"unitId":         unit.ID,
				"shotId":         shot.ID,
				"artifactType":   "video",
				"role":           "output",
			},
		})
		canvasTask := model.Task{
			ID: "bind-deleted-canvas-wf", UserID: "local", ProjectID: canvasID,
			Type: "canvas_video", Status: model.TaskStatusSucceeded,
			InputJSON:  string(canvasInput),
			ResultJSON: `{"mode":"video","video":{"resourceId":"res-wf-canvas","storageKey":"resource:res-wf-canvas"}}`,
			CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
		}
		if err := db.Create(&canvasTask).Error; err != nil {
			t.Fatal(err)
		}
		if err := svc.generationDeliverer().Deliver(canvasTask); err != nil {
			t.Fatal(err)
		}
		savedCanvas, _ := json.Marshal(map[string]any{
			"id": canvasID, "projectId": project.ID, "title": "工作流画布", "revision": revision,
			"nodes": []any{map[string]any{
				"id": "node-wf-video", "type": "video",
				"metadata": map[string]any{"taskId": canvasTask.ID},
			}},
			"connections": []any{},
		})
		if _, err := svc.UpsertUserCanvasProject("local", savedCanvas); err != nil {
			t.Fatal(err)
		}
		if err := svc.CanvasService().DeleteUserCanvasProject("local", canvasID); err != nil {
			t.Fatal(err)
		}

		beforeBinds := canvasBindTraceCount(t, svc)
		if err := svc.recoverCanvasTaskBindings(canvasTask); err != nil {
			t.Fatalf("deleted canvas workflow task returned scan error: %v", err)
		}
		if got := canvasBindTraceCount(t, svc); got != beforeBinds {
			t.Fatalf("deleted canvas workflow task called canvas.bind: before=%d after=%d", beforeBinds, got)
		}
		var canvasArtifacts int64
		if err := db.Table("shot_artifacts").Where("task_id = ?", canvasTask.ID).Count(&canvasArtifacts).Error; err != nil || canvasArtifacts != 0 {
			t.Fatalf("deleted canvas workflow task registered artifact early: count=%d err=%v", canvasArtifacts, err)
		}

		// 2) Non-canvas short-drama workflow task (task.ProjectID == project.ID) must NOT be skipped.
		projectInput, _ := json.Marshal(map[string]any{
			"metadata": map[string]any{
				"workflowStepId": videoStep.ID,
				"unitId":         unit.ID,
				"shotId":         shot.ID,
				"artifactType":   "video",
				"role":           "output",
			},
		})
		projectTask := model.Task{
			ID: "bind-non-canvas-project-wf", UserID: "local", ProjectID: project.ID,
			Type: "canvas_video", Status: model.TaskStatusSucceeded,
			InputJSON:  string(projectInput),
			ResultJSON: `{"mode":"video","video":{"resourceId":"res-wf-project","storageKey":"resource:res-wf-project"}}`,
			CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
		}
		if err := db.Create(&projectTask).Error; err != nil {
			t.Fatal(err)
		}
		if err := svc.recoverCanvasTaskBindings(projectTask); err != nil {
			t.Fatalf("non-canvas project workflow task failed: %v", err)
		}
		var projectArtifacts int64
		if err := db.Table("shot_artifacts").Where("task_id = ?", projectTask.ID).Count(&projectArtifacts).Error; err != nil || projectArtifacts != 1 {
			t.Fatalf("non-canvas project workflow task did not register artifact: count=%d err=%v", projectArtifacts, err)
		}

		// 3) Restoring the canvas registers the workflow output and binds the canvas node.
		restoreDeletedTestCanvas(t, svc, savedCanvas)
		if err := svc.recoverCanvasTaskBindings(canvasTask); err != nil {
			t.Fatalf("restored canvas workflow task failed: %v", err)
		}
		if err := db.Table("shot_artifacts").Where("task_id = ?", canvasTask.ID).Count(&canvasArtifacts).Error; err != nil || canvasArtifacts != 1 {
			t.Fatalf("restored canvas workflow task artifact count = %d, err = %v", canvasArtifacts, err)
		}
		meta := canvasBindTestNodeMetadata(t, svc, canvasID, "node-wf-video")
		if meta["content"] != "/api/resources/"+resCanvas.ID+"/file" {
			t.Fatalf("restored canvas workflow node content = %#v", meta["content"])
		}
	})

	t.Run("business project pseudo-node tasks (character turnaround and chapter extraction)", func(t *testing.T) {
		svc, _, _ := newAssistantTurnService(t)
		db := svc.Database()
		now := time.Now()
		project, err := svc.ProjectService().CreateProject("local", CreateProjectRequest{Name: "三视图短剧项目"})
		if err != nil {
			t.Fatal(err)
		}
		character, err := svc.ProjectService().CreateProjectCharacter("local", project.ID, CreateProjectCharacterRequest{
			Name:       "主角阿昭",
			Definition: map[string]any{"role": "主角", "appearance": "黑发"},
		})
		if err != nil {
			t.Fatal(err)
		}
		resTurnaround := model.Resource{
			ID: "res-turnaround-pseudo", UserID: "local", Kind: "image",
			Status: model.ResourceStatusReady, MimeType: "image/png", Width: 512, Height: 512, Size: 128,
			CreatedAt: now, UpdatedAt: now,
		}
		if err := db.Create(&resTurnaround).Error; err != nil {
			t.Fatal(err)
		}
		turnaroundTask := model.Task{
			ID: "bind-pseudo-turnaround", UserID: "local", ProjectID: project.ID,
			Type: "canvas_image", Status: model.TaskStatusSucceeded, Prompt: "三视图",
			InputJSON:  `{"nodeId":"character-turnaround:` + character.Asset.ID + `","metadata":{"operation":"character_turnaround","characterAssetId":"` + character.Asset.ID + `"}}`,
			ResultJSON: `{"images":[{"resourceId":"res-turnaround-pseudo","storageKey":"resource:res-turnaround-pseudo"}]}`,
			CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
		}
		chapterTask := model.Task{
			ID: "bind-pseudo-chapter", UserID: "local", ProjectID: project.ID,
			Type: "canvas_text", Status: model.TaskStatusSucceeded, Prompt: "章节提取",
			InputJSON:  `{"nodeId":"chapter_assets_extract:chapter-1","metadata":{"domainProjectId":"` + project.ID + `","chapterId":"chapter-1","operation":"chapter_assets_extract"}}`,
			ResultJSON: `{"mode":"text","text":"{\"characters\":[]}"}`,
			CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
		}
		for _, item := range []*model.Task{&turnaroundTask, &chapterTask} {
			if err := db.Create(item).Error; err != nil {
				t.Fatal(err)
			}
		}
		if err := svc.generationDeliverer().Deliver(chapterTask); err != nil {
			t.Fatal(err)
		}

		beforeBinds := canvasBindTraceCount(t, svc)
		if err := svc.recoverCanvasTaskBindings(chapterTask); err != nil {
			t.Fatalf("chapter pseudo-node task returned error: %v", err)
		}
		if err := svc.recoverCanvasTaskBindings(turnaroundTask); err != nil {
			t.Fatalf("turnaround pseudo-node task returned error: %v", err)
		}
		if got := canvasBindTraceCount(t, svc); got != beforeBinds {
			t.Fatalf("pseudo-node business project tasks called canvas.bind: before=%d after=%d", beforeBinds, got)
		}
		bound, err := svc.projectDomain().CharacterTurnaroundBound(turnaroundTask.ID)
		if err != nil || !bound {
			t.Fatalf("character turnaround card was not reconciled: bound=%v err=%v", bound, err)
		}
	})
}
