package mcp

import (
	"encoding/json"
	"testing"
)

func TestInProcessSessionInitializeListAndCall(t *testing.T) {
	session := NewSession()
	calls := 0
	session.Register(Tool{
		Name: "qisitv_list_models", Description: "list models",
		InputSchema: map[string]any{"type": "object"},
		Handle: func(arguments json.RawMessage) (any, error) {
			calls++
			return map[string]any{"models": []string{"gpt-test"}}, nil
		},
	})
	if _, err := session.Initialize(); err != nil {
		t.Fatal(err)
	}
	tools, err := session.ListTools()
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 1 || tools[0]["name"] != "qisitv_list_models" {
		t.Fatalf("tools = %#v", tools)
	}
	result, err := session.CallTool("qisitv_list_models", map[string]any{})
	if err != nil || result.IsError || calls != 1 {
		t.Fatalf("call = %#v err=%v calls=%d", result, err, calls)
	}
	if len(result.Content) == 0 || result.Content[0]["text"] == "" {
		t.Fatalf("missing protocol content: %#v", result)
	}
}

func TestToolsCallRequiresInitialize(t *testing.T) {
	session := NewSession()
	session.Register(Tool{Name: "qisitv_get_task", InputSchema: map[string]any{"type": "object"}, Handle: func(json.RawMessage) (any, error) { return map[string]any{}, nil }})
	if _, err := session.CallTool("qisitv_get_task", map[string]any{"taskId": "x"}); err == nil {
		t.Fatal("uninitialized session must fail")
	}
}
