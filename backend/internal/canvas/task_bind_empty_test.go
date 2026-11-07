package canvas

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/writechange"
)

func TestEmptyRenderBindingRequiresTrustedFlagAndEmptyVideo(t *testing.T) {
	patch := TaskOutputBind{AllowEmptyVideo: true, MediaType: "video"}
	for _, tc := range []struct {
		name  string
		node  map[string]any
		allow bool
	}{
		{"empty video", map[string]any{"type": "video"}, true},
		{"other node", map[string]any{"type": "image"}, false},
		{"old task", map[string]any{"type": "video", "metadata": map[string]any{"taskId": "old"}}, false},
		{"old media", map[string]any{"type": "video", "content": "resource:old"}, false},
		{"asset", map[string]any{"type": "video", "metadata": map[string]any{"assetId": "old"}}, false},
		{"unexpected map", map[string]any{"type": "video", "content": map[string]any{}}, false},
		{"unexpected slice", map[string]any{"type": "video", "metadata": map[string]any{"storageKey": []any{}}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := canBindEmptyRenderNode(tc.node, patch); got != tc.allow {
				t.Fatalf("got %v want %v", got, tc.allow)
			}
		})
	}
	patch.AllowEmptyVideo = false
	if canBindEmptyRenderNode(map[string]any{"type": "video"}, patch) {
		t.Fatal("untrusted patch allowed")
	}
	if err := json.Unmarshal([]byte(`{"AllowEmptyVideo":true}`), &patch); err != nil {
		t.Fatal(err)
	}
	if patch.AllowEmptyVideo {
		t.Fatal("internal flag accepted from JSON")
	}
}

func TestBindTaskOutputReconcilesUnboundStoredMediaNodes(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	now := time.Now().UTC()
	for _, id := range []string{"res-ref", "res-video", "res-old-video"} {
		resource := model.Resource{
			ID: id, UserID: "owner", Status: model.ResourceStatusReady,
			Provider: "local", ObjectKey: "users/owner/media/" + id,
			CreatedAt: now, UpdatedAt: now,
		}
		if err := svc.repo.CreateResource(&resource); err != nil {
			t.Fatal(err)
		}
	}
	for _, rawAsset := range []string{
		`{"id":"asset-ref","kind":"image","title":"参考图","coverUrl":"/api/resources/res-ref/file","tags":[],"status":"confirmed","source":"Canvas","data":{"dataUrl":"","storageKey":"resource:res-ref","width":1,"height":1,"bytes":1,"mimeType":"image/png"}}`,
		`{"id":"asset-old-video","kind":"video","title":"旧视频","coverUrl":"","tags":[],"status":"confirmed","source":"生成任务","data":{"url":"/api/resources/res-old-video/file","storageKey":"resource:res-old-video","width":720,"height":1280,"bytes":200,"mimeType":"video/mp4"}}`,
		`{"id":"asset-video","kind":"video","title":"生成视频","coverUrl":"","tags":[],"status":"confirmed","source":"生成任务","data":{"url":"/api/resources/res-video/file","storageKey":"resource:res-video","width":1280,"height":720,"bytes":100,"mimeType":"video/mp4"}}`,
	} {
		if _, err := svc.UpsertUserAsset("owner", json.RawMessage(rawAsset)); err != nil {
			t.Fatal(err)
		}
	}
	// Stored canvas directly in repo has an unbound reference image node and batch-root node pointing to res-ref.
	storedProject := model.CanvasProject{
		ID:       "canvas-bind-reconcile",
		UserID:   "owner",
		Title:    "分镜画布",
		Revision: 0,
		PayloadJSON: `{
			"id":"canvas-bind-reconcile",
			"title":"分镜画布",
			"nodes":[
				{"id":"ref-slot","type":"image","metadata":{"storageKey":"resource:res-ref","content":"/api/resources/res-ref/file"}},
				{"id":"batch-root","type":"image","metadata":{"isBatchRoot":true,"primaryImageId":"ref-slot","storageKey":"resource:res-ref","content":"/api/resources/res-ref/file"}},
				{"id":"video-node","type":"video","metadata":{"taskId":"task-seedance","status":"loading","taskOutcome":{"phase":"running","regenerate":"blocked","reason":"task_running"},"taskOutcomeSource":"canvas_task","generationFailure":"previous","generationPreflightError":"preflight","content":"/api/resources/res-old-video/file","storageKey":"resource:res-old-video","assetId":"asset-old-video","videoPreview":{"content":"/api/resources/res-ref/file","storageKey":"resource:res-ref"},"previewContent":"/api/resources/res-ref/file","durationMs":9000,"hasAudio":true}}
			],
			"connections":[]
		}`,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := SaveDocumentWithHistory(svc.repo, nil, &storedProject, "automatic"); err != nil {
		t.Fatal(err)
	}

	result, err := svc.BindTaskOutputToExistingNode("owner", TaskOutputBind{
		CanvasID:    "canvas-bind-reconcile",
		NodeID:      "video-node",
		TaskID:      "task-seedance",
		OutputIndex: 0,
		EffectKey:   "attach-node:task-seedance:video-node:0",
		MediaType:   "video",
		AssetID:     "asset-video",
		ResourceID:  "res-video",
		StorageKey:  "resource:res-video",
		Content:     "/api/resources/res-video/file",
		MimeType:    "video/mp4",
		Bytes:       100,
		Width:       1280,
		Height:      720,
	})
	if err != nil {
		t.Fatalf("BindTaskOutputToExistingNode failed: %v", err)
	}
	if result.Revision != 2 {
		t.Fatalf("expected revision 2, got %d", result.Revision)
	}
	wantChanged := []writechange.Node{
		{NodeID: "ref-slot", Fields: []string{"assetId"}},
		{NodeID: "batch-root", Fields: []string{"assetId"}},
	}
	if !reflect.DeepEqual(result.AlsoChanged, wantChanged) {
		t.Fatalf("alsoChanged = %#v, want %#v", result.AlsoChanged, wantChanged)
	}
	meta := nodeMetadata(result.Node)
	if nodeString(meta, "storageKey") != "resource:res-video" || nodeString(meta, "content") != "/api/resources/res-video/file" {
		t.Fatalf("new video did not replace retained media: %+v", meta)
	}
	outcome, _ := meta["taskOutcome"].(map[string]any)
	if nodeString(outcome, "phase") != "ready" || nodeString(outcome, "regenerate") != "allowed" {
		t.Fatalf("expected taskOutcome ready/allowed after bind, got %+v", meta["taskOutcome"])
	}
	for _, key := range []string{"videoPreview", "previewContent", "durationMs", "hasAudio", "taskOutcomeSource", "generationFailure", "generationPreflightError"} {
		if _, exists := meta[key]; exists {
			t.Fatalf("new video inherited old output %s: %+v", key, meta[key])
		}
	}
	persisted, err := svc.UserCanvasProject("owner", "canvas-bind-reconcile")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(persisted, &doc); err != nil {
		t.Fatal(err)
	}
	for id, wantAssetID := range map[string]string{
		"ref-slot":   "asset-ref",
		"batch-root": "asset-ref",
		"video-node": "asset-video",
	} {
		node := findCanvasNode(doc, id)
		if got := nodeString(nodeMetadata(node), "assetId"); got != wantAssetID {
			t.Fatalf("node %s assetId = %q, want %q", id, got, wantAssetID)
		}
	}

	// Second call with identical TaskOutputBind on clean ready node must be idempotent (revision stays 2).
	noopResult, err := svc.BindTaskOutputToExistingNode("owner", TaskOutputBind{
		CanvasID:    "canvas-bind-reconcile",
		NodeID:      "video-node",
		TaskID:      "task-seedance",
		OutputIndex: 0,
		EffectKey:   "attach-node:task-seedance:video-node:0",
		MediaType:   "video",
		AssetID:     "asset-video",
		ResourceID:  "res-video",
		StorageKey:  "resource:res-video",
		Content:     "/api/resources/res-video/file",
		MimeType:    "video/mp4",
		Bytes:       100,
		Width:       1280,
		Height:      720,
	})
	if err != nil {
		t.Fatalf("idempotent BindTaskOutputToExistingNode failed: %v", err)
	}
	if noopResult.Revision != 2 {
		t.Fatalf("expected idempotent bind revision 2, got %d", noopResult.Revision)
	}

	// If an already-succeeded node has a stale running taskOutcome, alreadyBound returns false and cleans it up.
	videoNode := findCanvasNode(doc, "video-node")
	videoMeta := nodeMetadata(videoNode)
	videoMeta["taskOutcome"] = map[string]any{"phase": "running", "regenerate": "blocked"}
	videoMeta["taskOutcomeSource"] = "canvas_task"
	if alreadyBound(videoMeta, TaskOutputBind{
		TaskID:     "task-seedance",
		EffectKey:  "attach-node:task-seedance:video-node:0",
		StorageKey: "resource:res-video",
		Content:    "/api/resources/res-video/file",
	}) {
		t.Fatal("expected alreadyBound to return false when taskOutcome is stale running/blocked")
	}
}

func TestBindTaskOutputPreservesDistinctAssetsSharingResource(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	now := time.Now().UTC()
	for _, id := range []string{"res-shared", "res-unbound", "res-secondary", "res-video"} {
		resource := model.Resource{
			ID: id, UserID: "owner", Status: model.ResourceStatusReady,
			Provider: "local", ObjectKey: "users/owner/media/" + id,
			CreatedAt: now, UpdatedAt: now,
		}
		if err := svc.repo.CreateResource(&resource); err != nil {
			t.Fatal(err)
		}
	}
	for _, rawAsset := range []string{
		`{"id":"asset-copy-a","kind":"image","title":"副本A","coverUrl":"/api/resources/res-shared/file","tags":[],"status":"confirmed","source":"Canvas","data":{"dataUrl":"","storageKey":"resource:res-shared","width":1,"height":1,"bytes":1,"mimeType":"image/png"}}`,
		`{"id":"asset-copy-b","kind":"image","title":"副本B","coverUrl":"/api/resources/res-shared/file","tags":[],"status":"confirmed","source":"Canvas","data":{"dataUrl":"","storageKey":"resource:res-shared","width":1,"height":1,"bytes":1,"mimeType":"image/png"}}`,
		`{"id":"asset-unbound","kind":"image","title":"唯一素材","coverUrl":"/api/resources/res-unbound/file","tags":[],"status":"confirmed","source":"Canvas","metadata":{"referenceUrl":"/api/resources/res-secondary/file"},"data":{"dataUrl":"","storageKey":"resource:res-unbound","width":1,"height":1,"bytes":1,"mimeType":"image/png"}}`,
		`{"id":"asset-video","kind":"video","title":"生成视频","coverUrl":"","tags":[],"status":"confirmed","source":"生成任务","data":{"url":"/api/resources/res-video/file","storageKey":"resource:res-video","width":1280,"height":720,"bytes":100,"mimeType":"video/mp4"}}`,
	} {
		if _, err := svc.UpsertUserAsset("owner", json.RawMessage(rawAsset)); err != nil {
			t.Fatal(err)
		}
	}
	// Trigger fallback scan via an unbound node (node-unbound), while node-a and node-b share res-shared with distinct assetIds.
	storedProject := model.CanvasProject{
		ID:       "canvas-shared-res",
		UserID:   "owner",
		Title:    "共享资源画布",
		Revision: 0,
		PayloadJSON: `{
			"id":"canvas-shared-res",
			"title":"共享资源画布",
			"nodes":[
				{"id":"node-a","type":"image","metadata":{"assetId":"asset-copy-a","storageKey":"resource:res-shared","content":"/api/resources/res-shared/file"}},
				{"id":"node-b","type":"image","metadata":{"assetId":"asset-copy-b","storageKey":"resource:res-shared","content":"/api/resources/res-shared/file"}},
				{"id":"node-unbound","type":"image","metadata":{"storageKey":"resource:res-unbound","content":"/api/resources/res-unbound/file"}},
				{"id":"video-node","type":"video","metadata":{"taskId":"task-seedance","status":"loading"}}
			],
			"connections":[]
		}`,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := SaveDocumentWithHistory(svc.repo, nil, &storedProject, "automatic"); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.BindTaskOutputToExistingNode("owner", TaskOutputBind{
		CanvasID:    "canvas-shared-res",
		NodeID:      "video-node",
		TaskID:      "task-seedance",
		OutputIndex: 0,
		EffectKey:   "attach-node:task-seedance:video-node:0",
		MediaType:   "video",
		AssetID:     "asset-video",
		ResourceID:  "res-video",
		StorageKey:  "resource:res-video",
		Content:     "/api/resources/res-video/file",
		MimeType:    "video/mp4",
		Bytes:       100,
		Width:       1280,
		Height:      720,
	}); err != nil {
		t.Fatalf("BindTaskOutputToExistingNode failed: %v", err)
	}
	persisted, err := svc.UserCanvasProject("owner", "canvas-shared-res")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(persisted, &doc); err != nil {
		t.Fatal(err)
	}
	for id, wantAssetID := range map[string]string{
		"node-a":       "asset-copy-a",
		"node-b":       "asset-copy-b",
		"node-unbound": "asset-unbound",
		"video-node":   "asset-video",
	} {
		node := findCanvasNode(doc, id)
		if got := nodeString(nodeMetadata(node), "assetId"); got != wantAssetID {
			t.Fatalf("node %s assetId = %q, want %q", id, got, wantAssetID)
		}
	}

	secondaryDoc := map[string]any{
		"nodes": []any{
			map[string]any{
				"id":   "node-secondary",
				"type": "image",
				"metadata": map[string]any{
					"storageKey": "resource:res-secondary",
					"content":    "/api/resources/res-secondary/file",
				},
			},
		},
	}
	svc.reconcileBoundCanvasDocMediaAssets("owner", secondaryDoc, "")
	secondaryNode := findCanvasNode(secondaryDoc, "node-secondary")
	if got := nodeString(nodeMetadata(secondaryNode), "assetId"); got != "" {
		t.Fatalf("secondary resource node assetId = %q, want empty", got)
	}
}

func TestApplyGenerationBindMetadataSetsReadyTaskOutcomeAndHealsStaleRunning(t *testing.T) {
	patch := TaskOutputBind{
		TaskID:      "task-img-1",
		TaskType:    "image",
		MediaType:   "image",
		EffectKey:   "attach-node:task-img-1:node-1:0",
		AssetID:     "asset-1",
		ResourceID:  "res-1",
		StorageKey:  "resource:res-1",
		Content:     "/api/resources/res-1/file",
		MimeType:    "image/jpeg",
		Bytes:       1024,
		Width:       1024,
		Height:      1024,
		OutputIndex: 0,
	}
	meta := map[string]any{
		"status":     "success",
		"taskId":     "task-img-1",
		"taskStatus": "succeeded",
		"assetId":    "asset-1",
		"storageKey": "resource:res-1",
		"content":    "/api/resources/res-1/file",
		"generationEffectKeys": []any{
			"attach-node:task-img-1:node-1:0",
		},
		"taskOutcome": map[string]any{
			"phase":      "running",
			"regenerate": "blocked",
			"reason":     "in_flight",
		},
		"taskOutcomeSource":        "local",
		"generationFailure":        map[string]any{"version": 1},
		"generationPreflightError": true,
	}
	if alreadyBound(meta, patch) {
		t.Fatal("stale running taskOutcome should not be treated as alreadyBound")
	}
	applyGenerationBindMetadata(meta, patch)
	if !alreadyBound(meta, patch) {
		t.Fatal("bound node with ready taskOutcome should be alreadyBound")
	}
	outcome, ok := meta["taskOutcome"].(map[string]any)
	if !ok || nodeString(outcome, "phase") != "ready" || nodeString(outcome, "regenerate") != "allowed" || nodeString(outcome, "reason") != "result_ready" {
		t.Fatalf("unexpected taskOutcome after bind: %#v", meta["taskOutcome"])
	}
	for _, cleared := range []string{"taskOutcomeSource", "generationFailure", "generationPreflightError"} {
		if _, exists := meta[cleared]; exists {
			t.Fatalf("expected %s to be deleted after bind", cleared)
		}
	}
}
