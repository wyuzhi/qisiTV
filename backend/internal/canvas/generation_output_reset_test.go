package canvas

import "testing"

func TestClearInPlaceGenerationOutputRemovesEveryOutputField(t *testing.T) {
	fields := []string{
		"depthSourceNodeId", "content", "storageKey", "assetId", "resourceId", "url", "dataUrl",
		"previewContent", "videoPreview", "lastFrameUrl", "lastFrameStorageKey",
		"naturalWidth", "naturalHeight", "durationMs", "hasAudio", "bytes", "mimeType",
		"generationEffectKeys", "outputParameterWarning",
	}
	metadata := map[string]any{"prompt": "keep me", "status": "success"}
	for _, key := range fields {
		metadata[key] = "old-metadata-value"
	}
	node := map[string]any{"id": "shot", "type": "video", "title": "keep title", "metadata": metadata}
	for _, key := range []string{"content", "storageKey", "assetId", "resourceId", "url", "dataUrl"} {
		node[key] = "old-node-value"
	}
	if !ClearInPlaceGenerationOutput(node) {
		t.Fatal("clearing an output should report a change")
	}
	for _, key := range fields {
		if _, present := metadata[key]; present {
			t.Fatalf("old metadata field %s survived in-place regeneration", key)
		}
	}
	for _, key := range []string{"content", "storageKey", "assetId", "resourceId", "url", "dataUrl"} {
		if _, present := node[key]; present {
			t.Fatalf("old top-level field %s survived in-place regeneration", key)
		}
	}
	if metadata["prompt"] != "keep me" || metadata["status"] != "success" || node["title"] != "keep title" {
		t.Fatalf("non-output fields changed: node=%+v metadata=%+v", node, metadata)
	}
	if ClearInPlaceGenerationOutput(node) {
		t.Fatal("a clean node should not report a change")
	}
}
