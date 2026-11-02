package app

import (
	"encoding/json"
	"errors"
	"testing"

	"qisitv/backend/internal/assistantturns"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/operations"
	localtask "qisitv/backend/internal/task"
)

func productionProgressFixture(t *testing.T) (*Service, string, string) {
	t.Helper()
	svc, canvasID, _ := newAssistantTurnService(t)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::image","videoModel":"custom::video","audioModel":"custom::speech","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["image","video","speech"],"modelProfiles":[{"model":"image","capability":"image","protocol":"openai-image"},{"model":"video","capability":"video","protocol":"video-generations-json"},{"model":"speech","capability":"audio","protocol":"openai-audio"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"] = []any{
		map[string]any{"id": "image", "type": "image", "title": "首帧", "metadata": map[string]any{"prompt": "茶杯", "size": "9:16", "count": 1}},
		map[string]any{"id": "video", "type": "video", "title": "镜头", "metadata": map[string]any{"prompt": "注入热茶", "size": "9:16", "seconds": 4, "generateAudio": false}},
		map[string]any{"id": "speech", "type": "audio", "title": "旁白", "metadata": map[string]any{"prompt": "先喝一杯热茶。", "audioVoice": "alloy"}},
	}
	doc["connections"] = []any{map[string]any{"id": "reference", "fromNodeId": "image", "toNodeId": "video"}}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	const source = "11223344aabbccdd"
	if _, err := svc.BeginAssistantTurn("local", canvasID, source, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.AssistantTurns().BindDurableSession("local", source, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.FinalizeAssistantTurn(source); err != nil {
		t.Fatal(err)
	}
	targets, err := operations.GenerationTargets(svc.BindDomain(nil), doc, []string{"image", "video", "speech"})
	if err != nil {
		t.Fatal(err)
	}
	if len(targets[1].ReferenceNodeIDs) != 1 || targets[1].ReferenceNodeIDs[0] != "image" {
		t.Fatal("fixture lost the real reference dependency")
	}
	result, err := svc.ConfirmAssistantProduction("local", source, AssistantProductionConfirmation{CanvasID: canvasID, ProposalID: "gp-progress", Kind: "image", NodeIDs: []string{"image"}, Targets: targets})
	if err != nil {
		t.Fatal(err)
	}
	return svc, canvasID, result.(map[string]any)["continuationId"].(string)
}

func progressTask(t *testing.T, svc *Service, nodeID string) model.Task {
	t.Helper()
	var task model.Task
	if err := svc.Database().First(&task, "client_operation_id = ?", "proposal:gp-progress:"+nodeID).Error; err != nil {
		t.Fatal(err)
	}
	return task
}

func completeProgressMaterial(t *testing.T, svc *Service, canvasID, nodeID string) {
	t.Helper()
	task := progressTask(t, svc, nodeID)
	if err := svc.Database().Model(&task).Update("status", model.TaskStatusSucceeded).Error; err != nil {
		t.Fatal(err)
	}
	kind := task.Type[len("canvas_"):]
	resourceID := "material-" + nodeID
	if err := svc.Database().Create(&model.Resource{ID: resourceID, UserID: "local", Status: model.ResourceStatusReady}).Error; err != nil {
		t.Fatal(err)
	}
	output, _ := json.Marshal(localtask.CanonicalOutput{OutputIndex: 0, MediaType: kind, ResourceID: resourceID, TargetBinding: &localtask.TargetBinding{NodeID: nodeID}})
	if err := svc.Database().Create(&model.Result{ID: "result-" + nodeID, UserID: "local", TaskID: task.ID, Kind: localtask.ResultKindGenerationOutput, Payload: string(output)}).Error; err != nil {
		t.Fatal(err)
	}
	asset, _ := json.Marshal(map[string]any{"id": "asset-" + nodeID, "title": nodeID, "kind": kind, "coverUrl": "", "tags": []any{}, "data": map[string]any{"storageKey": "resource:" + resourceID, "width": 1, "height": 1, "bytes": 1, "mimeType": "video/mp4"}})
	if _, err := svc.UpsertUserAsset("local", asset); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	for _, value := range doc["nodes"].([]any) {
		node := value.(map[string]any)
		if node["id"] == nodeID {
			meta := node["metadata"].(map[string]any)
			meta["status"], meta["taskStatus"], meta["storageKey"], meta["assetId"] = "success", "succeeded", "resource:"+resourceID, "asset-"+nodeID
		}
	}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
}

func expectProgressWaiting(t *testing.T, svc *Service, id string, taskCount int64) {
	t.Helper()
	_, err := svc.ClaimAssistantContinuation("local", id)
	var expected *assistantturns.Error
	if !errors.As(err, &expected) || expected.Reason != "continuation_waiting" {
		t.Fatalf("expected committed material preparation, got %v", err)
	}
	var count, turns int64
	svc.Database().Model(&model.Task{}).Count(&count)
	svc.Database().Model(&model.AssistantTurn{}).Count(&turns)
	if count != taskCount || turns != 1 {
		t.Fatalf("tasks=%d want=%d; model turns=%d want=1", count, taskCount, turns)
	}
}

func TestProductionProgressAdvancesOnlySavedDependenciesWithoutModelTurns(t *testing.T) {
	svc, canvasID, id := productionProgressFixture(t)
	// Independent speech starts while the root image is still running.
	expectProgressWaiting(t, svc, id, 2)
	voice := progressTask(t, svc, "speech")
	expectProgressWaiting(t, svc, id, 2)
	if progressTask(t, svc, "speech").ID != voice.ID {
		t.Fatal("repeated scan bought another voice")
	}
	image := progressTask(t, svc, "image")
	svc.Database().Model(&image).Update("status", model.TaskStatusSucceeded)
	expectProgressWaiting(t, svc, id, 2) // upstream success alone is insufficient.
	completeProgressMaterial(t, svc, canvasID, "image")
	expectProgressWaiting(t, svc, id, 3)
	video := progressTask(t, svc, "video")
	var input struct {
		ReferenceImages []struct {
			StorageKey string `json:"storageKey"`
		} `json:"referenceImages"`
	}
	if err := json.Unmarshal([]byte(video.InputJSON), &input); err != nil || len(input.ReferenceImages) != 1 || input.ReferenceImages[0].StorageKey != "resource:material-image" {
		t.Fatal("video did not use the saved confirmed image", err)
	}
	for range 3 {
		expectProgressWaiting(t, svc, id, 3)
	}
	completeProgressMaterial(t, svc, canvasID, "video")
	completeProgressMaterial(t, svc, canvasID, "speech")
	claim, err := svc.ClaimAssistantContinuation("local", id)
	if err != nil || claim.State != "claimed" {
		t.Fatalf("ready materials did not wake Pi: %v %v", claim, err)
	}
	replay, err := svc.ClaimAssistantContinuation("local", id)
	if err != nil || replay.TurnID != claim.TurnID || progressTask(t, svc, "video").ID != video.ID {
		t.Fatal("claim replay changed identities", err)
	}
}

func TestProductionProgressStopRevokesFurtherAdmissions(t *testing.T) {
	svc, canvasID, id := productionProgressFixture(t)
	if err := svc.AssistantTurns().CancelContinuations("local", canvasID, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ClaimAssistantContinuation("local", id); err == nil {
		t.Fatal("stopped receipt was revived")
	}
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 1 {
		t.Fatal("stop dispatched another paid task", count)
	}
}

func TestProductionProgressFailedTaskWakesPiWithoutRepurchase(t *testing.T) {
	svc, _, id := productionProgressFixture(t)
	image := progressTask(t, svc, "image")
	svc.Database().Model(&image).Updates(map[string]any{"status": model.TaskStatusFailed, "error": "upstream failed"})
	claim, err := svc.ClaimAssistantContinuation("local", id)
	if err != nil || claim.State != "claimed" {
		t.Fatalf("original failure not offered to Pi: %v %v", claim, err)
	}
	if _, err := svc.ClaimAssistantContinuation("local", id); err != nil {
		t.Fatal(err)
	}
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 1 || progressTask(t, svc, "image").ID != image.ID {
		t.Fatal("failure caused another purchase", count)
	}
}

func TestProductionProgressFailureWaitsForAdmittedSibling(t *testing.T) {
	svc, canvasID, id := productionProgressFixture(t)
	expectProgressWaiting(t, svc, id, 2)
	image := progressTask(t, svc, "image")
	svc.Database().Model(&image).Updates(map[string]any{"status": model.TaskStatusFailed, "error": "upstream failed"})
	expectProgressWaiting(t, svc, id, 2)
	completeProgressMaterial(t, svc, canvasID, "speech")
	claim, err := svc.ClaimAssistantContinuation("local", id)
	if err != nil || claim.State != "claimed" {
		t.Fatalf("settled siblings did not wake Pi: %v %v", claim, err)
	}
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 2 {
		t.Fatal("failure purchased a dependent task", count)
	}
}

func TestProductionProgressFailedDependentWaitsForVoice(t *testing.T) {
	svc, canvasID, id := productionProgressFixture(t)
	expectProgressWaiting(t, svc, id, 2)
	completeProgressMaterial(t, svc, canvasID, "image")
	expectProgressWaiting(t, svc, id, 3)
	video := progressTask(t, svc, "video")
	svc.Database().Model(&video).Updates(map[string]any{"status": model.TaskStatusFailed, "error": "maximum concurrency"})
	expectProgressWaiting(t, svc, id, 3)
	completeProgressMaterial(t, svc, canvasID, "speech")
	claim, err := svc.ClaimAssistantContinuation("local", id)
	if err != nil || claim.State != "claimed" {
		t.Fatalf("original failure did not wake after the sibling settled: %v %v", claim, err)
	}
	if progressTask(t, svc, "video").ID != video.ID {
		t.Fatal("failed dependent was replaced")
	}
}

func TestProductionProgressFailureWaitsForSuccessfulSiblingMaterialization(t *testing.T) {
	svc, canvasID, id := productionProgressFixture(t)
	expectProgressWaiting(t, svc, id, 2)
	image, voice := progressTask(t, svc, "image"), progressTask(t, svc, "speech")
	svc.Database().Model(&image).Update("status", model.TaskStatusFailed)
	svc.Database().Model(&voice).Update("status", model.TaskStatusSucceeded)
	// The provider finished, but the canonical file and binding are absent.
	expectProgressWaiting(t, svc, id, 2)
	completeProgressMaterial(t, svc, canvasID, "speech")
	claim, err := svc.ClaimAssistantContinuation("local", id)
	if err != nil || claim.State != "claimed" {
		t.Fatalf("saved sibling did not release original failure: %v %v", claim, err)
	}
	if progressTask(t, svc, "speech").ID != voice.ID {
		t.Fatal("materialization replaced the original task")
	}
}

func TestProductionProgressMaterializationFailureIsReportedWithoutRepurchase(t *testing.T) {
	svc, _, id := productionProgressFixture(t)
	expectProgressWaiting(t, svc, id, 2)
	image, voice := progressTask(t, svc, "image"), progressTask(t, svc, "speech")
	svc.Database().Model(&image).Update("status", model.TaskStatusFailed)
	svc.Database().Model(&voice).Update("status", model.TaskStatusSucceeded)
	output, _ := json.Marshal(localtask.CanonicalOutput{OutputIndex: 0, MediaType: "audio", MaterializationErrorCode: "download_failed", TargetBinding: &localtask.TargetBinding{NodeID: "speech"}})
	if err := svc.Database().Create(&model.Result{ID: "failed-voice-file", UserID: "local", TaskID: voice.ID, Kind: localtask.ResultKindGenerationOutput, Payload: string(output)}).Error; err != nil {
		t.Fatal(err)
	}
	claim, err := svc.ClaimAssistantContinuation("local", id)
	if err != nil || claim.State != "claimed" {
		t.Fatalf("known materialization failure was hidden: %v %v", claim, err)
	}
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 2 {
		t.Fatal("known failure caused another purchase", count)
	}
}

func TestProductionProgressChangedInputsStopFurtherAdmissions(t *testing.T) {
	svc, canvasID, id := productionProgressFixture(t)
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"].([]any)[1].(map[string]any)["metadata"].(map[string]any)["prompt"] = "different paid content"
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ClaimAssistantContinuation("local", id); err == nil {
		t.Fatal("changed paid input was accepted")
	}
	if state := backgroundReceiptState(t, svc, id); state != "cancelled" {
		t.Fatal("changed plan left a waiting receipt", state)
	}
	if _, err := svc.ClaimAssistantContinuation("local", id); err == nil {
		t.Fatal("changed intent was revived")
	}
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 1 {
		t.Fatal("changed plan dispatched more tasks", count)
	}
}

func mutateProgressNode(t *testing.T, svc *Service, canvasID, nodeID string, mutate func(meta map[string]any)) {
	t.Helper()
	raw, err := svc.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, value := range doc["nodes"].([]any) {
		node := value.(map[string]any)
		if node["id"] == nodeID {
			meta, _ := node["metadata"].(map[string]any)
			if meta == nil {
				meta = map[string]any{}
				node["metadata"] = meta
			}
			mutate(meta)
		}
	}
	raw, _ = json.Marshal(doc)
	if _, err = svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
}

func readProgressNodeMeta(t *testing.T, svc *Service, canvasID, nodeID string) map[string]any {
	t.Helper()
	raw, err := svc.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, value := range doc["nodes"].([]any) {
		node := value.(map[string]any)
		if node["id"] == nodeID {
			meta, _ := node["metadata"].(map[string]any)
			return meta
		}
	}
	t.Fatalf("missing node %s", nodeID)
	return nil
}

func expectProgressTargetChanged(t *testing.T, svc *Service, id string) {
	t.Helper()
	_, err := svc.ClaimAssistantContinuation("local", id)
	var expected *assistantturns.Error
	if !errors.As(err, &expected) || expected.Reason != "continuation_target_changed" {
		t.Fatalf("expected continuation_target_changed, got %v", err)
	}
}

func TestProductionProgressStaleFailureAndCancellationNeverOverwriteNewerTaskWithIdenticalParams(t *testing.T) {
	for _, tc := range []struct {
		name         string
		oldStatus    model.TaskStatus
		oldError     string
		newTaskState map[string]any
	}{
		{
			name:      "old-fails-while-new-running",
			oldStatus: model.TaskStatusFailed,
			oldError:  "stale upstream failure",
			newTaskState: map[string]any{
				"taskId":                    "newer-image-task",
				"taskStatus":                "running",
				"status":                    "loading",
				"taskClientOperationId":     "manual:newer-image-task",
				"generationSubmissionState": "accepted",
			},
		},
		{
			name:      "old-fails-after-new-succeeded",
			oldStatus: model.TaskStatusFailed,
			oldError:  "stale upstream failure",
			newTaskState: map[string]any{
				"taskId":                    "newer-image-task",
				"taskStatus":                "succeeded",
				"status":                    "success",
				"storageKey":                "resource:newer-image-output",
				"assetId":                   "asset-newer-image",
				"taskClientOperationId":     "manual:newer-image-task",
				"generationSubmissionState": "accepted",
			},
		},
		{
			name:      "old-cancelled-after-new-succeeded",
			oldStatus: model.TaskStatusCancelled,
			oldError:  "stale cancellation",
			newTaskState: map[string]any{
				"taskId":                    "newer-image-task",
				"taskStatus":                "succeeded",
				"status":                    "success",
				"storageKey":                "resource:newer-image-output",
				"assetId":                   "asset-newer-image",
				"taskClientOperationId":     "manual:newer-image-task",
				"generationSubmissionState": "accepted",
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, canvasID, id := productionProgressFixture(t)
			oldImage := progressTask(t, svc, "image")
			if wantKey, ok := tc.newTaskState["storageKey"].(string); ok && wantKey != "" {
				if err := svc.Database().Create(&model.Resource{ID: "newer-image-output", UserID: "local", Status: model.ResourceStatusReady}).Error; err != nil {
					t.Fatal(err)
				}
				asset, _ := json.Marshal(map[string]any{"id": "asset-newer-image", "title": "newer", "kind": "image", "coverUrl": "", "tags": []any{}, "data": map[string]any{"storageKey": wantKey, "width": 1, "height": 1, "bytes": 1, "mimeType": "image/png"}})
				if _, err := svc.UpsertUserAsset("local", asset); err != nil {
					t.Fatal(err)
				}
			}
			mutateProgressNode(t, svc, canvasID, "image", func(meta map[string]any) {
				for k, v := range tc.newTaskState {
					meta[k] = v
				}
				delete(meta, "error")
				delete(meta, "errorDetails")
			})
			if err := svc.Database().Model(&oldImage).Updates(map[string]any{"status": tc.oldStatus, "error": tc.oldError}).Error; err != nil {
				t.Fatal(err)
			}
			expectProgressTargetChanged(t, svc, id)
			meta := readProgressNodeMeta(t, svc, canvasID, "image")
			if meta["taskId"] != "newer-image-task" || meta["status"] != tc.newTaskState["status"] || meta["taskStatus"] != tc.newTaskState["taskStatus"] || meta["error"] != nil {
				t.Fatalf("stale task receipt overwrote newer node state: %+v", meta)
			}
			if wantKey, ok := tc.newTaskState["storageKey"]; ok && meta["storageKey"] != wantKey {
				t.Fatalf("stale task receipt overwrote newer media: %+v", meta)
			}
			var count int64
			svc.Database().Model(&model.Task{}).Count(&count)
			if count != 1 {
				t.Fatalf("replaced target admitted downstream work: tasks=%d", count)
			}
		})
	}
}

func TestProductionProgressLateOldSuccessNeverOverwritesNewerTaskOrTrapsSibling(t *testing.T) {
	svc, canvasID, id := productionProgressFixture(t)
	// First scan admits independent sibling speech while image is running.
	expectProgressWaiting(t, svc, id, 2)
	oldImage := progressTask(t, svc, "image")
	voice := progressTask(t, svc, "speech")

	// Newer task with identical prompt/parameters takes over image node.
	mutateProgressNode(t, svc, canvasID, "image", func(meta map[string]any) {
		meta["taskId"] = "newer-image-task"
		meta["taskStatus"] = "running"
		meta["status"] = "loading"
		meta["taskClientOperationId"] = "manual:newer-image-task"
		delete(meta, "storageKey")
		delete(meta, "assetId")
	})

	// Old image task finishes late in DB with ready resource and output.
	if err := svc.Database().Model(&oldImage).Update("status", model.TaskStatusSucceeded).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.Database().Create(&model.Resource{ID: "stale-image-res", UserID: "local", Status: model.ResourceStatusReady}).Error; err != nil {
		t.Fatal(err)
	}
	staleOut, _ := json.Marshal(localtask.CanonicalOutput{OutputIndex: 0, MediaType: "image", ResourceID: "stale-image-res", TargetBinding: &localtask.TargetBinding{NodeID: "image"}})
	if err := svc.Database().Create(&model.Result{ID: "stale-image-result", UserID: "local", TaskID: oldImage.ID, Kind: localtask.ResultKindGenerationOutput, Payload: string(staleOut)}).Error; err != nil {
		t.Fatal(err)
	}
	staleAsset, _ := json.Marshal(map[string]any{"id": "asset-stale-image", "title": "stale", "kind": "image", "coverUrl": "", "tags": []any{}, "data": map[string]any{"storageKey": "resource:stale-image-res", "width": 1, "height": 1, "bytes": 1, "mimeType": "image/png"}})
	if _, err := svc.UpsertUserAsset("local", staleAsset); err != nil {
		t.Fatal(err)
	}
	var refreshedOld model.Task
	if err := svc.Database().First(&refreshedOld, "id = ?", oldImage.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.recoverCanvasTaskBindings(refreshedOld); err != nil {
		t.Fatalf("late recovery should skip replaced node cleanly, got %v", err)
	}
	imageMeta := readProgressNodeMeta(t, svc, canvasID, "image")
	if imageMeta["taskId"] != "newer-image-task" || imageMeta["status"] != "loading" || imageMeta["storageKey"] != nil {
		t.Fatalf("late old task binding overwrote newer task on image node: %+v", imageMeta)
	}

	// While sibling speech is still running, continuation waits for sibling to finish saving without admitting dependent video.
	expectProgressWaiting(t, svc, id, 2)

	// Sibling speech finishes saving normally.
	completeProgressMaterial(t, svc, canvasID, "speech")
	speechMeta := readProgressNodeMeta(t, svc, canvasID, "speech")
	if speechMeta["taskId"] != voice.ID || speechMeta["status"] != "success" || speechMeta["storageKey"] != "resource:material-speech" {
		t.Fatalf("sibling speech did not save normally: %+v", speechMeta)
	}

	// Once sibling speech has settled, replaced image target reports continuation_target_changed instead of waiting forever.
	expectProgressTargetChanged(t, svc, id)
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 2 {
		t.Fatalf("dependent video should never be admitted after image target was replaced: tasks=%d", count)
	}
}

func TestProductionProgressRetrievableFailedTasksKeepWaitingUntilRecovered(t *testing.T) {
	svc, canvasID, id := productionProgressFixture(t)
	expectProgressWaiting(t, svc, id, 2)

	// Root image fails with submission_unknown (Outcome.Phase == "retrievable").
	image := progressTask(t, svc, "image")
	if err := svc.Database().Model(&image).Updates(map[string]any{
		"status": model.TaskStatusFailed,
		"stage":  "submission_unknown",
		"error":  "Post: net/http: TLS handshake timeout",
	}).Error; err != nil {
		t.Fatal(err)
	}
	expectProgressWaiting(t, svc, id, 2)
	imageMeta := readProgressNodeMeta(t, svc, canvasID, "image")
	if imageMeta["status"] == "error" {
		t.Fatalf("retrievable image failure should not mark node terminal error early: %+v", imageMeta)
	}

	// Background recovery completes image and speech.
	completeProgressMaterial(t, svc, canvasID, "image")
	completeProgressMaterial(t, svc, canvasID, "speech")
	expectProgressWaiting(t, svc, id, 3)

	// Dependent video fails while upstream still has ProviderRequestID (Outcome.Phase == "retrievable").
	video := progressTask(t, svc, "video")
	if err := svc.Database().Model(&video).Updates(map[string]any{
		"status":              model.TaskStatusFailed,
		"provider_request_id": "provider-video-req-1",
		"error":               "poll timeout",
	}).Error; err != nil {
		t.Fatal(err)
	}
	expectProgressWaiting(t, svc, id, 3)
	videoMeta := readProgressNodeMeta(t, svc, canvasID, "video")
	if videoMeta["status"] == "error" {
		t.Fatalf("retrievable video failure should keep waiting for auto-recovery: %+v", videoMeta)
	}

	// Once video auto-recovery succeeds and binds the node, continuation proceeds.
	completeProgressMaterial(t, svc, canvasID, "video")
	claim, err := svc.ClaimAssistantContinuation("local", id)
	if err != nil || claim.State != "claimed" {
		t.Fatalf("recovered video did not wake continuation: %v %v", claim, err)
	}
}

func TestProductionProgressSucceededTaskWithFetchingResourceWaitsUntilResourceReady(t *testing.T) {
	svc, canvasID, id := productionProgressFixture(t)
	expectProgressWaiting(t, svc, id, 2)

	completeProgressMaterial(t, svc, canvasID, "image")
	completeProgressMaterial(t, svc, canvasID, "speech")
	if err := svc.Database().Model(&model.Resource{}).Where("id = ?", "material-image").Update("status", "pending").Error; err != nil {
		t.Fatal(err)
	}

	// Resource is still "pending" (Outcome.Phase == "fetching"), so dependent video must not be admitted yet.
	expectProgressWaiting(t, svc, id, 2)

	// Once the resource becomes ready, dependent video is admitted.
	if err := svc.Database().Model(&model.Resource{}).Where("id = ?", "material-image").Update("status", model.ResourceStatusReady).Error; err != nil {
		t.Fatal(err)
	}
	expectProgressWaiting(t, svc, id, 3)
}

func TestProductionProgressObservationErrorPreservesWaitingReceiptAndIdentities(t *testing.T) {
	svc, _, id := productionProgressFixture(t)
	image := progressTask(t, svc, "image")
	if err := svc.Database().Model(&image).Update("status", model.TaskStatusSucceeded).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.Database().Create(&model.Result{ID: "corrupt-image-result", UserID: "local", TaskID: image.ID, Kind: localtask.ResultKindGenerationOutput, Payload: "{"}).Error; err != nil {
		t.Fatal(err)
	}
	_, err := svc.ClaimAssistantContinuation("local", id)
	if err == nil {
		t.Fatal("expected observation error from corrupt result payload")
	}
	var turnErr *assistantturns.Error
	if errors.As(err, &turnErr) {
		t.Fatalf("observation error must not be mapped to continuation semantic error: %v", err)
	}
	if state := backgroundReceiptState(t, svc, id); state != "waiting" {
		t.Fatalf("observation error mutated continuation receipt state to %s", state)
	}
}
