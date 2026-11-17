package app

import (
	"encoding/json"
	"testing"

	"qisitv/backend/internal/agentops"
	"qisitv/backend/internal/assistantturns"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/operations"
)

func regenerateExternalNode(t *testing.T, svc *Service, r *operations.Registry, canvasID, nodeID, operationID string, caller operations.Caller) (operations.Result, error) {
	t.Helper()
	params, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeIds": []string{nodeID}, "expectedRevision": canvasRevisionOf(t, svc, canvasID), "expectedModelConfigRevision": 1})
	return r.Execute(operations.Request{Op: "canvas.generation.regenerate", OpID: operationID, UserID: "local", Caller: caller, Params: params})
}

// 已成功的节点由 regenerate 原地重做：旧任务保留，节点交给新任务。
func TestRegenerateReplacesSucceededNodeInPlace(t *testing.T) {
	svc, r, canvasID, _ := externalGenerationFixture(t)
	if err := submitExternalNode(t, svc, r, canvasID, "image", "first-attempt"); err != nil {
		t.Fatal(err)
	}
	oldTaskID, _ := readProgressNodeMeta(t, svc, canvasID, "image")["taskId"].(string)
	updateTask(t, svc, oldTaskID, map[string]any{"status": model.TaskStatusSucceeded})
	mutateProgressNode(t, svc, canvasID, "image", func(meta map[string]any) {
		meta["status"], meta["content"] = "success", "https://example.invalid/old.png"
	})

	if _, err := regenerateExternalNode(t, svc, r, canvasID, "image", "regenerate-1", operations.ExternalCaller(false)); err != nil {
		t.Fatalf("succeeded node refused in-place regenerate: %v", err)
	}
	meta := readProgressNodeMeta(t, svc, canvasID, "image")
	if meta["taskId"] == oldTaskID || meta["status"] != "loading" || meta["taskOutcome"] != nil || meta["errorDetails"] != nil {
		t.Fatalf("new task does not own the regenerated node: %+v", meta)
	}
	for _, key := range []string{"content"} {
		if _, present := meta[key]; present {
			t.Fatalf("old output %s still on the regenerating node: %+v", key, meta)
		}
	}
	if count := taskCount(t, svc); count != 2 {
		t.Fatalf("old result and new task should both remain, tasks=%d", count)
	}
	var kept model.Task
	if err := svc.Database().First(&kept, "id = ?", oldTaskID).Error; err != nil || kept.Status != model.TaskStatusSucceeded {
		t.Fatalf("old succeeded task was removed: %+v %v", kept, err)
	}
	orders, err := svc.ListGenerationOrders("local", canvasID)
	if err != nil || len(orders) != 2 || !orders[0].Regenerate || orders[0].Status != operations.GenerationOrderSubmitted {
		t.Fatalf("regenerate order not recorded: %+v %v", orders, err)
	}
}

func TestRegenerateFailureAfterSucceededNodeIsWrittenBack(t *testing.T) {
	svc, r, canvasID, _ := externalGenerationFixture(t)
	if err := submitExternalNode(t, svc, r, canvasID, "image", "first-attempt"); err != nil {
		t.Fatal(err)
	}
	oldTaskID, _ := readProgressNodeMeta(t, svc, canvasID, "image")["taskId"].(string)
	updateTask(t, svc, oldTaskID, map[string]any{"status": model.TaskStatusSucceeded})
	mutateProgressNode(t, svc, canvasID, "image", func(meta map[string]any) {
		meta["status"], meta["content"] = "success", "https://example.invalid/old.png"
	})
	if _, err := regenerateExternalNode(t, svc, r, canvasID, "image", "regenerate-1", operations.ExternalCaller(false)); err != nil {
		t.Fatal(err)
	}
	newTaskID, _ := readProgressNodeMeta(t, svc, canvasID, "image")["taskId"].(string)
	updateTask(t, svc, newTaskID, upstreamRejection)
	if err := svc.recoverPendingCanvasFailures(0); err != nil {
		t.Fatal(err)
	}
	meta := readProgressNodeMeta(t, svc, canvasID, "image")
	if meta["status"] != "error" || meta["taskId"] != newTaskID || nodeTaskOutcome(meta)["phase"] != "failed" {
		t.Fatalf("failed in-place regenerate was not written back: %+v", meta)
	}
}

func TestRegenerateReplacesEndedFailuresInPlace(t *testing.T) {
	for _, tc := range []struct {
		name   string
		fields map[string]any
	}{
		{"upstream-rejected", upstreamRejection},
		{"cancelled", map[string]any{"status": model.TaskStatusCancelled}},
		{"charged-result-unrecoverable", map[string]any{"status": model.TaskStatusFailed, "recovery_outcome": "unrecoverable"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, r, canvasID, _ := externalGenerationFixture(t)
			if err := submitExternalNode(t, svc, r, canvasID, "image", "first-attempt"); err != nil {
				t.Fatal(err)
			}
			oldTaskID, _ := readProgressNodeMeta(t, svc, canvasID, "image")["taskId"].(string)
			updateTask(t, svc, oldTaskID, tc.fields)
			if _, err := regenerateExternalNode(t, svc, r, canvasID, "image", "regenerate-1", operations.ExternalCaller(false)); err != nil {
				t.Fatalf("ended failure refused in-place regenerate: %v", err)
			}
			if meta := readProgressNodeMeta(t, svc, canvasID, "image"); meta["taskId"] == oldTaskID || meta["status"] != "loading" {
				t.Fatalf("regenerated node still bound to the old task: %+v", meta)
			}
			if count := taskCount(t, svc); count != 2 {
				t.Fatalf("tasks=%d", count)
			}
		})
	}
}

// 排队、运行、下载/保存中的结果还没结束，regenerate 不能替换它。
func TestRegenerateKeepsUnfinishedNode(t *testing.T) {
	for _, tc := range []struct {
		name   string
		task   map[string]any
		mutate func(meta map[string]any)
	}{
		{name: "queued"},
		{name: "running", task: map[string]any{"status": model.TaskStatusRunning}},
		{name: "provider may still return the result", task: map[string]any{"status": model.TaskStatusFailed, "provider_request_id": "upstream-job-1"}},
		{name: "charge still being settled", task: map[string]any{"status": model.TaskStatusFailed, "beef_billing_state": "reserved"}},
		{name: "downloading", task: map[string]any{"status": model.TaskStatusSucceeded, "result_json": `{"images":["https://example.invalid/pending.png"]}`}},
		{name: "saving", task: map[string]any{"status": model.TaskStatusSucceeded, "result_json": `{"images":["https://example.invalid/pending.png"]}`, "stage": "正在取回结果"}},
		{name: "submitting retry", task: upstreamRejection, mutate: func(meta map[string]any) {
			meta["taskClientOperationId"], meta["generationSubmissionState"] = "retry:in-flight", "submitting"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, r, canvasID, _ := externalGenerationFixture(t)
			if err := submitExternalNode(t, svc, r, canvasID, "image", "first-attempt"); err != nil {
				t.Fatal(err)
			}
			taskID, _ := readProgressNodeMeta(t, svc, canvasID, "image")["taskId"].(string)
			if tc.task != nil {
				updateTask(t, svc, taskID, tc.task)
			}
			if tc.mutate != nil {
				mutateProgressNode(t, svc, canvasID, "image", tc.mutate)
			}
			before := readProgressNodeMeta(t, svc, canvasID, "image")
			if _, err := regenerateExternalNode(t, svc, r, canvasID, "image", "regenerate-1", operations.ExternalCaller(false)); err == nil || operations.AsError(err).Reason != "generation_task_exists" {
				t.Fatalf("expected generation_task_exists, got %v", err)
			}
			if count := taskCount(t, svc); count != 1 {
				t.Fatalf("a second task was purchased: %d", count)
			}
			after := readProgressNodeMeta(t, svc, canvasID, "image")
			if after["taskId"] != before["taskId"] || after["status"] != before["status"] || after["taskClientOperationId"] != before["taskClientOperationId"] {
				t.Fatalf("refused regenerate changed the node: %+v -> %+v", before, after)
			}
		})
	}
}

func TestRegenerateReplayDoesNotBuyTwice(t *testing.T) {
	svc, r, canvasID, _ := externalGenerationFixture(t)
	if err := submitExternalNode(t, svc, r, canvasID, "image", "first-attempt"); err != nil {
		t.Fatal(err)
	}
	taskID, _ := readProgressNodeMeta(t, svc, canvasID, "image")["taskId"].(string)
	updateTask(t, svc, taskID, map[string]any{"status": model.TaskStatusSucceeded})

	params, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeIds": []string{"image"}, "expectedRevision": canvasRevisionOf(t, svc, canvasID), "expectedModelConfigRevision": 1})
	req := operations.Request{Op: "canvas.generation.regenerate", OpID: "regenerate-1", UserID: "local", Caller: operations.ExternalCaller(false), Params: params}
	first, err := r.Execute(req)
	if err != nil {
		t.Fatal(err)
	}
	second, err := r.Execute(req)
	if err != nil || !second.Replayed || !jsonEqual(first.Result, second.Result) {
		t.Fatalf("replay = %+v, %v", second, err)
	}
	if count := taskCount(t, svc); count != 2 {
		t.Fatalf("replayed regenerate purchased another task: %d", count)
	}
}

// 「每次问我」下 regenerate 只能登记意图，owner 批准后才按原地重做受理。
func TestRegenerateAskModeRequiresOwnerApproval(t *testing.T) {
	svc, r, canvasID, _ := externalGenerationFixture(t)
	if err := submitExternalNode(t, svc, r, canvasID, "image", "first-attempt"); err != nil {
		t.Fatal(err)
	}
	taskID, _ := readProgressNodeMeta(t, svc, canvasID, "image")["taskId"].(string)
	updateTask(t, svc, taskID, map[string]any{"status": model.TaskStatusSucceeded})
	mutateProgressNode(t, svc, canvasID, "image", func(meta map[string]any) {
		meta["status"], meta["content"] = "success", "https://example.invalid/old.png"
	})

	askCaller := operations.Caller{Kind: operations.CallerExternal, ClientID: "client-ask", ClientLabel: "claude-ask", ApprovalMode: operations.ApprovalModeAsk}
	proposeParams, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeIds": []string{"image"}, "kind": "image"})
	proposed, err := r.Execute(operations.Request{Op: "canvas.generation.propose", UserID: "local", Caller: askCaller, Params: proposeParams})
	if err != nil {
		t.Fatal(err)
	}
	proposalID, _ := proposed.Result.(map[string]any)["proposalId"].(string)
	if proposalID == "" {
		t.Fatalf("missing proposalId: %+v", proposed.Result)
	}

	pendingParams, _ := json.Marshal(map[string]any{
		"canvasId": canvasID, "proposalId": proposalID, "nodeIds": []string{"image"},
		"expectedRevision": canvasRevisionOf(t, svc, canvasID), "expectedModelConfigRevision": 1,
	})
	revisionBefore := canvasRevisionOf(t, svc, canvasID)
	pending, err := r.Execute(operations.Request{Op: "canvas.generation.regenerate", OpID: "regenerate-ask-1", UserID: "local", Caller: askCaller, Params: pendingParams})
	if err != nil {
		t.Fatalf("ask regenerate should record intent and wait: %v", err)
	}
	pendingResult := pending.Result.(map[string]any)
	if pendingResult["status"] != "pending_approval" || pendingResult["approvalRequired"] != true || taskCount(t, svc) != 1 {
		t.Fatalf("ask regenerate submitted without owner approval: %+v", pendingResult)
	}
	if ids := submittedTaskIDs(pendingResult["nodeIds"]); len(ids) != 1 || ids[0] != "image" {
		t.Fatalf("pending approval did not echo the approved node scope: %+v", pendingResult)
	}
	if after := canvasRevisionOf(t, svc, canvasID); after != revisionBefore {
		t.Fatalf("pending approval changed the canvas: %d -> %d", revisionBefore, after)
	}
	meta := readProgressNodeMeta(t, svc, canvasID, "image")
	if meta["status"] != "success" || meta["content"] != "https://example.invalid/old.png" {
		t.Fatalf("pending approval changed the node before owner confirmation: %+v", meta)
	}
	order, err := operations.LookupGenerationOrderInTx(svc.Database(), "local", proposalID)
	if err != nil || order == nil || !order.Regenerate || order.Status != operations.GenerationOrderPending {
		t.Fatalf("regenerate intent not recorded: %+v %v", order, err)
	}

	approved, err := svc.ApproveGenerationOrder("local", proposalID, "owner")
	if err != nil {
		t.Fatalf("owner approval of regenerate failed: %v", err)
	}
	approvedMap := approved.(map[string]any)
	if ids := submittedTaskIDs(approvedMap["taskIds"]); len(ids) != 1 || taskCount(t, svc) != 2 {
		t.Fatalf("owner approval did not replace the succeeded node: %+v", approvedMap)
	}
	// 批准后再调用一次（换用新 operationId）只读回已购任务。
	afterParams, _ := json.Marshal(map[string]any{
		"canvasId": canvasID, "proposalId": proposalID, "nodeIds": []string{"image"},
		"expectedRevision": canvasRevisionOf(t, svc, canvasID), "expectedModelConfigRevision": 1,
	})
	after, err := r.Execute(operations.Request{Op: "canvas.generation.regenerate", OpID: "regenerate-ask-2", UserID: "local", Caller: askCaller, Params: afterParams})
	if err != nil {
		t.Fatal(err)
	}
	if ids := submittedTaskIDs(after.Result.(map[string]any)["taskIds"]); len(ids) != 1 || taskCount(t, svc) != 2 {
		t.Fatalf("approved regenerate readback: %+v", after.Result)
	}
}

func TestRegenerateIsExternalWriteOnly(t *testing.T) {
	svc, r, canvasID, _ := externalGenerationFixture(t)
	if err := submitExternalNode(t, svc, r, canvasID, "image", "first-attempt"); err != nil {
		t.Fatal(err)
	}
	taskID, _ := readProgressNodeMeta(t, svc, canvasID, "image")["taskId"].(string)
	updateTask(t, svc, taskID, map[string]any{"status": model.TaskStatusSucceeded})

	if _, err := regenerateExternalNode(t, svc, r, canvasID, "image", "read-only-regenerate", operations.ExternalCaller(true)); err == nil {
		t.Fatal("read-only client regenerated a paid task")
	}
	descriptor, ok := r.Descriptor("canvas.generation.regenerate")
	if !ok || len(descriptor.AssistantModes) != 0 || !descriptor.SubmitsGeneration {
		t.Fatalf("regenerate descriptor: %+v", descriptor)
	}
	assistant := operations.AssistantCaller(&agentops.AssistantScope{PermissionMode: assistantturns.PermissionFullAccess, CanvasID: canvasID}, false)
	visibleSubmit := false
	for _, listed := range r.List(assistant) {
		if listed.ID == "canvas.generation.submit" {
			visibleSubmit = true
		}
		if listed.ID == "canvas.generation.regenerate" {
			t.Fatal("built-in assistant can see canvas.generation.regenerate")
		}
	}
	if !visibleSubmit {
		t.Fatal("full-access assistant should still see canvas.generation.submit")
	}
	params, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeIds": []string{"image"}, "expectedRevision": canvasRevisionOf(t, svc, canvasID), "expectedModelConfigRevision": 1})
	if _, err := r.Execute(operations.Request{Op: "canvas.generation.regenerate", OpID: "assistant-regenerate", UserID: "local", Caller: assistant, TurnID: "assistant-turn", Params: params}); err == nil || operations.AsError(err).Reason != "scope_denied" {
		t.Fatalf("built-in assistant executed regenerate: %v", err)
	}
	if count := taskCount(t, svc); count != 1 {
		t.Fatalf("refused callers purchased a task: %d", count)
	}
}

// owner 批准执行整张生成单，ask 模式不能只声明其中一个节点来扩大付费范围。
func TestRegenerateAskModeRejectsPartialOrderScope(t *testing.T) {
	svc, r, canvasID, _ := externalGenerationFixture(t)
	if err := submitExternalNode(t, svc, r, canvasID, "image", "first-attempt"); err != nil {
		t.Fatal(err)
	}
	taskID, _ := readProgressNodeMeta(t, svc, canvasID, "image")["taskId"].(string)
	updateTask(t, svc, taskID, map[string]any{"status": model.TaskStatusSucceeded})

	askCaller := operations.Caller{Kind: operations.CallerExternal, ClientID: "client-ask", ClientLabel: "claude-ask", ApprovalMode: operations.ApprovalModeAsk}
	proposeParams, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeIds": []string{"image", "image-2"}, "kind": "image"})
	proposed, err := r.Execute(operations.Request{Op: "canvas.generation.propose", UserID: "local", Caller: askCaller, Params: proposeParams})
	if err != nil {
		t.Fatal(err)
	}
	proposalID, _ := proposed.Result.(map[string]any)["proposalId"].(string)
	params, _ := json.Marshal(map[string]any{"canvasId": canvasID, "proposalId": proposalID, "nodeIds": []string{"image"}})
	if _, err := r.Execute(operations.Request{Op: "canvas.generation.regenerate", OpID: "regenerate-partial", UserID: "local", Caller: askCaller, Params: params}); err == nil || operations.AsError(err).Reason != "generation_scope_mismatch" {
		t.Fatalf("partial ask regenerate accepted: %v", err)
	}
	order, err := operations.LookupGenerationOrderInTx(svc.Database(), "local", proposalID)
	if err != nil || order == nil || order.Regenerate || order.Status != operations.GenerationOrderPending {
		t.Fatalf("partial ask regenerate changed the order: %+v %v", order, err)
	}
	if count := taskCount(t, svc); count != 1 {
		t.Fatalf("partial ask regenerate purchased a task: %d", count)
	}
}

// 只绑定过素材、没有任务回执的节点：原地重做也要清掉旧显示，新任务失败才能写回。
func TestRegenerateClearsMediaOnlyNodeAndWritesFailure(t *testing.T) {
	svc, r, canvasID, _ := externalGenerationFixture(t)
	mutateProgressNode(t, svc, canvasID, "image", func(meta map[string]any) {
		meta["status"], meta["content"] = "success", "https://example.invalid/old.png"
		delete(meta, "taskId")
		delete(meta, "taskClientOperationId")
		delete(meta, "generationSubmissionState")
	})
	before := readProgressNodeMeta(t, svc, canvasID, "image")
	if _, exists := before["content"]; !exists {
		t.Fatalf("fixture should start with a media-only node: %+v", before)
	}
	if _, err := regenerateExternalNode(t, svc, r, canvasID, "image", "regenerate-media-only", operations.ExternalCaller(false)); err != nil {
		t.Fatalf("media-only node refused in-place regenerate: %v", err)
	}
	meta := readProgressNodeMeta(t, svc, canvasID, "image")
	if _, exists := meta["content"]; exists {
		t.Fatalf("old media survived on the regenerating node: %+v", meta)
	}
	newTaskID, _ := meta["taskId"].(string)
	if newTaskID == "" || meta["status"] != "loading" {
		t.Fatalf("new task did not take the media-only node: %+v", meta)
	}
	updateTask(t, svc, newTaskID, upstreamRejection)
	if err := svc.recoverPendingCanvasFailures(0); err != nil {
		t.Fatal(err)
	}
	if meta = readProgressNodeMeta(t, svc, canvasID, "image"); meta["status"] != "error" || nodeTaskOutcome(meta)["phase"] != "failed" {
		t.Fatalf("failed regenerate of a media-only node was not written back: %+v", meta)
	}
}

// 普通 submit 已执行过的 ask 生成单不能被 regenerate 复用成一次新付费。
func TestRegenerateCannotReuseSubmittedAskOrder(t *testing.T) {
	svc, r, canvasID, _ := externalGenerationFixture(t)
	askCaller := operations.Caller{Kind: operations.CallerExternal, ClientID: "client-ask", ClientLabel: "claude-ask", ApprovalMode: operations.ApprovalModeAsk}
	proposeParams, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeIds": []string{"image"}, "kind": "image"})
	proposed, err := r.Execute(operations.Request{Op: "canvas.generation.propose", UserID: "local", Caller: askCaller, Params: proposeParams})
	if err != nil {
		t.Fatal(err)
	}
	proposalID, _ := proposed.Result.(map[string]any)["proposalId"].(string)
	if _, err := svc.ApproveGenerationOrder("local", proposalID, "owner"); err != nil {
		t.Fatal(err)
	}
	taskID, _ := readProgressNodeMeta(t, svc, canvasID, "image")["taskId"].(string)
	updateTask(t, svc, taskID, map[string]any{"status": model.TaskStatusSucceeded})

	params, _ := json.Marshal(map[string]any{"canvasId": canvasID, "proposalId": proposalID, "nodeIds": []string{"image"}, "expectedRevision": canvasRevisionOf(t, svc, canvasID), "expectedModelConfigRevision": 1})
	if _, err := r.Execute(operations.Request{Op: "canvas.generation.regenerate", OpID: "regenerate-reuse", UserID: "local", Caller: askCaller, Params: params}); err == nil || operations.AsError(err).Reason != "generation_approval_required" {
		t.Fatalf("submitted ask order was reused for regenerate: %v", err)
	}
	if count := taskCount(t, svc); count != 1 {
		t.Fatalf("reused ask order purchased another task: %d", count)
	}
}

// 释放旧结果和受理新任务在同一事务里：受理失败必须连释放一起回滚。
func TestRegenerateRollsBackReleaseWhenAdmissionFails(t *testing.T) {
	svc, r, canvasID, _ := externalGenerationFixture(t)
	if err := submitExternalNode(t, svc, r, canvasID, "image", "first-attempt"); err != nil {
		t.Fatal(err)
	}
	oldTaskID, _ := readProgressNodeMeta(t, svc, canvasID, "image")["taskId"].(string)
	updateTask(t, svc, oldTaskID, map[string]any{"status": model.TaskStatusSucceeded})
	mutateProgressNode(t, svc, canvasID, "image", func(meta map[string]any) {
		meta["status"], meta["content"] = "success", "https://example.invalid/old.png"
	})
	revision := canvasRevisionOf(t, svc, canvasID)
	if err := svc.Database().Exec("CREATE TRIGGER fail_regenerate BEFORE INSERT ON tasks WHEN NEW.prompt = 'A wooden tray' BEGIN SELECT RAISE(ABORT, 'fixture regenerate admission failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	defer svc.Database().Exec("DROP TRIGGER fail_regenerate")
	if _, err := regenerateExternalNode(t, svc, r, canvasID, "image", "regenerate-rollback", operations.ExternalCaller(false)); err == nil {
		t.Fatal("failed admission was accepted")
	}
	meta := readProgressNodeMeta(t, svc, canvasID, "image")
	if canvasRevisionOf(t, svc, canvasID) != revision || meta["taskId"] != oldTaskID || meta["content"] != "https://example.invalid/old.png" || meta["status"] != "success" {
		t.Fatalf("failed admission did not roll back the release: %+v", meta)
	}
	if count := taskCount(t, svc); count != 1 {
		t.Fatalf("failed admission left another task: %d", count)
	}
}

// legacy 画布可能把旧媒体放在节点顶层；清理必须同时覆盖顶层与 metadata。
func TestRegenerateClearsLegacyTopLevelMediaAndWritesFailure(t *testing.T) {
	svc, r, canvasID, _ := externalGenerationFixture(t)
	raw, err := svc.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, item := range doc["nodes"].([]any) {
		node, _ := item.(map[string]any)
		if node["id"] == "image" {
			node["content"], node["status"] = "https://example.invalid/legacy.png", "success"
			node["metadata"].(map[string]any)["status"] = "success"
		}
	}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	if _, err := regenerateExternalNode(t, svc, r, canvasID, "image", "regenerate-legacy", operations.ExternalCaller(false)); err != nil {
		t.Fatalf("legacy media node refused in-place regenerate: %v", err)
	}
	node := readCanvasNode(t, svc, canvasID, "image")
	if _, present := node["content"]; present {
		t.Fatalf("legacy top-level media survived regenerate: %+v", node)
	}
	newTaskID, _ := node["metadata"].(map[string]any)["taskId"].(string)
	if newTaskID == "" {
		t.Fatalf("new task did not take the legacy node: %+v", node)
	}
	updateTask(t, svc, newTaskID, upstreamRejection)
	if err := svc.recoverPendingCanvasFailures(0); err != nil {
		t.Fatal(err)
	}
	if meta := readProgressNodeMeta(t, svc, canvasID, "image"); meta["status"] != "error" || nodeTaskOutcome(meta)["phase"] != "failed" {
		t.Fatalf("failed regenerate of a legacy media node was not written back: %+v", meta)
	}
}

func readCanvasNode(t *testing.T, svc *Service, canvasID, nodeID string) map[string]any {
	t.Helper()
	raw, err := svc.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, item := range doc["nodes"].([]any) {
		if node, ok := item.(map[string]any); ok && node["id"] == nodeID {
			return node
		}
	}
	t.Fatalf("node %s not found", nodeID)
	return nil
}

func submittedTaskIDs(value any) []string {
	switch raw := value.(type) {
	case []string:
		return raw
	case []any:
		ids := make([]string, 0, len(raw))
		for _, item := range raw {
			if id, ok := item.(string); ok && id != "" {
				ids = append(ids, id)
			}
		}
		return ids
	}
	return nil
}

func jsonEqual(a, b any) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return string(left) == string(right)
}
