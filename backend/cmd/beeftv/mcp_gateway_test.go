package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestOpToolContentAttachesImagesAndAudioOutsideText(t *testing.T) {
	image := []byte("\x89PNG fake image bytes")
	audio := []byte("RIFF fake wav bytes")
	video := []byte("fake mp4 bytes")
	raw, _ := json.Marshal(map[string]any{"op": "media.inspect", "result": map[string]any{
		"durationMs": 5000,
		"content": []map[string]any{
			{"type": "image", "mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(image), "sha256": "img-sha", "source": map[string]any{"resourceId": "r1", "version": "v1"}},
			{"type": "media", "mimeType": "audio/wav", "data": base64.StdEncoding.EncodeToString(audio), "sha256": "aud-sha"},
			{"type": "media", "mimeType": "video/mp4", "data": base64.StdEncoding.EncodeToString(video), "sha256": "vid-sha"},
		},
	}})
	content := opToolContent(raw)
	if len(content) != 3 {
		t.Fatalf("want text + image + audio blocks, got %d", len(content))
	}
	text, ok := content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("first block must be the facts text, got %T", content[0])
	}
	for _, encoded := range [][]byte{image, audio, video} {
		if strings.Contains(text.Text, base64.StdEncoding.EncodeToString(encoded)) {
			t.Fatal("media bytes must not stay inside the text block")
		}
	}
	for _, want := range []string{`"durationMs":5000`, `"sha256":"img-sha"`, `"resourceId":"r1"`, videoPartNote} {
		if !strings.Contains(text.Text, want) {
			t.Fatalf("facts text lost %s: %s", want, text.Text)
		}
	}
	if img, ok := content[1].(*mcp.ImageContent); !ok || img.MIMEType != "image/png" || !bytes.Equal(img.Data, image) {
		t.Fatalf("image block wrong: %#v", content[1])
	}
	if aud, ok := content[2].(*mcp.AudioContent); !ok || aud.MIMEType != "audio/wav" || !bytes.Equal(aud.Data, audio) {
		t.Fatalf("audio block wrong: %#v", content[2])
	}
}

func TestOpToolContentLeavesOrdinaryResultsAsText(t *testing.T) {
	for _, raw := range []string{
		`{"op":"canvas.get","result":{"nodes":[],"revision":3}}`,
		`{"op":"media.check","result":{"meanDb":-20,"content":[]}}`,
		`not json`,
	} {
		content := opToolContent(json.RawMessage(raw))
		if len(content) != 1 {
			t.Fatalf("%s: want one text block, got %d", raw, len(content))
		}
		if text, ok := content[0].(*mcp.TextContent); !ok || text.Text != raw {
			t.Fatalf("%s: text changed: %#v", raw, content[0])
		}
	}
}

// businessFixture serves one workspace operation and three business handlers,
// recording which handler paths business calls reach.
type fixtureRequest struct {
	key  string
	body string
}

var fixtureRequests sync.Map // "METHOD path" -> fixtureRequest

func businessFixture(t *testing.T) (*httptest.Server, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var reached []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/ops"):
			_, _ = w.Write([]byte(`{"code":0,"data":{"ops":[
				{"id":"canvas.get","summary":"读画布","readOnly":true,"params":{"type":"object"}},
				{"id":"conversation.search","summary":"搜对话","readOnly":true,"params":{"type":"object"}},
				{"id":"skill.publish.prepare","summary":"发技能","readOnly":true,"params":{"type":"object"}}
			]}}`))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/business/tools"):
			_, _ = w.Write([]byte(`{"code":0,"data":{"tools":[
				{"id":"business_get_assets","summary":"GET /assets","method":"GET","path":"/assets","readOnly":true,"params":{"type":"object","properties":{}}},
				{"id":"business_get_asset_folders","summary":"GET /asset-folders","method":"GET","path":"/asset-folders","readOnly":true,"params":{"type":"object","properties":{}}},
				{"id":"business_delete_assets_id","summary":"删除无业务引用的素材 (DELETE /assets/:id)","method":"DELETE","path":"/assets/:id","readOnly":false,"params":{"type":"object","properties":{}}},
				{"id":"business_post_tasks","summary":"POST /tasks","method":"POST","path":"/tasks","readOnly":false,"submitsGeneration":true,"params":{"type":"object","properties":{}}},
				{"id":"business_get_resources_id_file","summary":"GET /resources/:id/file","method":"GET","path":"/resources/:id/file","readOnly":true,"params":{"type":"object","properties":{}}}
			]}}`))
		case strings.HasSuffix(r.URL.Path, "/file"):
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("\x89PNG fixture"))
		default:
			body, _ := io.ReadAll(r.Body)
			fixtureRequests.Store(r.Method+" "+strings.TrimPrefix(r.URL.Path, "/api"), fixtureRequest{key: r.Header.Get("X-Idempotency-Key"), body: string(body)})
			mu.Lock()
			reached = append(reached, r.Method+" "+r.URL.Path)
			mu.Unlock()
			_, _ = w.Write([]byte(`{"code":0,"data":{"ok":true}}`))
		}
	}))
	return server, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), reached...)
	}
}

func connectFixtureMCP(t *testing.T, ctx context.Context, base string, args ...string) *mcp.ClientSession {
	t.Helper()
	t.Setenv("BEEFTV_BASE_URL", base)
	t.Setenv("BEEFTV_OWNER_TOKEN", "owner-token-for-test")
	cmd := exec.Command(os.Args[0], append([]string{"-test.run=^TestMCPProcessHelper$", "--", "mcp", "serve"}, args...)...)
	cmd.Env = append(os.Environ(), "BEEFTV_TEST_PROCESS=1")
	session, err := mcp.NewClient(&mcp.Implementation{Name: "fixture", Version: "1"}, nil).Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func toolNames(t *testing.T, ctx context.Context, session *mcp.ClientSession) []string {
	t.Helper()
	listed, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(listed.Tools))
	for _, tool := range listed.Tools {
		names = append(names, tool.Name)
	}
	sort.Strings(names)
	return names
}

func TestMCPListsBusinessGatewayInsteadOfEveryHandler(t *testing.T) {
	server, reached := businessFixture(t)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	session := connectFixtureMCP(t, ctx, server.URL)
	if got := strings.Join(toolNames(t, ctx, session), ","); got != "business.call,business.list,canvas.get" {
		t.Fatalf("default MCP tools = %s", got)
	}
	listed, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "business.list", Arguments: map[string]any{"query": "folder"}})
	if err != nil || listed.IsError {
		t.Fatalf("business.list failed: %v %#v", err, listed)
	}
	if text := listed.Content[0].(*mcp.TextContent).Text; !strings.Contains(text, "business_get_asset_folders") || strings.Contains(text, "business_get_assets\"") {
		t.Fatalf("business.list filter wrong: %s", text)
	}
	called, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "business.call", Arguments: map[string]any{"tool": "business_delete_assets_id", "path": map[string]any{"id": "asset-1"}, "operationId": "op-1"}})
	if err != nil || called.IsError {
		t.Fatalf("business.call failed: %v %#v", err, called)
	}
	unknown, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "business.call", Arguments: map[string]any{"tool": "business_nope"}})
	if err != nil || !unknown.IsError {
		t.Fatalf("unknown business tool must be a tool error: %v %#v", err, unknown)
	}
	if got := strings.Join(reached(), ","); got != "DELETE /assets/asset-1" {
		t.Fatalf("business.call reached %q", got)
	}
}

func TestMCPReadOnlyGatewayRefusesWriteHandlers(t *testing.T) {
	server, reached := businessFixture(t)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	session := connectFixtureMCP(t, ctx, server.URL, "--read-only")
	listed, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range listed.Tools {
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
			t.Fatalf("read-only MCP advertised writable tool %s", tool.Name)
		}
	}
	refused, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "business.call", Arguments: map[string]any{"tool": "business_delete_assets_id", "path": map[string]any{"id": "asset-1"}}})
	if err != nil || !refused.IsError {
		t.Fatalf("read-only gateway must refuse a write handler: %v %#v", err, refused)
	}
	if len(reached()) != 0 {
		t.Fatalf("refused call reached the workspace: %v", reached())
	}
}

func TestMCPAllBusinessToolsFlagKeepsPerHandlerTools(t *testing.T) {
	server, _ := businessFixture(t)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	session := connectFixtureMCP(t, ctx, server.URL, "--all-business-tools")
	if got := strings.Join(toolNames(t, ctx, session), ","); got != "business_delete_assets_id,business_get_asset_folders,business_get_assets,business_get_resources_id_file,business_post_tasks,canvas.get" {
		t.Fatalf("--all-business-tools MCP tools = %s", got)
	}
}

func TestMCPBusinessWritesRequireAndForwardOperationID(t *testing.T) {
	server, reached := businessFixture(t)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	session := connectFixtureMCP(t, ctx, server.URL)
	missing, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "business.call", Arguments: map[string]any{"tool": "business_delete_assets_id", "path": map[string]any{"id": "asset-9"}}})
	if err != nil || !missing.IsError || !strings.Contains(toolText(missing), "missing_operation_id") {
		t.Fatalf("write without operationId must be refused: %v %s", err, toolText(missing))
	}
	if len(reached()) != 0 {
		t.Fatalf("refused write reached the workspace: %v", reached())
	}
	if _, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "business.call", Arguments: map[string]any{"tool": "business_delete_assets_id", "path": map[string]any{"id": "asset-9"}, "operationId": "op-delete-1"}}); err != nil {
		t.Fatal(err)
	}
	if got, _ := fixtureRequests.Load("DELETE /assets/asset-9"); got == nil || got.(fixtureRequest).key != "op-delete-1" {
		t.Fatalf("X-Idempotency-Key not forwarded: %#v", got)
	}
	submitted, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "business.call", Arguments: map[string]any{"tool": "business_post_tasks", "operationId": "op-task-0001",
		"body": map[string]any{"type": "image", "prompt": "猫", "input": map[string]any{"metadata": map[string]any{"source": "mcp"}}}}})
	if err != nil || submitted.IsError {
		t.Fatalf("task submit failed: %v %s", err, toolText(submitted))
	}
	got, _ := fixtureRequests.Load("POST /tasks")
	var body struct {
		Input struct {
			Metadata map[string]any `json:"metadata"`
		} `json:"input"`
	}
	if got == nil || json.Unmarshal([]byte(got.(fixtureRequest).body), &body) != nil || body.Input.Metadata["clientOperationId"] != "op-task-0001" || body.Input.Metadata["source"] != "mcp" {
		t.Fatalf("task body must carry operationId as clientOperationId and keep other metadata: %#v", got)
	}
	conflict, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "business.call", Arguments: map[string]any{"tool": "business_post_tasks", "operationId": "op-task-0002",
		"body": map[string]any{"input": map[string]any{"metadata": map[string]any{"clientOperationId": "op-other-0003"}}}}})
	if err != nil || !conflict.IsError || !strings.Contains(toolText(conflict), "operation_id_conflict") {
		t.Fatalf("conflicting idempotency keys must be refused: %v %s", err, toolText(conflict))
	}
}

func TestMCPBusinessGatewaySchemaAndFileResponses(t *testing.T) {
	server, _ := businessFixture(t)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	session := connectFixtureMCP(t, ctx, server.URL)
	listed, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range listed.Tools {
		if tool.Name != "business.call" {
			continue
		}
		schema, _ := json.Marshal(tool.InputSchema)
		for _, field := range []string{`"file"`, `"filePath"`, `"operationId"`} {
			if !strings.Contains(string(schema), field) {
				t.Fatalf("business.call schema lacks %s: %s", field, schema)
			}
		}
	}
	writes, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "business.list", Arguments: map[string]any{"readOnly": false}})
	if err != nil || strings.Contains(toolText(writes), "business_get_assets") || !strings.Contains(toolText(writes), "business_post_tasks") {
		t.Fatalf("readOnly=false must list only writes: %v %s", err, toolText(writes))
	}
	file, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "business.call", Arguments: map[string]any{"tool": "business_get_resources_id_file", "path": map[string]any{"id": "res-1"}}})
	if err != nil || file.IsError || len(file.Content) != 2 {
		t.Fatalf("image file response must be facts + image block: %v %#v", err, file)
	}
	if img, ok := file.Content[1].(*mcp.ImageContent); !ok || img.MIMEType != "image/png" || len(img.Data) == 0 {
		t.Fatalf("second block must be the image: %#v", file.Content[1])
	}
}

func TestOpToolContentLeavesNonMediaContentArraysAlone(t *testing.T) {
	raw := json.RawMessage(`{"op":"skill.get","result":{"content":[{"type":"text","mimeType":"text/markdown","data":"aGVsbG8="}]}}`)
	content := opToolContent(raw)
	if len(content) != 1 || content[0].(*mcp.TextContent).Text != string(raw) {
		t.Fatalf("non-media operation result was rewritten: %#v", content)
	}
}

func TestWorkspaceResponsesLargerThanOneMediaPartAreReadWhole(t *testing.T) {
	payload := strings.Repeat("A", 12<<20)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"op":"media.inspect","result":{"blob":"` + payload + `"}}}`))
	}))
	defer server.Close()
	t.Setenv("BEEFTV_BASE_URL", server.URL)
	t.Setenv("BEEFTV_OWNER_TOKEN", "owner-token-for-test")
	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := c.callOpCtx(context.Background(), "media.inspect", "", json.RawMessage(`{}`))
	if err != nil || !strings.Contains(string(raw), payload[:64]) || len(raw) < len(payload) {
		t.Fatalf("12 MiB response must be read whole: len=%d err=%v", len(raw), err)
	}
}

func TestTaskSubmitBodyNullOrMalformedIsAToolErrorNotACrash(t *testing.T) {
	for _, body := range []string{`null`, `{"input":null}`, `{"input":{"metadata":null}}`} {
		out, err := withTaskClientOperationID(json.RawMessage(body), "op-task-0009")
		if err != nil || !strings.Contains(string(out), `"clientOperationId":"op-task-0009"`) {
			t.Fatalf("%s: %s %v", body, out, err)
		}
	}
	for _, body := range []string{`[]`, `"x"`, `{"input":[]}`, `{"input":{"metadata":"x"}}`} {
		if _, err := withTaskClientOperationID(json.RawMessage(body), "op-task-0009"); err == nil || !strings.Contains(err.Error(), "invalid_body") && !strings.Contains(fmt.Sprint(err), "body") {
			t.Fatalf("%s must be rejected as invalid_body, got %v", body, err)
		}
	}
	server, _ := businessFixture(t)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	session := connectFixtureMCP(t, ctx, server.URL)
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "business.call", Arguments: map[string]any{"tool": "business_post_tasks", "operationId": "op-task-0010", "body": nil}})
	if err != nil || result.IsError {
		t.Fatalf("null body must still submit with the key: %v %s", err, toolText(result))
	}
	if again, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "canvas.get", Arguments: map[string]any{}}); err != nil || again == nil {
		t.Fatalf("MCP server must survive a null task body: %v", err)
	}
}

func TestCLIBusinessCallRequiresOperationIDForPaidSubmissions(t *testing.T) {
	server, reached := businessFixture(t)
	defer server.Close()
	t.Setenv("BEEFTV_BASE_URL", server.URL)
	t.Setenv("BEEFTV_OWNER_TOKEN", "owner-token-for-test")
	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	err = runBusiness(c, []string{"call", "--tool", "business_post_tasks", "--params", `{"body":{"type":"image"}}`})
	if err == nil || !strings.Contains(fmt.Sprint(err), "operation-id") {
		t.Fatalf("paid submission without a key must be refused: %v", err)
	}
	if len(reached()) != 0 {
		t.Fatalf("refused submission reached the workspace: %v", reached())
	}
	if err := runBusiness(c, []string{"call", "--tool", "business_post_tasks", "--operation-id", "op-cli-0001", "--params", `{"body":{"type":"image"}}`}); err != nil {
		t.Fatal(err)
	}
	got, _ := fixtureRequests.Load("POST /tasks")
	if got == nil || !strings.Contains(got.(fixtureRequest).body, `"clientOperationId":"op-cli-0001"`) || got.(fixtureRequest).key != "op-cli-0001" {
		t.Fatalf("--operation-id must reach header and task body: %#v", got)
	}
	if err := runBusiness(c, []string{"call", "--tool", "business_delete_assets_id", "--params", `{"path":{"id":"a1"}}`}); err != nil {
		t.Fatalf("non-paid writes keep working without a key: %v", err)
	}
	if err := runBusiness(c, []string{"call", "--tool", "business_post_tasks", "--operation-id", "op-cli-0002", "--params", `{"operationId":"op-cli-0003"}`}); err == nil {
		t.Fatal("conflicting keys must be refused")
	}
}
