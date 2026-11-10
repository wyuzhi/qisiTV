package operations

import (
	"encoding/json"
	"strings"
	"testing"
)

// MCP 注册工具时直接把 descriptor.Params 当作 InputSchema；这里断言同一份 schema
// 在根级没有 oneOf/anyOf/allOf，严格校验的工具端点不会因此拒绝整份工具清单。
func TestCanvasTimelineUpdateModelSchemaHasNoRootCombinator(t *testing.T) {
	registry := NewRegistry(nil, nil)
	RegisterDefaultOps(registry)
	descriptor, ok := registry.Descriptor("canvas.timeline.update")
	if !ok {
		t.Fatal("canvas.timeline.update is not registered")
	}
	var schema map[string]any
	if err := json.Unmarshal(descriptor.Params, &schema); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"oneOf", "anyOf", "allOf"} {
		if _, exists := schema[key]; exists {
			t.Fatalf("root-level %s reaches model tool schema: %s", key, descriptor.Params)
		}
	}
	description, _ := schema["description"].(string)
	if !strings.Contains(description, "timeline 与 refreshNodeIds 必须且只能提供一个") {
		t.Fatalf("two-mode constraint missing from description: %q", description)
	}
	properties, _ := schema["properties"].(map[string]any)
	for _, key := range []string{"timeline", "refreshNodeIds"} {
		if _, exists := properties[key]; !exists {
			t.Fatalf("mode %s missing from schema", key)
		}
	}
}
