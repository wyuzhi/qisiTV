package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"qisitv/backend/internal/browserbridge"
)

func TestMCPColdStartConcurrentClientsAndIdleCleanup(t *testing.T) {
	if testing.Short() {
		t.Skip("subprocess integration includes the real 30-second idle grace")
	}
	work := t.TempDir()
	configDir := filepath.Join(work, "config")
	t.Setenv("QISITV_CONNECT_CONFIG_DIR", configDir)
	binary := filepath.Join(work, "qisitv-connect")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	build := exec.Command("go", "build", "-o", binary, ".")
	if data, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, data)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	address := "http://127.0.0.1:" + strconv.Itoa(port)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	const count = 3
	sessions := make([]*mcp.ClientSession, count)
	errors := make([]error, count)
	logs := make([]bytes.Buffer, count)
	var workers sync.WaitGroup
	for i := range count {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			command := exec.Command(binary, "mcp", "--port", strconv.Itoa(port))
			command.Stderr = &logs[i]
			sessions[i], errors[i] = mcp.NewClient(&mcp.Implementation{Name: fmt.Sprintf("client-%d", i), Version: "1"}, nil).Connect(ctx, &mcp.CommandTransport{Command: command}, nil)
		}(i)
	}
	workers.Wait()
	t.Cleanup(func() {
		for i, session := range sessions {
			if session != nil {
				_ = session.Close()
				sessions[i] = nil
			}
		}
		waitUntil(t, 35*time.Second, func() bool {
			conn, err := net.DialTimeout("tcp4", "127.0.0.1:"+strconv.Itoa(port), 100*time.Millisecond)
			if err != nil {
				return true
			}
			_ = conn.Close()
			return false
		})
	})
	for i, err := range errors {
		if err != nil {
			t.Fatalf("concurrent cold-start client %d: %v; stderr=%s", i, err, logs[i].String())
		}
	}
	config, err := browserbridge.LoadConfig()
	if err != nil || config.Address != address {
		t.Fatalf("fresh service address: %s %v", config.Address, err)
	}
	identity, err := browserbridge.NewClient(config).Authenticate(ctx)
	if err != nil || !identity.Managed {
		t.Fatalf("managed service identity: %+v %v", identity, err)
	}
	list, err := sessions[0].ListTools(ctx, nil)
	if err != nil {
		t.Fatal("MCP stdout was not valid protocol:", err)
	}
	var hasPair bool
	for _, tool := range list.Tools {
		hasPair = hasPair || tool.Name == "qisitv_pair"
	}
	if !hasPair {
		t.Fatal("pair tool is missing")
	}
	code := callPair(t, ctx, sessions[0])
	body, _ := json.Marshal(map[string]any{"code": code})
	req, _ := http.NewRequestWithContext(ctx, "POST", address+"/pair", bytes.NewReader(body))
	req.Header.Set("Origin", "https://cheeser.link")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var paired map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&paired)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatal("MCP pairing code did not pair browser", paired)
	}
	dialer := websocket.Dialer{Subprotocols: []string{"qisitv-v1", "qisitv-auth." + paired["token"].(string)}}
	web, _, err := dialer.Dial("ws"+strings.TrimPrefix(address, "http")+"/ws", http.Header{"Origin": []string{"https://cheeser.link"}})
	if err != nil {
		t.Fatal(err)
	}
	defer web.Close()
	for i, session := range sessions {
		reply, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "canvas_list_sessions", Arguments: map[string]any{}})
		if err != nil || reply.IsError || !strings.Contains(reply.Content[0].(*mcp.TextContent).Text, paired["sessionId"].(string)) {
			t.Fatalf("client %d did not share paired browser: %+v %v", i, reply, err)
		}
	}
	if err := sessions[0].Close(); err != nil {
		t.Fatal("MCP shutdown kept protocol pipes open:", err)
	}
	sessions[0] = nil
	callPair(t, ctx, sessions[1])
	callPair(t, ctx, sessions[2])
	if err := sessions[1].Close(); err != nil {
		t.Fatal(err)
	}
	sessions[1] = nil
	callPair(t, ctx, sessions[2])
	if err := sessions[2].Close(); err != nil {
		t.Fatal(err)
	}
	sessions[2] = nil
	if _, err := browserbridge.NewClient(config).Authenticate(ctx); err != nil {
		t.Fatal("service skipped the idle grace:", err)
	}
	if info, err := os.Stat(filepath.Join(configDir, "connection.json")); err != nil || runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("private service config permissions are incorrect")
	}
	// An open browser must not keep a managed service running without any Agent.
	waitUntil(t, 35*time.Second, func() bool {
		conn, err := net.DialTimeout("tcp4", "127.0.0.1:"+strconv.Itoa(port), 100*time.Millisecond)
		if err != nil {
			return true
		}
		_ = conn.Close()
		return false
	})
}

func callPair(t *testing.T, ctx context.Context, session *mcp.ClientSession) string {
	t.Helper()
	reply, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "qisitv_pair", Arguments: map[string]any{}})
	if err != nil || reply.IsError {
		t.Fatalf("pair: %+v %v", reply, err)
	}
	var output map[string]any
	if err := json.Unmarshal([]byte(reply.Content[0].(*mcp.TextContent).Text), &output); err != nil {
		t.Fatal(err)
	}
	code, ok := output["code"].(string)
	if !ok || len(code) == 0 {
		t.Fatal("MCP pair tool did not return a code")
	}
	return code
}

func waitUntil(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Error("managed service did not shut down after the last MCP client exited")
}
