package agentbridge

import (
	"encoding/json"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
)

func TestLegacyBrowserSchemasRemainValidAndRequireCostConsent(t *testing.T) {
	seen := make(map[string]bool)
	for _, tool := range Tools() {
		if seen[tool.Name] {
			t.Fatalf("duplicate schema: %s", tool.Name)
		}
		seen[tool.Name] = true
		encoded, err := json.Marshal(tool.InputSchema)
		if err != nil {
			t.Fatal(err)
		}
		var schema jsonschema.Schema
		if err := json.Unmarshal(encoded, &schema); err != nil {
			t.Fatal(err)
		}
		resolved, err := schema.Resolve(nil)
		if err != nil {
			t.Fatalf("%s: %v", tool.Name, err)
		}
		if tool.Name == "task_submit" {
			input := map[string]any{"canvasId": "canvas", "type": "video", "model": "fixture", "prompt": "fixture", "idempotencyKey": "one"}
			if err := resolved.Validate(input); err == nil {
				t.Fatal("generation no longer requires consent")
			}
			input["consent"] = map[string]any{"approved": false, "scope": "not approved"}
			if err := resolved.Validate(input); err == nil {
				t.Fatal("rejected consent was accepted")
			}
			input["consent"] = map[string]any{"approved": true, "scope": "one fixture task"}
			if err := resolved.Validate(input); err != nil {
				t.Fatal(err)
			}
		}
	}
	if !seen["task_submit"] {
		t.Fatal("legacy browser schema missing")
	}
}
