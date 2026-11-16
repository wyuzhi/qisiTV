package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/localipc"
	"infinite-canvas/backend/internal/runtimeinfo"
)

func testCLIWorkspacePipe(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		return localipc.WorkspaceEndpoint(t.TempDir())
	}
	dir, err := filepath.EvalSymlinks("/tmp")
	if err != nil {
		dir = "/tmp"
	}
	return filepath.Join(dir, fmt.Sprintf("btv-cli-%d.sock", time.Now().UnixNano()%1_000_000_000))
}

func TestCLIDiscoversAndUsesLocalPipeWhenLoopbackPortIsBlocked(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	dataDir := filepath.Join(home, "workspace")
	t.Setenv("BEEFTV_DATA_DIR", dataDir)
	t.Setenv("BEEFTV_BASE_URL", "")
	t.Setenv("BEEFTV_OWNER_TOKEN", "owner-secret")
	t.Setenv("BEEFTV_DESKTOP_TOKEN", "desk-secret")
	// Even a hostile HTTP_PROXY must never intercept local workspace CLI calls.
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("http_proxy", "http://127.0.0.1:1")

	pipeEndpoint := testCLIWorkspacePipe(t)
	listener, err := localipc.Listen(pipeEndpoint)
	if err != nil {
		t.Fatalf("localipc.Listen(%s): %v", pipeEndpoint, err)
	}
	defer listener.Close()

	var observedHost, observedRemote, observedOwner, observedDesktop string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ops", func(w http.ResponseWriter, r *http.Request) {
		observedHost = r.Host
		observedRemote = r.RemoteAddr
		observedOwner = r.Header.Get("X-Beeftv-Owner")
		observedDesktop = r.Header.Get("X-Desktop-Token")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": 0,
			"data": map[string]any{
				"ops": []map[string]any{{"id": "canvas.get", "summary": "read", "readOnly": true, "scope": "canvas"}},
			},
		})
	})
	srv := &http.Server{Handler: mux}
	defer srv.Close()
	go func() { _ = srv.Serve(listener) }()

	// Port 1 is intentionally closed/unreachable; CLI must reach /api/ops via pipePath.
	if err := runtimeinfo.Write(dataDir, "http://127.0.0.1:1/api", pipeEndpoint, "v-test"); err != nil {
		t.Fatalf("runtimeinfo.Write: %v", err)
	}
	defer runtimeinfo.Remove(dataDir)

	cli, err := newClient()
	if err != nil {
		t.Fatalf("newClient: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	raw, err := cli.do(ctx, http.MethodGet, "/ops", nil)
	if err != nil {
		t.Fatalf("cli.do over local IPC failed: %v", err)
	}
	if len(raw) == 0 {
		t.Fatal("expected non-empty response data")
	}
	if observedHost != "127.0.0.1:1" {
		t.Fatalf("observedHost=%q want 127.0.0.1:1", observedHost)
	}
	if observedRemote != "127.0.0.1:0" {
		t.Fatalf("observedRemote=%q want 127.0.0.1:0", observedRemote)
	}
	if observedOwner != "owner-secret" || observedDesktop != "desk-secret" {
		t.Fatalf("credentials not forwarded over local IPC: owner=%q desktop=%q", observedOwner, observedDesktop)
	}
}

func TestCLIFailsClosedWhenPublishedPipeBreaksNeverTouchingTCPSquatter(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	dataDir := filepath.Join(home, "workspace-fail-closed")
	t.Setenv("BEEFTV_DATA_DIR", dataDir)
	t.Setenv("BEEFTV_BASE_URL", "")
	t.Setenv("BEEFTV_OWNER_TOKEN", "sensitive-owner-token")
	t.Setenv("BEEFTV_DESKTOP_TOKEN", "sensitive-desktop-token")

	var squatterHits atomic.Int32
	squatter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		squatterHits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"ops":[]}}`))
	}))
	defer squatter.Close()

	// Publish a dead/closed local pipe alongside the live TCP squatter URL.
	deadPipe := testCLIWorkspacePipe(t)
	if err := runtimeinfo.Write(dataDir, squatter.URL+"/api", deadPipe, "v-test"); err != nil {
		t.Fatalf("runtimeinfo.Write: %v", err)
	}
	defer runtimeinfo.Remove(dataDir)

	cli, err := newClient()
	if err != nil {
		t.Fatalf("newClient: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := cli.do(ctx, http.MethodGet, "/ops", nil); err == nil {
		t.Fatal("expected CLI to fail closed when published local pipe is unavailable")
	}
	if _, err := cli.callBusiness(ctx, businessTool{Method: "GET", Path: "/assets"}, businessArgs{}); err == nil {
		t.Fatal("expected CLI business call to fail closed when published local pipe is unavailable")
	}
	if squatterHits.Load() != 0 {
		t.Fatalf("CLI leaked credentials to TCP squatter %d times when published pipe failed", squatterHits.Load())
	}
}
