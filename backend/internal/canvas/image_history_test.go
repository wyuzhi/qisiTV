package canvas

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/assets"
)

func TestApplyGenerationBindMetadataPreservesAndAppendsImageHistory(t *testing.T) {
	metadata := map[string]any{
		"status":          "success",
		"taskId":          "task-1",
		"storageKey":      "resource:res-img-1",
		"content":         "/api/resources/res-img-1/file",
		"assetId":         "asset-1",
		"naturalWidth":    float64(1920),
		"naturalHeight":   float64(1080),
		"bytes":           float64(1048576),
		"mimeType":        "image/png",
		"model":           "seedream-3.0",
		"size":            "16:9",
		"quality":         "2K",
		"prompt":          "第一版古殿冷光",
		"taskCompletedAt": "2026-11-16T08:00:00Z",
	}

	applyGenerationBindMetadata(metadata, TaskOutputBind{
		CanvasID:        "canvas-1",
		NodeID:          "node-1",
		TaskID:          "task-2",
		OutputIndex:     0,
		MediaType:       "image",
		AssetID:         "asset-2",
		ResourceID:      "res-img-2",
		StorageKey:      "resource:res-img-2",
		Content:         "/api/resources/res-img-2/file",
		MimeType:        "image/png",
		Bytes:           2097152,
		Width:           1536,
		Height:          640,
		TaskType:        "canvas_image",
		TaskPrompt:      "第二版暖光走廊",
		TaskModel:       "seedream-3.0",
		TaskSize:        "21:9",
		TaskQuality:     "1K",
		TaskCompletedAt: "2026-11-16T08:10:00Z",
	})

	if got := nodeString(metadata, "storageKey"); got != "resource:res-img-2" {
		t.Fatalf("expected active storageKey resource:res-img-2, got %q", got)
	}
	rawHistory, ok := metadata["imageHistory"].([]any)
	if !ok || len(rawHistory) != 2 {
		t.Fatalf("expected 2 imageHistory entries, got %#v", metadata["imageHistory"])
	}
	first, _ := rawHistory[0].(map[string]any)
	second, _ := rawHistory[1].(map[string]any)
	if nodeString(first, "storageKey") != "resource:res-img-1" || nodeString(first, "prompt") != "第一版古殿冷光" {
		t.Fatalf("unexpected first history entry: %#v", first)
	}
	if nodeString(second, "storageKey") != "resource:res-img-2" || nodeString(second, "size") != "21:9" || nodeString(second, "quality") != "1K" {
		t.Fatalf("unexpected second history entry: %#v", second)
	}

	// Verify resource reference scanner protects historical resources even after active storageKey moved to res-img-2.
	docBytes, err := json.Marshal(map[string]any{
		"nodes": []any{map[string]any{"id": "node-1", "type": "image", "metadata": metadata}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !assets.DocumentReferences(string(docBytes), map[string]struct{}{"res-img-1": {}}) {
		t.Fatal("expected historical resource res-img-1 to remain referenced by canvas document")
	}
	if !assets.DocumentReferences(string(docBytes), map[string]struct{}{"res-img-2": {}}) {
		t.Fatal("expected active resource res-img-2 to remain referenced by canvas document")
	}
}

func TestApplyGenerationBindMetadataPreservesExistingHistoryGenerationFields(t *testing.T) {
	metadata := map[string]any{
		"status":        "success",
		"taskId":        "task-1",
		"storageKey":    "resource:res-img-1",
		"content":       "/api/resources/res-img-1/file",
		"assetId":       "asset-1",
		"naturalWidth":  float64(1920),
		"naturalHeight": float64(1080),
		"bytes":         float64(1048576),
		"mimeType":      "image/png",
		// Live node config edited by user before submitting v3 must NOT overwrite archived v1 params.
		"model":   "edited-live-model",
		"size":    "1:1",
		"quality": "4K",
		"prompt":  "用户在输入框修改后的草稿",
		"imageHistory": []any{
			map[string]any{
				"id":         "task-1:0",
				"taskId":     "task-1",
				"storageKey": "resource:res-img-1",
				"content":    "/api/resources/res-img-1/file",
				"model":      "seedream-v1",
				"size":       "16:9",
				"quality":    "2K",
				"prompt":     "第一版真实归档提示词",
				"createdAt":  "2026-11-16T08:00:00Z",
			},
			map[string]any{
				"id":         "task-2:0",
				"taskId":     "task-2",
				"storageKey": "resource:res-img-2",
				"content":    "/api/resources/res-img-2/file",
				"assetId":    "asset-2",
				"model":      "seedream-v2",
				"size":       "21:9",
				"quality":    "1K",
				"prompt":     "第二版真实归档提示词",
				"createdAt":  "2026-11-16T08:10:00Z",
			},
		},
	}

	applyGenerationBindMetadata(metadata, TaskOutputBind{
		CanvasID:        "canvas-1",
		NodeID:          "node-1",
		TaskID:          "task-3",
		OutputIndex:     0,
		MediaType:       "image",
		AssetID:         "asset-3",
		ResourceID:      "res-img-3",
		StorageKey:      "resource:res-img-3",
		Content:         "/api/resources/res-img-3/file",
		MimeType:        "image/webp",
		Bytes:           512000,
		Width:           1280,
		Height:          536,
		TaskType:        "canvas_image",
		TaskPrompt:      "第三版真实归档提示词",
		TaskModel:       "seedream-v3",
		TaskSize:        "21:9",
		TaskQuality:     "1K",
		TaskCompletedAt: "2026-11-16T08:20:00Z",
	})

	rawHistory, ok := metadata["imageHistory"].([]any)
	if !ok || len(rawHistory) != 3 {
		t.Fatalf("expected 3 imageHistory entries, got %#v", metadata["imageHistory"])
	}
	v1, _ := rawHistory[0].(map[string]any)
	if nodeString(v1, "prompt") != "第一版真实归档提示词" || nodeString(v1, "model") != "seedream-v1" || nodeString(v1, "size") != "16:9" || nodeString(v1, "quality") != "2K" {
		t.Fatalf("archived v1 generation fields were overwritten by live node metadata: %#v", v1)
	}
	if nodeString(v1, "assetId") != "asset-1" {
		t.Fatalf("expected missing assetId on v1 to be backfilled, got %#v", v1)
	}
}

func TestApplyGenerationBindMetadataPreservesEntryIdentityAndHonorsTombstones(t *testing.T) {
	metadata := map[string]any{
		"status":     "loading",
		"taskId":     "task-3",
		"storageKey": "resource:res-img-1",
		"content":    "/api/resources/res-img-1/file",
		"assetId":    "asset-1",
		"imageHistoryRemovedIds": []any{
			"task-removed:0",
		},
		"imageHistory": []any{
			map[string]any{
				"id":          "task-1:0",
				"taskId":      "task-1",
				"outputIndex": 0,
				"storageKey":  "resource:res-img-1",
				"content":     "/api/resources/res-img-1/file",
				"prompt":      "归档第一版",
			},
			map[string]any{
				"id":          "task-removed:0",
				"taskId":      "task-removed",
				"outputIndex": 0,
				"storageKey":  "resource:res-img-removed",
				"content":     "/api/resources/res-img-removed/file",
				"prompt":      "已移除版本",
			},
		},
	}

	applyGenerationBindMetadata(metadata, TaskOutputBind{
		CanvasID:    "canvas-1",
		NodeID:      "node-1",
		TaskID:      "task-3",
		OutputIndex: 0,
		MediaType:   "image",
		AssetID:     "asset-3",
		ResourceID:  "res-img-3",
		StorageKey:  "resource:res-img-3",
		Content:     "/api/resources/res-img-3/file",
		TaskPrompt:  "第三版新生成",
	})

	rawHistory, ok := metadata["imageHistory"].([]any)
	if !ok || len(rawHistory) != 2 {
		t.Fatalf("expected 2 entries (v1 + v3, removed omitted), got %#v", metadata["imageHistory"])
	}
	v1, _ := rawHistory[0].(map[string]any)
	if nodeString(v1, "id") != "task-1:0" || nodeString(v1, "taskId") != "task-1" {
		t.Fatalf("archived v1 identity was relabeled by live taskId: %#v", v1)
	}
	v3, _ := rawHistory[1].(map[string]any)
	if nodeString(v3, "id") != "task-3:0" || nodeString(v3, "taskId") != "task-3" {
		t.Fatalf("unexpected v3 identity: %#v", v3)
	}
}

func TestClearInPlaceGenerationOutputArchivesImageBeforeClearingAndBindsNextShot(t *testing.T) {
	metadata := map[string]any{
		"status":          "success",
		"taskId":          "task-old",
		"taskOutputIndex": 0,
		"storageKey":      "resource:res-old",
		"content":         "/api/resources/res-old/file",
		"assetId":         "asset-old",
		"model":           "seedream-3.0",
		"size":            "16:9",
		"quality":         "2K",
		"prompt":          "外部重做前的主图",
		"taskCompletedAt": "2026-11-16T09:00:00Z",
	}
	node := map[string]any{
		"id":       "node-ext-1",
		"type":     "image",
		"metadata": metadata,
	}

	if !ClearInPlaceGenerationOutput(node) {
		t.Fatal("expected ClearInPlaceGenerationOutput to report change")
	}
	ClearGenerationAttemptMetadata(metadata)
	metadata["status"] = "idle"

	if nodeString(metadata, "content") != "" || nodeString(metadata, "storageKey") != "" {
		t.Fatalf("expected active media cleared on release, got %#v", metadata)
	}
	archived, ok := metadata["imageHistory"].([]any)
	if !ok || len(archived) != 1 {
		t.Fatalf("expected outgoing image archived during ClearInPlaceGenerationOutput, got %#v", metadata["imageHistory"])
	}
	firstArchived, _ := archived[0].(map[string]any)
	if nodeString(firstArchived, "id") != "task-old:0" || nodeString(firstArchived, "storageKey") != "resource:res-old" || nodeString(firstArchived, "assetId") != "asset-old" {
		t.Fatalf("unexpected archived outgoing image: %#v", firstArchived)
	}
	if ClearInPlaceGenerationOutput(node) {
		t.Fatal("expected second ClearInPlaceGenerationOutput on cleared image node to report false")
	}

	applyGenerationBindMetadata(metadata, TaskOutputBind{
		CanvasID:        "canvas-1",
		NodeID:          "node-ext-1",
		TaskID:          "task-new",
		OutputIndex:     0,
		MediaType:       "image",
		AssetID:         "asset-new",
		ResourceID:      "res-new",
		StorageKey:      "resource:res-new",
		Content:         "/api/resources/res-new/file",
		TaskPrompt:      "外部重做后的新图",
		TaskModel:       "seedream-3.0",
		TaskCompletedAt: "2026-11-16T09:05:00Z",
	})

	finalHistory, ok := metadata["imageHistory"].([]any)
	if !ok || len(finalHistory) != 2 {
		t.Fatalf("expected 2 entries after external release + bind, got %#v", metadata["imageHistory"])
	}
	s1, _ := finalHistory[0].(map[string]any)
	s2, _ := finalHistory[1].(map[string]any)
	if nodeString(s1, "storageKey") != "resource:res-old" || nodeString(s2, "storageKey") != "resource:res-new" {
		t.Fatalf("expected both old and new resources preserved, got %#v", finalHistory)
	}
}

func TestApplyGenerationBindMetadataPreservesPreUpgradeMediaWhenTaskIdAlreadyOverwritten(t *testing.T) {
	// Simulates assistant_production writing the new taskId onto a pre-upgrade image node
	// whose outgoing media is not yet in imageHistory.
	metadata := map[string]any{
		"status":     "loading",
		"taskId":     "task-new",
		"storageKey": "resource:res-preupgrade",
		"content":    "/api/resources/res-preupgrade/file",
		"assetId":    "asset-preupgrade",
		"prompt":     "助手重做前的旧图",
	}

	applyGenerationBindMetadata(metadata, TaskOutputBind{
		CanvasID:    "canvas-1",
		NodeID:      "node-assistant-1",
		TaskID:      "task-new",
		OutputIndex: 0,
		MediaType:   "image",
		AssetID:     "asset-new",
		ResourceID:  "res-new",
		StorageKey:  "resource:res-new",
		Content:     "/api/resources/res-new/file",
		TaskPrompt:  "助手重做后的新图",
	})

	rawHistory, ok := metadata["imageHistory"].([]any)
	if !ok || len(rawHistory) != 2 {
		t.Fatalf("expected both pre-upgrade image and new task output preserved without id collision, got %#v", metadata["imageHistory"])
	}
	oldShot, _ := rawHistory[0].(map[string]any)
	newShot, _ := rawHistory[1].(map[string]any)
	if nodeString(oldShot, "id") != "storage:resource:res-preupgrade" || nodeString(oldShot, "storageKey") != "resource:res-preupgrade" {
		t.Fatalf("unexpected outgoing pre-upgrade entry: %#v", oldShot)
	}
	if nodeString(newShot, "id") != "task-new:0" || nodeString(newShot, "storageKey") != "resource:res-new" {
		t.Fatalf("unexpected new shot entry: %#v", newShot)
	}
}
