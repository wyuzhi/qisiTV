package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestToolsListsSchemasWithoutWorkspace(t *testing.T) {
	var out bytes.Buffer
	if err := run(context.Background(), []string{"tools"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	var tools []map[string]any
	if err := json.Unmarshal(out.Bytes(), &tools); err != nil {
		t.Fatal(err)
	}
	if len(tools) < 15 {
		t.Fatalf("incomplete tools: %d", len(tools))
	}
}

func TestMalformedArgumentsFailBeforeAnyCall(t *testing.T) {
	for _, raw := range []string{`{`, `{} {}`, `[]`} {
		var out bytes.Buffer
		if err := run(context.Background(), []string{"call", "canvas_list", "-"}, strings.NewReader(raw), &out); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
