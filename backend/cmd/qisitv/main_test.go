package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
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

func TestRetiredNativeProtocolNeverReadsCredentialsOrCallsWorkspace(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	t.Setenv("QISITV_URL", server.URL+"/api")
	t.Setenv("QISITV_TOKEN_FILE", filepath.Join(t.TempDir(), "must-not-read"))
	for _, operation := range []string{"canvas_list", "canvas_create", "canvas_add_node", "task_submit", "asset_import"} {
		var output bytes.Buffer
		err := run(context.Background(), []string{"call", operation, `{}`}, strings.NewReader(""), &output)
		if err == nil || !strings.Contains(err.Error(), "LEGACY_NATIVE_PROTOCOL_RETIRED") {
			t.Fatalf("%s: expected explicit migration error, got %v", operation, err)
		}
		if output.Len() != 0 {
			t.Fatalf("%s returned a false success", operation)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("retired adapter accessed the workspace")
	}
}
