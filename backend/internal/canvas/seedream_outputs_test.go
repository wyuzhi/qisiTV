package canvas

import (
	"fmt"
	"testing"
)

func TestSeedreamOutputsDoNotOverwriteOrResurrect(t *testing.T) {
	doc := map[string]any{"nodes": []any{map[string]any{"id": "root", "title": "original", "type": "image", "position": map[string]any{"x": 0.0, "y": 0.0}, "width": 340.0, "height": 240.0, "metadata": map[string]any{"taskId": "task", "content": "old-last-image"}}}}
	outputs := []TaskOutputBind{{NodeID: "root", TaskID: "task", OutputIndex: 0, Content: "base", EffectKey: "base-effect"}, {NodeID: "derived-1", TaskID: "task", OutputIndex: 1, Content: "transparent-layer", EffectKey: "layer-effect"}}
	layers := map[int]map[string]any{1: {"name": "teapot", "z_index": 1.0, "bounding_box": map[string]any{"absolute": []any{1.0, 2.0, 3.0, 4.0}}}}
	if !prepareSeedreamOutputs(doc, "root", "task", outputs, layers) {
		t.Fatal("not expanded")
	}
	if len(canvasDocNodes(doc)) != 2 || nodeString(nodeMetadata(findCanvasNode(doc, "root")), "content") != "base" {
		t.Fatal("original overwritten")
	}
	child := findCanvasNode(doc, "derived-1")
	if nodeString(nodeMetadata(child), "content") != "transparent-layer" || nodeMetadata(child)["imageLayer"] == nil {
		t.Fatal("layer missing")
	}
	if prepareSeedreamOutputs(doc, "root", "task", outputs, layers) {
		t.Fatal("not idempotent")
	}
	doc["nodes"] = []any{findCanvasNode(doc, "root")}
	if prepareSeedreamOutputs(doc, "root", "task", outputs, layers) || len(canvasDocNodes(doc)) != 1 {
		t.Fatal("deleted output resurrected")
	}
	findCanvasNode(doc, "root")["metadata"] = map[string]any{"taskId": "new-task"}
	if prepareSeedreamOutputs(doc, "root", "task", outputs, layers) {
		t.Fatal("new request overwritten")
	}
	doc["nodes"] = []any{}
	if prepareSeedreamOutputs(doc, "root", "task", outputs, layers) {
		t.Fatal("deleted root recreated")
	}
}

func TestSeedream55ExpandsUpToDefault30AndMax100LayerOutputs(t *testing.T) {
	doc := map[string]any{"nodes": []any{map[string]any{"id": "root", "title": "poster", "type": "image", "position": map[string]any{"x": 0.0, "y": 0.0}, "width": 340.0, "height": 240.0, "metadata": map[string]any{"taskId": "task-55"}}}}
	outputs := make([]TaskOutputBind, 0, 31)
	outputs = append(outputs, TaskOutputBind{NodeID: "root", TaskID: "task-55", OutputIndex: 0, Content: "base", EffectKey: "effect-0"})
	for i := 1; i < 30; i++ {
		outputs = append(outputs, TaskOutputBind{
			NodeID: fmt.Sprintf("image-output-task-55-%d", i), TaskID: "task-55", OutputIndex: i,
			Content: fmt.Sprintf("layer-%d", i), EffectKey: fmt.Sprintf("effect-%d", i),
		})
	}
	outputs = append(outputs, TaskOutputBind{NodeID: "overflow", TaskID: "task-55", OutputIndex: 100, Content: "ignored", EffectKey: "effect-100"})
	if !prepareSeedreamOutputs(doc, "root", "task-55", outputs, nil) {
		t.Fatal("expected 30 outputs to expand")
	}
	if got := len(canvasDocNodes(doc)); got != 30 {
		t.Fatalf("expected 30 bound nodes (0..29) and index 100 ignored, got %d", got)
	}
	if findCanvasNode(doc, "image-output-task-55-29") == nil || findCanvasNode(doc, "overflow") != nil {
		t.Fatal("expected layer 29 bound and overflow 100 rejected")
	}
}
