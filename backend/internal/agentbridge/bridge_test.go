package agentbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func reply(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": data, "msg": "ok"})
}

func clientServer(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := New(server.URL, "launch-token")
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestLocalBoundaryRejectsRemoteEndpointAndRedirect(t *testing.T) {
	for _, base := range []string{"https://example.com/api", "file:///tmp/a", "http://127.0.0.1.example.com/api", "http://user:pass@127.0.0.1/api", "http://127.0.0.1/api?key=x"} {
		if _, err := New(base, "secret"); err == nil {
			t.Fatalf("accepted %q", base)
		}
	}
	var leaked bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true; reply(w, nil) }))
	defer target.Close()
	client := clientServer(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) })
	if _, err := client.Call(context.Background(), "canvas_list", nil); err == nil {
		t.Fatal("redirect reported success")
	}
	if leaked {
		t.Fatal("followed a redirect with workspace token")
	}
}

func TestEnvelopeAndConflictAreErrors(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
	}{
		{"business failure", 200, `{"code":1,"msg":"rejected","reason":"invalid_input"}`},
		{"revision conflict", 409, `{"code":409,"msg":"newer revision","reason":"canvas_revision_conflict"}`},
		{"html", 200, `<html>wrong server</html>`},
		{"missing code", 200, `{"data":{"ok":true}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := clientServer(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			})
			_, err := client.Call(context.Background(), "canvas_list", nil)
			if err == nil {
				t.Fatal("reported success")
			}
			if test.status == 409 {
				var apiError *APIError
				if !errors.As(err, &apiError) || apiError.Reason != "canvas_revision_conflict" {
					t.Fatalf("lost conflict details: %v", err)
				}
			}
		})
	}
}

func TestActiveTaskFilterMatchesHTTPContract(t *testing.T) {
	client := clientServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("activeOnly") != "true" || r.URL.Query().Get("projectId") != "c" {
			t.Errorf("incorrect task filter %s", r.URL.RawQuery)
		}
		reply(w, []any{})
	})
	if _, err := client.Call(context.Background(), "task_list", map[string]any{"canvasId": "c", "activeOnly": true}); err != nil {
		t.Fatal(err)
	}
}

func TestMutationsNeverReadModifyWriteSnapshot(t *testing.T) {
	var calls int
	client := clientServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != http.MethodPost || r.URL.Path != "/api/canvas-projects/canvas/operations" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("X-Desktop-Token") != "launch-token" {
			t.Error("missing local token")
		}
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if number(payload["baseRevision"]) != 7 {
			t.Error("lost revision")
		}
		ops, _ := payload["operations"].([]any)
		if len(ops) != 1 {
			t.Error("not one atomic operation")
		}
		reply(w, map[string]any{"project": map[string]any{"revision": 8}})
	})
	_, err := client.Call(context.Background(), "canvas_add_node", map[string]any{"canvasId": "canvas", "baseRevision": float64(7), "node": map[string]any{"type": "audio", "title": "Voice", "metadata": map[string]any{"content": "https://example.test/voice.wav"}}})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("performed %d requests", calls)
	}
}

func TestInvalidInputsAndUnapprovedGenerationNeverReachHTTP(t *testing.T) {
	client := clientServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("invalid call reached HTTP: %s", r.URL.Path)
		reply(w, nil)
	})
	for _, test := range []struct {
		name string
		args map[string]any
	}{
		{"canvas_get", map[string]any{"canvasId": "../../secrets"}},
		{"canvas_add_node", map[string]any{"canvasId": "c", "node": map[string]any{"type": "alien"}}},
		{"canvas_add_node", map[string]any{"canvasId": "c", "scope": "test", "node": map[string]any{"type": "text"}}},
		{"task_submit", map[string]any{"canvasId": "c", "type": "video", "model": "m", "prompt": "p"}},
		{"task_submit", map[string]any{"canvasId": "c", "type": "video", "model": "m", "prompt": "p", "consent": map[string]any{"approved": false, "scope": "one video"}}},
		{"task_submit", map[string]any{"canvasId": "c", "type": "video", "model": "m", "prompt": "p", "consent": map[string]any{"approved": true, "scope": " "}}},
		{"task_submit", map[string]any{"canvasId": "c", "type": "video", "model": "m", "prompt": "p", "input": map[string]any{"apiKey": "never-send"}, "consent": map[string]any{"approved": true, "scope": "one video"}}},
	} {
		if _, err := client.Call(context.Background(), test.name, test.args); err == nil {
			t.Fatalf("accepted invalid %s", test.name)
		}
	}
}

func TestImportPersistsMediaAssetBeforeCanvas(t *testing.T) {
	var imageBytes bytes.Buffer
	if err := png.Encode(&imageBytes, image.NewRGBA(image.Rect(0, 0, 80, 40))); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "reference.png")
	if err := os.WriteFile(file, imageBytes.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	var paths []string
	var assetID string
	client := clientServer(t, func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		switch {
		case r.Method == http.MethodGet:
			reply(w, map[string]any{"project": map[string]any{"id": "c", "revision": 1}})
		case r.URL.Path == "/api/resources":
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Fatal(err)
			}
			f, _, err := r.FormFile("file")
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			b, _ := io.ReadAll(f)
			if !bytes.Equal(b, imageBytes.Bytes()) {
				t.Error("corrupt multipart media")
			}
			if r.FormValue("width") != "80" || r.FormValue("height") != "40" {
				t.Error("image dimensions missing")
			}
			if !strings.HasPrefix(r.Header.Get("X-Idempotency-Key"), "agent-import-image-") {
				t.Error("missing upload identity")
			}
			reply(w, map[string]any{"resource": map[string]any{"id": "r", "mimeType": "image/png"}})
		case strings.HasPrefix(r.URL.Path, "/api/assets/"):
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			asset := objectArg(payload, "asset")
			assetID = stringArg(asset, "id")
			if stringArg(objectArg(asset, "data"), "storageKey") != "resource:r" {
				t.Error("asset has no resource binding")
			}
			reply(w, map[string]any{"asset": asset})
		case strings.HasSuffix(r.URL.Path, "/operations"):
			if assetID == "" {
				t.Error("canvas before asset")
			}
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			op := payload["operations"].([]any)[0].(map[string]any)
			node := objectArg(op, "node")
			if stringArg(objectArg(node, "metadata"), "assetId") != assetID {
				t.Error("node has no asset binding")
			}
			if number(node["height"]) != 180 {
				t.Error("image aspect ratio lost")
			}
			reply(w, map[string]any{"project": map[string]any{"revision": 2}})
		default:
			t.Fatalf("unexpected request %s", r.URL.Path)
		}
	})
	result, err := client.Call(context.Background(), "asset_import", map[string]any{"canvasId": "c", "path": file, "kind": "image", "nodeId": "n"})
	if err != nil {
		t.Fatal(err)
	}
	if result["nodeId"] != "n" || result["resourceId"] != "r" {
		t.Fatalf("bad import result %#v", result)
	}
	if len(paths) != 4 {
		t.Fatalf("unexpected sequence %v", paths)
	}
}

func TestTaskResultApplyUsesSharedBackendAndNeverRegenerates(t *testing.T) {
	client := clientServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/tasks/t":
			reply(w, map[string]any{"id": "t", "projectId": "c", "status": "succeeded", "model": "model", "inputJson": "never-return", "resultJson": `{"text":"script"}`})
		case "/api/agent/tasks/t/apply":
			if r.Method != http.MethodPost {
				t.Error("apply must be POST")
			}
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			if payload["canvasId"] != "c" || payload["nodeId"] != "n" || number(payload["baseRevision"]) != 4 {
				t.Fatalf("lost apply constraints: %#v", payload)
			}
			reply(w, map[string]any{"project": map[string]any{"revision": 5}})
		default:
			t.Fatalf("unexpected request (must never submit generation) %s", r.URL.Path)
		}
	})
	if _, err := client.Call(context.Background(), "task_apply_result", map[string]any{"canvasId": "c", "taskId": "t", "nodeId": "n", "baseRevision": float64(4)}); err != nil {
		t.Fatal(err)
	}
	result, err := client.Call(context.Background(), "task_get", map[string]any{"taskId": "t"})
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := result["inputJson"]; exists {
		t.Fatal("leaked protected input")
	}
}

func TestMCPRealSDKHandshakeToolsCallAndToolError(t *testing.T) {
	client := clientServer(t, func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"projects": []any{map[string]any{"id": "c"}}})
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	server := NewMCPServer(client)
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer serverSession.Close()
	remote := mcp.NewClient(&mcp.Implementation{Name: "test-agent", Version: "1"}, nil)
	session, err := remote.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	listed, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Tools) != len(Tools()) {
		t.Fatalf("got %d tools", len(listed.Tools))
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "canvas_list", Arguments: map[string]any{}})
	if err != nil || result.IsError {
		t.Fatalf("call: %#v %v", result, err)
	}
	var output map[string]any
	if err := json.Unmarshal([]byte(result.Content[0].(*mcp.TextContent).Text), &output); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(output["projects"], []any{map[string]any{"id": "c"}}) {
		t.Fatalf("unexpected result %#v", output)
	}
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "task_submit", Arguments: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	if !result.IsError {
		t.Fatal("missing approval not exposed as tool error")
	}
}
