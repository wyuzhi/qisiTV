package app

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func submitExternalNode(t *testing.T, svc *Service, r *operations.Registry, canvasID, nodeID, operationID string) error {
	t.Helper()
	params, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeIds": []string{nodeID}, "expectedRevision": canvasRevisionOf(t, svc, canvasID), "expectedModelConfigRevision": 1})
	_, err := r.Execute(operations.Request{Op: "canvas.generation.submit", OpID: operationID, UserID: "local", Caller: operations.ExternalCaller(false), Params: params})
	return err
}

func updateTask(t *testing.T, svc *Service, taskID string, fields map[string]any) {
	t.Helper()
	if err := svc.Database().Model(&model.Task{}).Where("id = ?", taskID).Updates(fields).Error; err != nil {
		t.Fatal(err)
	}
}

func taskCount(t *testing.T, svc *Service) int64 {
	t.Helper()
	var count int64
	if err := svc.Database().Model(&model.Task{}).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	return count
}

func nodeTaskOutcome(meta map[string]any) map[string]any {
	outcome, _ := meta["taskOutcome"].(map[string]any)
	return outcome
}

var upstreamRejection = map[string]any{"status": model.TaskStatusFailed, "error": "upstream rejected the request", "recovery_outcome": "no_result"}

func TestExternalGenerationFailureIsWrittenBackAndNodeAcceptsResubmission(t *testing.T) {
	svc, r, canvasID, _ := externalGenerationFixture(t)
	if err := submitExternalNode(t, svc, r, canvasID, "image", "first-attempt"); err != nil {
		t.Fatal(err)
	}
	failedID, _ := readProgressNodeMeta(t, svc, canvasID, "image")["taskId"].(string)
	updateTask(t, svc, failedID, upstreamRejection)

	if err := svc.recoverPendingCanvasFailures(0); err != nil {
		t.Fatal(err)
	}
	meta := readProgressNodeMeta(t, svc, canvasID, "image")
	outcome := nodeTaskOutcome(meta)
	if meta["status"] != "error" || meta["taskId"] != failedID || meta["taskStatus"] != "failed" || meta["errorDetails"] != "upstream rejected the request" ||
		outcome["phase"] != "failed" || outcome["reason"] != "no_result" {
		t.Fatalf("failure not written back: %+v", meta)
	}
	revision := canvasRevisionOf(t, svc, canvasID)
	if err := svc.recoverPendingCanvasFailures(0); err != nil || canvasRevisionOf(t, svc, canvasID) != revision {
		t.Fatalf("settled failure was written again: %v", err)
	}

	if err := submitExternalNode(t, svc, r, canvasID, "image", "second-attempt"); err != nil {
		t.Fatalf("failed node refused a new submission: %v", err)
	}
	meta = readProgressNodeMeta(t, svc, canvasID, "image")
	retryID, _ := meta["taskId"].(string)
	if retryID == "" || retryID == failedID || meta["status"] != "loading" || meta["taskOutcome"] != nil || meta["errorDetails"] != nil || meta["error"] != nil {
		t.Fatalf("new task does not own the node cleanly: %+v", meta)
	}
	if count := taskCount(t, svc); count != 2 {
		t.Fatalf("tasks = %d", count)
	}
	// The new task is now the node's in-flight purchase.
	if err := submitExternalNode(t, svc, r, canvasID, "image", "third-attempt"); err == nil || operations.AsError(err).Reason != "generation_task_exists" {
		t.Fatalf("running retry accepted a duplicate: %v", err)
	}
}

// Nodes left loading before the backend wrote failures back can be retried too.
func TestExternalGenerationResubmitsNodeStillLoadingForFailedTask(t *testing.T) {
	svc, r, canvasID, _ := externalGenerationFixture(t)
	if err := submitExternalNode(t, svc, r, canvasID, "image", "first-attempt"); err != nil {
		t.Fatal(err)
	}
	failedID, _ := readProgressNodeMeta(t, svc, canvasID, "image")["taskId"].(string)
	updateTask(t, svc, failedID, map[string]any{"status": model.TaskStatusCancelled})
	if meta := readProgressNodeMeta(t, svc, canvasID, "image"); meta["status"] != "loading" {
		t.Fatalf("fixture should keep the stale node: %+v", meta)
	}
	if err := submitExternalNode(t, svc, r, canvasID, "image", "second-attempt"); err != nil {
		t.Fatalf("stale node of a cancelled task refused a new submission: %v", err)
	}
	if meta := readProgressNodeMeta(t, svc, canvasID, "image"); meta["taskId"] == failedID || meta["status"] != "loading" {
		t.Fatalf("node still bound to the old task: %+v", meta)
	}
}

func TestExternalGenerationKeepsNodeWhoseTaskMayStillDeliver(t *testing.T) {
	for _, tc := range []struct {
		name   string
		task   map[string]any
		mutate func(meta map[string]any)
	}{
		{name: "queued"},
		{name: "running", task: map[string]any{"status": model.TaskStatusRunning}},
		{name: "succeeded", task: map[string]any{"status": model.TaskStatusSucceeded}, mutate: func(meta map[string]any) {
			meta["status"], meta["taskStatus"], meta["content"] = "success", "succeeded", "https://example.invalid/delivered.png"
		}},
		{name: "provider may still return the result", task: map[string]any{"status": model.TaskStatusFailed, "provider_request_id": "upstream-job-1"}},
		{name: "charge still being settled", task: map[string]any{"status": model.TaskStatusFailed, "beef_billing_state": "reserved"}},
		{name: "retry already submitting", task: upstreamRejection, mutate: func(meta map[string]any) {
			meta["taskClientOperationId"], meta["generationSubmissionState"] = "retry:in-flight", "submitting"
		}},
		{name: "submission without task record", mutate: func(meta map[string]any) {
			delete(meta, "taskId")
			meta["taskClientOperationId"] = "proposal:never-admitted:image"
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
			err := submitExternalNode(t, svc, r, canvasID, "image", "second-attempt")
			if err == nil || operations.AsError(err).Reason != "generation_task_exists" {
				t.Fatalf("expected generation_task_exists, got %v", err)
			}
			if count := taskCount(t, svc); count != 1 {
				t.Fatalf("a second task was purchased: %d", count)
			}
			after := readProgressNodeMeta(t, svc, canvasID, "image")
			if after["taskId"] != before["taskId"] || after["status"] != before["status"] || after["taskClientOperationId"] != before["taskClientOperationId"] {
				t.Fatalf("refused submission changed the node: %+v -> %+v", before, after)
			}
		})
	}
}

func TestCanvasFailureWritebackFollowsTaskOutcome(t *testing.T) {
	svc, _, canvasID, _ := externalGenerationFixture(t)
	str := func(value string) *string { return &value }
	tasks := []model.Task{
		{ID: "video-rejected", RecoveryOutcome: str("no_result")},
		{ID: "video-pending-result", ProviderRequestID: "upstream-job-1"},
		{ID: "video-settling", BeefBillingState: str("reserved")},
		{ID: "video-charged", BeefBillingState: str("reserved")},
		{ID: "video-retrying", RecoveryOutcome: str("no_result")},
		{ID: "video-kept-media", RecoveryOutcome: str("no_result")},
		{ID: "video-explained", RecoveryOutcome: str("no_result")},
	}
	nodes := []any{}
	for i := range tasks {
		task := &tasks[i]
		task.UserID, task.ProjectID, task.Type, task.Status, task.Error = "local", canvasID, "canvas_video", model.TaskStatusFailed, "upstream rejected the request"
		task.ClientOperationID = str("proposal:external-old:" + task.ID)
		if err := svc.Database().Create(task).Error; err != nil {
			t.Fatal(err)
		}
		meta := map[string]any{"prompt": "shot", "taskId": task.ID, "taskStatus": "queued", "status": "loading", "taskClientOperationId": *task.ClientOperationID, "generationSubmissionState": "accepted"}
		switch task.ID {
		case "video-retrying":
			meta["taskClientOperationId"], meta["generationSubmissionState"] = "retry:in-flight", "submitting"
		case "video-kept-media":
			meta["status"], meta["content"] = "success", "https://example.invalid/earlier-cut.mp4"
		case "video-explained":
			meta["status"], meta["taskStatus"], meta["errorDetails"] = "error", "failed", "当前模型不支持生成声音，请关闭声音后重试"
		}
		nodes = append(nodes, map[string]any{"id": task.ID, "type": "video", "metadata": meta})
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"] = nodes
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}

	if err := svc.recoverPendingCanvasFailures(0); err != nil {
		t.Fatal(err)
	}
	if meta := readProgressNodeMeta(t, svc, canvasID, "video-rejected"); meta["status"] != "error" || nodeTaskOutcome(meta)["phase"] != "failed" {
		t.Fatalf("rejected video not shown as failed: %+v", meta)
	}
	for _, id := range []string{"video-pending-result", "video-retrying"} {
		if meta := readProgressNodeMeta(t, svc, canvasID, id); meta["status"] != "loading" || meta["taskOutcome"] != nil {
			t.Fatalf("%s must keep waiting: %+v", id, meta)
		}
	}
	if meta := readProgressNodeMeta(t, svc, canvasID, "video-kept-media"); meta["status"] != "success" || meta["taskOutcome"] != nil {
		t.Fatalf("node with media was overwritten: %+v", meta)
	}
	// The client's explanation of the same failure stays; only the outcome is added.
	if meta := readProgressNodeMeta(t, svc, canvasID, "video-explained"); meta["errorDetails"] != "当前模型不支持生成声音，请关闭声音后重试" || nodeTaskOutcome(meta)["phase"] != "failed" {
		t.Fatalf("client failure explanation replaced: %+v", meta)
	}
	settling := readProgressNodeMeta(t, svc, canvasID, "video-settling")
	if settling["status"] != "error" || nodeTaskOutcome(settling)["regenerate"] != "blocked" {
		t.Fatalf("settling failure should block regeneration: %+v", settling)
	}

	// Settlement finishes later; the next pass follows the task's new outcome,
	// including a charge that leaves the result to be retrieved.
	updateTask(t, svc, "video-settling", map[string]any{"beef_billing_state": "refunded"})
	updateTask(t, svc, "video-charged", map[string]any{"beef_billing_state": "settled"})
	if err := svc.recoverPendingCanvasFailures(0); err != nil {
		t.Fatal(err)
	}
	if outcome := nodeTaskOutcome(readProgressNodeMeta(t, svc, canvasID, "video-settling")); outcome["regenerate"] != "allowed" {
		t.Fatalf("refunded failure still blocked: %+v", outcome)
	}
	if outcome := nodeTaskOutcome(readProgressNodeMeta(t, svc, canvasID, "video-charged")); outcome["phase"] != "retrievable" {
		t.Fatalf("charged task still shown as being checked: %+v", outcome)
	}
	for _, id := range []string{"video-pending-result", "video-retrying"} {
		if meta := readProgressNodeMeta(t, svc, canvasID, id); meta["status"] != "loading" || meta["taskOutcome"] != nil {
			t.Fatalf("%s must keep waiting on later passes: %+v", id, meta)
		}
	}

	// A node that comes to reference a failed task after a pass skipped it, and
	// a canvas restored to before the writeback, are both caught on a later pass.
	mutateProgressNode(t, svc, canvasID, "video-retrying", func(meta map[string]any) {
		meta["taskClientOperationId"], meta["generationSubmissionState"] = "proposal:external-old:video-retrying", "accepted"
	})
	mutateProgressNode(t, svc, canvasID, "video-rejected", func(meta map[string]any) {
		meta["status"], meta["taskStatus"] = "loading", "queued"
		delete(meta, "taskOutcome")
	})
	if err := svc.recoverPendingCanvasFailures(0); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"video-retrying", "video-rejected"} {
		if meta := readProgressNodeMeta(t, svc, canvasID, id); meta["status"] != "error" || nodeTaskOutcome(meta)["phase"] != "failed" {
			t.Fatalf("%s not written back on a later pass: %+v", id, meta)
		}
	}
}
