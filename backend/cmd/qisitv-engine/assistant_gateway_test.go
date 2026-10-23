package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"qisitv/backend/internal/bootstrap"
	"qisitv/backend/internal/browserbridge"
)

// A public-web-shaped client uses only its paired browser session. The real
// supervised Node assistant calls the real Go operation and the project-folder
// writer persists its result. The only model is an in-process loopback fixture.
func TestPairedWebAssistantToolPersistsProjectFolder(t *testing.T) {
	node := os.Getenv("QISITV_TEST_NODE")
	if node == "" {
		t.Skip("QISITV_TEST_NODE is required for the real Node assistant acceptance")
	}
	entry, err := filepath.Abs("../../../agent-host/server.mjs")
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"BEEFTV_AGENT_API_KEY", "BEEFTV_AGENT_BASE_URL", "BEEFTV_AGENT_MODEL", "BEEFTV_AGENT_PROTOCOL", "BEEFTV_AGENT_HOST_TOKEN", "BEEFTV_UI_BOOTSTRAP", "BEEFTV_AGENT_PORT", "BEEFTV_AGENT_HOST_URL", "BEEFTV_AGENT_MAX_REQUESTS", "BEEFTV_AGENT_READ_ONLY"} {
		t.Setenv(key, "")
	}
	t.Setenv("BEEFTV_AGENT_MAX_REQUESTS_PER_TURN", "4")
	t.Setenv("BEEFTV_AGENT_TOTAL_REQUEST_BUDGET", "4")
	var modelCalls atomic.Int32
	var successfulToolResult atomic.Bool
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer fixture-only" {
			http.Error(w, "fixture endpoint only", 400)
			return
		}
		var body struct {
			Model    string `json:"model"`
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || modelCalls.Add(1) > 2 {
			http.Error(w, "unexpected model request", 400)
			return
		}
		var hasTool bool
		for _, message := range body.Messages {
			if message.Role == "tool" {
				hasTool = true
				var result struct {
					Result struct {
						Created []struct {
							ID string `json:"id"`
						} `json:"created"`
					} `json:"result"`
				}
				var text string
				_ = json.Unmarshal(message.Content, &text)
				if json.Unmarshal([]byte(text), &result) == nil && len(result.Result.Created) == 1 && result.Result.Created[0].ID != "" {
					successfulToolResult.Store(true)
				}
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		frame := func(delta any, finish any) {
			raw, _ := json.Marshal(map[string]any{"id": "web-fixture", "object": "chat.completion.chunk", "created": 1, "model": body.Model, "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
			fmt.Fprintf(w, "data: %s\n\n", raw)
			w.(http.Flusher).Flush()
		}
		if !hasTool {
			args, _ := json.Marshal(map[string]any{"expectedRevision": 1, "nodes": []any{map[string]any{"type": "text", "title": "WEB-ASSISTANT-FOLDER-OK"}}})
			frame(map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "call-web-create", "type": "function", "function": map[string]any{"name": "canvas_nodes_create", "arguments": string(args)}}}}, nil)
			frame(map[string]any{}, "tool_calls")
		} else {
			frame(map[string]any{"role": "assistant", "content": "The local canvas draft is saved."}, nil)
			frame(map[string]any{}, "stop")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer model.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	data, root := t.TempDir(), t.TempDir()
	write := func(name string, value any) {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(data, name), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("agent_config.json", map[string]any{"model": "web-fixture", "hostCommand": node, "hostArgs": []string{entry}})
	write("local-model-config.json", map[string]any{"schemaVersion": 1, "revision": 1, "config": map[string]any{
		"textModel": "fixture::web-fixture", "channels": []any{map[string]any{"id": "fixture", "name": "Local free fixture", "enabled": true, "apiKey": "fixture-only", "baseUrl": model.URL + "/v1", "apiFormat": "openai", "models": []string{"web-fixture"}}},
	}})
	var shell *engineShell
	rt, err := bootstrap.Open(ctx, bootstrap.Config{Profile: bootstrap.ProfileDesktop, DataDir: data, ListenAddr: "127.0.0.1:0", AutoMigrate: true, RouterMiddleware: []gin.HandlerFunc{engineFolderGuard(func() *engineShell { return shell })}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer closeCancel()
		if err := rt.Close(closeCtx); err != nil {
			t.Error(err)
		}
	}()
	shell, err = newEngineShell(ctx, rt, data, root)
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	bridge := browserbridge.NewServer(strings.Repeat("b", 64), listener.Addr().(*net.TCPAddr).Port)
	gateway, err := browserbridge.NewEngineGateway(browserbridge.EngineConfig{BaseURL: rt.BaseURL(), LaunchToken: rt.LaunchToken(), UIBootstrapToken: rt.UIBootstrapToken(), Shell: shell, WorkspaceConfigured: shell.configured, ProjectDirectory: shell.directory, CheckWritable: shell.checkWritable})
	if err != nil {
		listener.Close()
		t.Fatal(err)
	}
	bridge.SetEngine(gateway)
	outer := httptest.NewUnstartedServer(bridge)
	outer.Listener.Close()
	outer.Listener = listener
	outer.Start()
	defer outer.Close()
	var browserToken, uiToken string
	request := func(method, path, body string) (int, []byte) {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, method, outer.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Origin", "https://cheeser.link")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(browserbridge.EngineSessionHeader, browserToken)
		req.Header.Set("X-Beeftv-Ui-Session", uiToken)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, raw
	}
	if status, _ := request("POST", "/engine/api/assistant/ui-session", `{}`); status != 401 {
		t.Fatal("unpaired browser was admitted", status)
	}
	code, _ := bridge.NewPairCode()
	status, raw := request("POST", "/pair", `{"code":"`+code+`"}`)
	var pair struct {
		Token string `json:"token"`
	}
	if status != 200 || json.Unmarshal(raw, &pair) != nil || pair.Token == "" {
		t.Fatal("pairing failed", status)
	}
	browserToken = pair.Token
	if status, raw := request("POST", "/engine/api/assistant/runtime/turns/forged", `{}`); status != 403 {
		t.Fatal("browser reached private runtime callbacks", status, string(raw))
	}
	status, raw = request("POST", "/engine/api/assistant/ui-session", `{}`)
	var session struct {
		Data struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if status != 200 || json.Unmarshal(raw, &session) != nil || session.Data.Token == "" {
		t.Fatal("UI session failed", status)
	}
	uiToken = session.Data.Token
	if status, raw := request("PUT", "/engine/api/canvas-projects/web-assistant", `{"project":{"id":"web-assistant","title":"Web assistant fixture","revision":0,"nodes":[],"connections":[]}}`); status != 200 {
		t.Fatal("canvas creation failed", status, string(raw))
	}
	status, stream := request("POST", "/engine/api/assistant/chat", `{"canvasId":"web-assistant","message":"Create one text draft on my canvas; no generation.","permissionMode":"canvas"}`)
	if status != 200 {
		t.Fatal("assistant admission failed", status, string(stream))
	}
	var completed bool
	for _, line := range strings.Split(string(stream), "\n") {
		var event struct {
			Type  string `json:"type"`
			Reply string `json:"reply"`
			Error string `json:"error"`
		}
		if json.Unmarshal([]byte(line), &event) == nil && event.Type == "turn_end" {
			if event.Error != "" {
				t.Fatalf("assistant failed: %s; fixture calls=%d; stream=%s", event.Error, modelCalls.Load(), stream)
			}
			completed = strings.Contains(event.Reply, "local canvas draft")
		}
	}
	if !completed || modelCalls.Load() != 2 || !successfulToolResult.Load() {
		t.Fatalf("no completed real tool round trip: completed=%v modelCalls=%d toolResult=%v; stream=%s", completed, modelCalls.Load(), successfulToolResult.Load(), stream)
	}
	if status, raw := request("GET", "/engine/api/canvas-projects/web-assistant", ""); status != 200 || !strings.Contains(string(raw), "WEB-ASSISTANT-FOLDER-OK") {
		t.Fatal("tool result missing from real canvas", status, string(raw))
	}
	if status, raw := request("POST", "/engine/shell/project-folders/flush", `{"canvasId":"web-assistant"}`); status != 200 {
		t.Fatal("project did not flush", status, string(raw))
	}
	owner, err := rt.ProjectFolderOwnerID()
	if err != nil {
		t.Fatal(err)
	}
	folder, err := rt.ProjectFolders().Status(ctx, owner, "web-assistant")
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := os.ReadFile(filepath.Join(root, folder.Directory, "project.qisitv.json"))
	if err != nil || !strings.Contains(string(manifest), "WEB-ASSISTANT-FOLDER-OK") || folder.Pending {
		t.Fatal("tool result not durably written to project directory", err, folder)
	}
	// Reading the same conversation must not restart work or dispatch a model.
	if status, raw := request("GET", "/engine/api/assistant/history?canvasId=web-assistant", ""); status != 200 || !strings.Contains(string(raw), "local canvas draft") {
		t.Fatal("assistant history not retained", status, string(raw))
	}
	if modelCalls.Load() != 2 {
		t.Fatal("history read dispatched a model request")
	}
}
