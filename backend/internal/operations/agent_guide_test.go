package operations_test

import (
	"encoding/json"
	"testing"

	"qisitv/backend/internal/agentguide"
	"qisitv/backend/internal/operations"
)

func TestAgentGuideReturnsSharedSkillText(t *testing.T) {
	h := newHarness(t)
	result, err := h.execute(t, operations.ExternalCaller(false), "agent.guide", "", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(result.Result)
	if err != nil {
		t.Fatal(err)
	}
	var got agentguide.Guide
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	want := agentguide.Current()
	if got != want {
		t.Fatalf("agent.guide = %+v, want %+v", got, want)
	}
}

func TestAgentGuideIsReadOnlyWorkspaceCapability(t *testing.T) {
	h := newHarness(t)
	descriptor, ok := h.registry.Descriptor("agent.guide")
	if !ok {
		t.Fatal("agent.guide is not registered")
	}
	if !descriptor.ReadOnly || descriptor.Scope != operations.ScopeWorkspaceRead {
		t.Fatalf("agent.guide must be read-only workspace capability: %+v", descriptor)
	}
	if len(descriptor.AssistantModes) != 0 {
		t.Fatalf("agent.guide must not be exposed to the built-in assistant: %v", descriptor.AssistantModes)
	}
	foundExternal := false
	for _, item := range h.registry.List(operations.ExternalCaller(true)) {
		if item.ID == "agent.guide" {
			foundExternal = true
		}
	}
	if !foundExternal {
		t.Fatal("read-only external clients must be able to read the guide")
	}
}

func TestAgentGuideRejectsUnknownParameters(t *testing.T) {
	h := newHarness(t)
	if _, err := h.execute(t, operations.ExternalCaller(false), "agent.guide", "", map[string]any{"path": "/etc/passwd"}); err == nil {
		t.Fatal("agent.guide accepted an unknown parameter")
	}
}
