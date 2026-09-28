package browserbridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const testOrigin = "https://cheeser.link"
const testAgentToken = "separate-agent-secret-abcdefghijklmnopqrstuvwxyz"

func startTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	bridge := NewServer(testAgentToken, DefaultPort)
	server := httptest.NewServer(bridge)
	parsed, _ := url.Parse(server.URL)
	bridge.port, _ = strconv.Atoi(parsed.Port())
	t.Cleanup(server.Close)
	return bridge, server
}
func requestTest(t *testing.T, server *httptest.Server, method, path, origin, authorization string, body any) (int, map[string]any) {
	t.Helper()
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, server.URL+path, bytes.NewReader(data))
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if authorization != "" {
		req.Header.Set("Authorization", "Bearer "+authorization)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var output map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&output)
	return resp.StatusCode, output
}
func pairTest(t *testing.T, bridge *Server, server *httptest.Server) string {
	t.Helper()
	code, _ := bridge.NewPairCode()
	status, reply := requestTest(t, server, "POST", "/pair", testOrigin, "", map[string]any{"code": code})
	if status != 200 {
		t.Fatalf("pair: %d %+v", status, reply)
	}
	return reply["token"].(string)
}
func connectTest(t *testing.T, server *httptest.Server, token string) *websocket.Conn {
	t.Helper()
	dialer := websocket.Dialer{Subprotocols: []string{"qisitv-v1", "qisitv-auth." + token}}
	conn, _, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws", http.Header{"Origin": []string{testOrigin}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}
func TestPairingOriginAttemptsReplayAndAuthSeparation(t *testing.T) {
	bridge, server := startTestServer(t)
	code, _ := bridge.NewPairCode()
	status, _ := requestTest(t, server, "POST", "/pair", "https://evil.example", "", map[string]any{"code": code})
	if status != 403 {
		t.Fatal("untrusted origin accepted")
	}
	for range 5 {
		status, _ = requestTest(t, server, "POST", "/pair", testOrigin, "", map[string]any{"code": "wrong"})
		if status != 403 {
			t.Fatal("bad code accepted")
		}
	}
	status, _ = requestTest(t, server, "POST", "/pair", testOrigin, "", map[string]any{"code": code})
	if status != 403 {
		t.Fatal("attempt limit bypassed")
	}
	code, _ = bridge.NewPairCode()
	status, reply := requestTest(t, server, "POST", "/pair", testOrigin, "", map[string]any{"code": code})
	if status != 200 {
		t.Fatal(reply)
	}
	token := reply["token"].(string)
	status, _ = requestTest(t, server, "POST", "/pair", testOrigin, "", map[string]any{"code": code})
	if status != 403 {
		t.Fatal("used code accepted")
	}
	status, _ = requestTest(t, server, "POST", "/agent/call", "", token, map[string]any{"operation": "canvas_list_sessions", "args": map[string]any{}})
	if status != 401 {
		t.Fatal("browser token authenticated Agent")
	}
	status, _ = requestTest(t, server, "POST", "/agent/call", testOrigin, testAgentToken, map[string]any{"operation": "canvas_list_sessions", "args": map[string]any{}})
	if status != 401 {
		t.Fatal("website origin accessed Agent endpoint")
	}
	dialer := websocket.Dialer{Subprotocols: []string{"qisitv-v1", "qisitv-auth." + token}}
	_, resp, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws", http.Header{"Origin": []string{"https://www.cheeser.link"}})
	if err == nil || resp.StatusCode != 401 {
		t.Fatal("token reused by a different origin")
	}
}
func TestHostValidationAndPrivateNetworkPreflight(t *testing.T) {
	bridge, _ := startTestServer(t)
	r := httptest.NewRequest("GET", "http://evil.example/health", nil)
	r.RemoteAddr = "127.0.0.1:10000"
	w := httptest.NewRecorder()
	bridge.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("DNS rebinding host accepted")
	}
	r = httptest.NewRequest("OPTIONS", "http://127.0.0.1:"+strconv.Itoa(bridge.port)+"/pair", nil)
	r.RemoteAddr = "127.0.0.1:10000"
	r.Header.Set("Origin", testOrigin)
	r.Header.Set("Access-Control-Request-Private-Network", "true")
	w = httptest.NewRecorder()
	bridge.ServeHTTP(w, r)
	if w.Code != 204 || w.Header().Get("Access-Control-Allow-Private-Network") != "true" || w.Header().Get("Access-Control-Allow-Origin") != testOrigin {
		t.Fatalf("preflight failed: %+v", w)
	}
}
func TestBrowserRoundtripRevisionAndAmbiguousTargets(t *testing.T) {
	bridge, server := startTestServer(t)
	first := connectTest(t, server, pairTest(t, bridge, server))
	if err := first.WriteJSON(map[string]any{"type": "hello", "projectId": "project-a", "projectName": "First"}); err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"canvasId": "project-a", "node": map[string]any{"type": "text", "metadata": map[string]any{"content": "Hello"}}, "baseRevision": float64(4)}
	client := NewClient(Config{Address: server.URL, AgentToken: testAgentToken})
	done := make(chan error, 1)
	go func() {
		result, err := client.Call(context.Background(), "canvas_add_node", args)
		if err == nil && result.(map[string]any)["revision"] != float64(5) {
			err = errors.New("wrong result")
		}
		done <- err
	}()
	var command map[string]any
	if err := first.ReadJSON(&command); err != nil {
		t.Fatal(err)
	}
	if command["operation"] != "canvas_add_node" || command["args"].(map[string]any)["baseRevision"] != float64(4) {
		t.Fatalf("wrong command: %+v", command)
	}
	if err := first.WriteJSON(map[string]any{"id": command["id"], "result": map[string]any{"revision": 5}}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	delete(args, "baseRevision")
	if _, err := client.Call(context.Background(), "canvas_add_node", args); err == nil {
		t.Fatal("write without revision accepted")
	}
	_ = connectTest(t, server, pairTest(t, bridge, server))
	_, err := bridge.Call(context.Background(), "canvas_current", map[string]any{})
	var rpc *RPCError
	if !errors.As(err, &rpc) || rpc.Code != "AMBIGUOUS_TARGET" {
		t.Fatalf("ambiguous windows not refused: %v", err)
	}
	if len(bridge.Sessions()) != 2 {
		t.Fatal("missing sessions")
	}
}
func TestDisconnectAndTimeoutNeverReplayWrites(t *testing.T) {
	for _, disconnect := range []bool{true, false} {
		t.Run(strconv.FormatBool(disconnect), func(t *testing.T) {
			bridge, server := startTestServer(t)
			bridge.CallTimeout = 40 * time.Millisecond
			conn := connectTest(t, server, pairTest(t, bridge, server))
			done := make(chan error, 1)
			go func() {
				_, err := bridge.Call(context.Background(), "canvas_create", map[string]any{"title": "No replay"})
				done <- err
			}()
			var command map[string]any
			if err := conn.ReadJSON(&command); err != nil {
				t.Fatal(err)
			}
			if disconnect {
				conn.Close()
			}
			err := <-done
			var rpc *RPCError
			if !errors.As(err, &rpc) {
				t.Fatal(err)
			}
			wanted := "CALL_TIMEOUT"
			if disconnect {
				wanted = "BROWSER_DISCONNECTED"
			}
			if rpc.Code != wanted {
				t.Fatalf("got %v", err)
			}
			if !disconnect {
				_ = conn.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
				if err := conn.ReadJSON(&command); err == nil {
					t.Fatal("write was automatically replayed")
				}
			}
		})
	}
}
func TestAssetImportOnlySendsMediaBytesNotAbsolutePath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "reference.png")
	data, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0f8AAAAASUVORK5CYII=")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"path": path, "kind": "image"}
	if err := prepareAsset(args); err != nil {
		t.Fatal(err)
	}
	if _, exists := args["path"]; exists {
		t.Fatal("original local path leaked")
	}
	if args["name"] != "reference.png" || args["mime"] != "image/png" || args["base64"] != base64.StdEncoding.EncodeToString(data) {
		t.Fatal("incorrect media wire payload")
	}
	secret := filepath.Join(dir, "credentials.json")
	_ = os.WriteFile(secret, []byte(`{"api_key":"secret"}`), 0600)
	if err := prepareAsset(map[string]any{"path": secret, "kind": "image"}); err == nil {
		t.Fatal("nonmedia file accepted")
	}
}
func TestPaidSubmissionRequiresConsentTargetAndIdempotency(t *testing.T) {
	args := map[string]any{"canvasId": "p", "nodeId": "n", "baseRevision": float64(2), "type": "video", "model": "doubao_seedance_2_5", "prompt": "test", "idempotencyKey": "stable", "consent": map[string]any{"approved": true, "scope": "User approved model, 5 seconds, maximum budget 10 CNY"}}
	if err := validateArgs("task_submit", args, false); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"consent", "idempotencyKey", "nodeId", "baseRevision"} {
		copy := map[string]any{}
		for k, v := range args {
			if k != key {
				copy[k] = v
			}
		}
		if err := validateArgs("task_submit", copy, false); err == nil {
			t.Fatalf("missing %s accepted", key)
		}
	}
	args["input"] = map[string]any{"options": map[string]any{"providerOptions": map[string]any{"api_key": "secret"}}}
	if err := validateArgs("task_submit", args, false); err == nil {
		t.Fatal("secret accepted")
	}
}
func TestMCPTransportListsToolsAndReportsDisconnectedBrowser(t *testing.T) {
	_, httpServer := startTestServer(t)
	server := NewMCPServer(NewClient(Config{Address: httpServer.URL, AgentToken: testAgentToken}))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	session, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	clientSession, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer clientSession.Close()
	list, err := clientSession.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Tools) < 18 {
		t.Fatalf("missing tools: %d", len(list.Tools))
	}
	reply, err := clientSession.CallTool(ctx, &mcp.CallToolParams{Name: "canvas_current", Arguments: map[string]any{}})
	if err != nil || !reply.IsError {
		t.Fatalf("missing browser was not an MCP error: %+v %v", reply, err)
	}
	text := reply.Content[0].(*mcp.TextContent).Text
	if !strings.Contains(text, "BROWSER_NOT_CONNECTED") {
		t.Fatal(text)
	}
}
func TestHealthDoesNotDiscloseSecrets(t *testing.T) {
	bridge, server := startTestServer(t)
	response, err := http.Get(server.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	if bytes.Contains(data, []byte(bridge.agentToken)) || bytes.Contains(data, []byte(bridge.code)) {
		t.Fatal("health leaks credentials")
	}
}
func TestNoNetworkBindingOutsideLoopback(t *testing.T) {
	bridge, _ := startTestServer(t)
	r := httptest.NewRequest("GET", "http://127.0.0.1:"+strconv.Itoa(bridge.port)+"/health", nil)
	r.RemoteAddr = net.JoinHostPort("192.168.1.2", "60000")
	w := httptest.NewRecorder()
	bridge.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("remote peer accepted")
	}
}
