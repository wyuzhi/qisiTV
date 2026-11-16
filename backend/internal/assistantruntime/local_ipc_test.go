package assistantruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/assistant"
	"infinite-canvas/backend/internal/localipc"
)

func testOpsPipeEndpoint(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		return localipc.WorkspaceEndpoint(t.TempDir())
	}
	dir, err := filepath.EvalSymlinks("/tmp")
	if err != nil {
		dir = "/tmp"
	}
	return filepath.Join(dir, fmt.Sprintf("btv-ops-%d.sock", time.Now().UnixNano()%1_000_000_000))
}

func TestRealNodeAgentHostOverLocalPipeWithBlockedLoopbackOps(t *testing.T) {
	nodeBin := os.Getenv("BEEFTV_TEST_NODE")
	if nodeBin == "" {
		if bundled := "/Applications/BeefTV.app/Contents/MacOS/agent-host/runtime/bin/node"; runtime.GOOS == "darwin" {
			if _, statErr := os.Stat(bundled); statErr == nil {
				nodeBin = bundled
			}
		}
	}
	if nodeBin == "" {
		var lookErr error
		nodeBin, lookErr = exec.LookPath("node")
		if lookErr != nil {
			t.Skip("node not installed")
		}
	}
	serverMJS, err := filepath.Abs(filepath.Join("..", "..", "..", "agent-host", "server.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	if _, statErr := os.Stat(filepath.Join(filepath.Dir(serverMJS), "node_modules")); statErr != nil {
		t.Skip("agent-host node_modules not installed in this environment")
	}

	opsPipe := testOpsPipeEndpoint(t)
	opsListener, err := localipc.Listen(opsPipe)
	if err != nil {
		t.Fatalf("localipc.Listen(%s): %v", opsPipe, err)
	}
	defer opsListener.Close()

	var opsCalls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ops", func(w http.ResponseWriter, _ *http.Request) {
		opsCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"ops": []any{}}})
	})
	mux.HandleFunc("/api/plugins/packages/enabled", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"packages": []any{}}})
	})
	opsServer := &http.Server{Handler: mux}
	defer opsServer.Close()
	go func() { _ = opsServer.Serve(opsListener) }()

	dataDir := t.TempDir()
	if runtime.GOOS != "windows" {
		sockDir, evalErr := filepath.EvalSymlinks("/tmp")
		if evalErr != nil {
			sockDir = "/tmp"
		}
		t.Setenv("BEEFTV_AGENT_IPC_DIR", sockDir)
	}
	cfgBytes, _ := json.Marshal(HostConfig{HostCommand: nodeBin, HostArgs: []string{serverMJS}})
	if err := os.WriteFile(filepath.Join(dataDir, hostConfigFile), cfgBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	host := New(Options{
		DataDir:      dataDir,
		HostToken:    func() string { return "pipe-host-token" },
		ReadyTimeout: 10 * time.Second,
	})
	host.SetOpsPipe(opsPipe)
	defer host.Stop()

	// Construct StreamHTTPClient BEFORE host.Launch (exact bootstrap.Open -> RegisterAgentProxyRoutes
	// ordering in production) to prove Host.transport resolves the pipe dynamically at dial time.
	preLaunchStreamClient := host.StreamHTTPClient(5 * time.Second)

	provider := assistant.Provider{
		Model:    "deepseek-chat",
		BaseURL:  "http://127.0.0.1:1/v1",
		APIKey:   "sk-synthetic",
		Protocol: "chat-completion",
	}
	// Port 1 is intentionally unreachable; agent-host must reach /api/ops over opsPipe.
	if err := host.Launch(provider, "http://127.0.0.1:1/api", "desk-tok"); err != nil {
		t.Fatalf("host.Launch: %v", err)
	}
	health := host.Probe(context.Background())
	if !health.OK {
		t.Fatalf("expected healthy host via local pipe/socket, got %+v", health)
	}
	if opsCalls.Load() < 1 {
		t.Fatal("expected agent-host to load /api/ops over opsPipe")
	}

	req, err := host.NewChildRequest(context.Background(), http.MethodGet, "/sessions?canvasId=c-1", nil)
	if err != nil {
		t.Fatalf("NewChildRequest: %v", err)
	}
	resp, err := host.HTTPClient(5 * time.Second).Do(req)
	if err != nil {
		t.Fatalf("HTTPClient.Do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /sessions status=%d want 200", resp.StatusCode)
	}

	streamReq, err := host.NewChildRequest(context.WithoutCancel(context.Background()), http.MethodGet, "/sessions?canvasId=c-prelaunch", nil)
	if err != nil {
		t.Fatalf("NewChildRequest(preLaunch): %v", err)
	}
	streamResp, err := preLaunchStreamClient.Do(streamReq)
	if err != nil {
		t.Fatalf("pre-launch StreamHTTPClient failed to dial child pipe after Launch: %v", err)
	}
	defer streamResp.Body.Close()
	if streamResp.StatusCode != http.StatusOK {
		t.Fatalf("pre-launch StreamHTTPClient status=%d want 200", streamResp.StatusCode)
	}
}

func TestPipeModeStripsPortAndNeverFallsBackToLoopbackTCP(t *testing.T) {
	if runtime.GOOS != "windows" {
		sockDir, err := filepath.EvalSymlinks("/tmp")
		if err != nil {
			sockDir = "/tmp"
		}
		t.Setenv("BEEFTV_AGENT_IPC_DIR", sockDir)
	}
	host := fixtureHost(t, "http")
	host.opts.HostToken = func() string { return "pipe-only-token" }
	if err := host.Launch(fixtureProvider(), "http://127.0.0.1:18090/api", "desk-tok"); err != nil {
		t.Fatalf("host.Launch: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(host.dataDir(), "child-env.txt"))
	if err != nil {
		t.Fatal(err)
	}
	childEnv := strings.Split(string(raw), "\n")
	pipeVal := envValue(childEnv, "BEEFTV_AGENT_PIPE")
	if pipeVal == "" {
		t.Fatal("expected non-empty BEEFTV_AGENT_PIPE in pipe mode")
	}
	if port := envValue(childEnv, "BEEFTV_AGENT_PORT"); port != "" {
		t.Fatalf("pipe mode must not allocate or pass BEEFTV_AGENT_PORT, got %q", port)
	}
	if strings.Contains(host.Endpoint(), filepath.Base(pipeVal)) {
		t.Fatalf("public Endpoint %q must not expose raw pipe name %q", host.Endpoint(), pipeVal)
	}

	var tcpHits atomic.Int32
	tcpSpoof, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer tcpSpoof.Close()
	spoofSrv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		tcpHits.Add(1)
		w.WriteHeader(http.StatusOK)
	})}
	defer spoofSrv.Close()
	go func() { _ = spoofSrv.Serve(tcpSpoof) }()

	client := host.HTTPClient(2 * time.Second)
	streamClient := host.StreamHTTPClient(2 * time.Second)
	if err := host.Stop(); err != nil {
		t.Fatal(err)
	}
	spoofURL := "http://" + tcpSpoof.Addr().String() + "/health"
	if resp, err := client.Get(spoofURL); err == nil {
		resp.Body.Close()
		t.Fatal("pipe-bound HTTPClient must fail rather than falling back to TCP")
	}
	if resp, err := streamClient.Get(spoofURL); err == nil {
		resp.Body.Close()
		t.Fatal("pipe-bound StreamHTTPClient must fail rather than falling back to TCP")
	}
	if tcpHits.Load() != 0 {
		t.Fatalf("pipe-bound clients dialed TCP %d times", tcpHits.Load())
	}
}
