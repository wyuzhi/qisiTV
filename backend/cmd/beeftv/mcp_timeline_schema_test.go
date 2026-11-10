package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"infinite-canvas/backend/internal/operations"
)

// runMCP registers descriptor.Params verbatim as the tool InputSchema. A root-level
// oneOf makes strict tool endpoints reject the whole tool list, so the schema that a
// real `beeftv mcp serve` lists must not carry one.
func TestMCPTimelineUpdateSchemaHasNoRootCombinator(t *testing.T) {
	registry := operations.NewRegistry(nil, nil)
	operations.RegisterDefaultOps(registry)
	descriptor, ok := registry.Descriptor("canvas.timeline.update")
	if !ok {
		t.Fatal("canvas.timeline.update is not registered")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/ops") {
			payload, err := json.Marshal(map[string]any{"code": 0, "data": map[string]any{"ops": []any{map[string]any{
				"id":       descriptor.ID,
				"summary":  descriptor.Summary,
				"readOnly": descriptor.ReadOnly,
				"scope":    descriptor.Scope,
				"params":   json.RawMessage(descriptor.Params),
			}}}})
			if err != nil {
				t.Error(err)
				return
			}
			_, _ = w.Write(payload)
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":404,"reason":"not_found","msg":"not found"}`))
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	session := connectFixtureMCP(t, ctx, server.URL)
	listed, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	var tool *mcp.Tool
	for _, candidate := range listed.Tools {
		if candidate.Name == "canvas.timeline.update" {
			tool = candidate
		}
	}
	if tool == nil {
		t.Fatal("MCP omitted canvas.timeline.update")
	}
	encoded, err := json.Marshal(tool.InputSchema)
	if err != nil {
		t.Fatal(err)
	}
	var schema map[string]any
	if err := json.Unmarshal(encoded, &schema); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"oneOf", "anyOf", "allOf"} {
		if _, exists := schema[key]; exists {
			t.Fatalf("MCP tool schema has root-level %s: %s", key, encoded)
		}
	}
	description, _ := schema["description"].(string)
	if !strings.Contains(description, "timeline 与 refreshNodeIds 必须且只能提供一个") {
		t.Fatalf("two-mode constraint missing from MCP schema: %q", description)
	}
	properties, _ := schema["properties"].(map[string]any)
	for _, key := range []string{"timeline", "refreshNodeIds"} {
		if _, exists := properties[key]; !exists {
			t.Fatalf("MCP schema lost mode %s: %s", key, encoded)
		}
	}
}
