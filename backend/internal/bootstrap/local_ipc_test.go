package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/assistant"
	"infinite-canvas/backend/internal/assistantruntime"
	"infinite-canvas/backend/internal/runtimeinfo"
)

type controllableFailListener struct {
	failCh chan struct{}
	closed chan struct{}
	once   sync.Once
}

func newControllableFailListener() *controllableFailListener {
	return &controllableFailListener{
		failCh: make(chan struct{}),
		closed: make(chan struct{}),
	}
}

func (l *controllableFailListener) Accept() (net.Conn, error) {
	select {
	case <-l.failCh:
		return nil, errors.New("simulated pipe accept failure")
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

func (l *controllableFailListener) triggerFail() {
	l.once.Do(func() { close(l.failCh) })
}

func (l *controllableFailListener) Close() error {
	select {
	case <-l.closed:
	default:
		close(l.closed)
	}
	return nil
}

func (l *controllableFailListener) Addr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0}
}

func TestDesktopRuntimeClearsPipeDescriptorAndStopsHostWhenPipeListenerFails(t *testing.T) {
	nodeBin, lookErr := exec.LookPath("node")
	if lookErr != nil {
		t.Skip("node not installed")
	}
	scriptPath, absErr := filepath.Abs(filepath.Join("..", "..", "..", "agent-host", "test-support", "owned-listener.mjs"))
	if absErr != nil {
		t.Fatal(absErr)
	}
	if _, statErr := os.Stat(scriptPath); statErr != nil {
		t.Fatalf("owned-listener.mjs missing: %v", statErr)
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	fakeEndpoint := `\\.\pipe\beeftv-boot-fail-test`
	if runtime.GOOS != "windows" {
		sockRoot, err := filepath.EvalSymlinks("/tmp")
		if err != nil {
			sockRoot = "/tmp"
		}
		fakeEndpoint = filepath.Join(sockRoot, fmt.Sprintf("btv-boot-fail-%d.sock", time.Now().UnixNano()%1_000_000_000))
	}
	t.Setenv("CANVAS_DESKTOP_IPC_ENDPOINT", fakeEndpoint)

	ctrlLn := newControllableFailListener()
	var listenCalls atomic.Int32
	prevListen := listenWorkspaceIPCFn
	listenWorkspaceIPCFn = func(string) (net.Listener, error) {
		listenCalls.Add(1)
		return ctrlLn, nil
	}
	t.Cleanup(func() { listenWorkspaceIPCFn = prevListen })

	dataDir := filepath.Join(home, "desktop-data")
	rt, err := Open(context.Background(), Config{
		Profile:     ProfileDesktop,
		DataDir:     dataDir,
		ListenAddr:  "127.0.0.1:0",
		AutoMigrate: true,
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer rt.Close(context.Background())
	if err := rt.assistantHost.WriteConfig(assistantruntime.HostConfig{
		HostCommand: nodeBin,
		HostArgs:    []string{scriptPath},
	}); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}

	if err := rt.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if listenCalls.Load() != 1 {
		t.Fatalf("expected listenWorkspaceIPCFn called once, got %d", listenCalls.Load())
	}

	provider := assistant.Provider{
		Model:    "deepseek-chat",
		BaseURL:  "http://127.0.0.1:1/v1",
		APIKey:   "sk-boot-test",
		Protocol: "chat-completion",
	}
	if err := rt.assistantHost.Launch(provider, rt.BaseURL(), rt.LaunchToken()); err != nil {
		t.Fatalf("assistantHost.Launch: %v", err)
	}
	if !rt.assistantHost.Running() {
		t.Fatal("expected assistantHost to be running before pipe Serve failure")
	}
	initialOpsPipe, readErr := os.ReadFile(filepath.Join(dataDir, "ops-pipe.txt"))
	if readErr != nil || strings.TrimSpace(string(initialOpsPipe)) != fakeEndpoint {
		t.Fatalf("expected initial child BEEFTV_OPS_PIPE=%q, got %q (err=%v)", fakeEndpoint, initialOpsPipe, readErr)
	}

	// Trigger post-start Serve failure on the workspace pipe listener.
	ctrlLn.triggerFail()

	deadline := time.Now().Add(4 * time.Second)
	cleared := false
	for time.Now().Before(deadline) {
		info, found := runtimeinfo.Discover(dataDir)
		if found && info.PipePath == "" && !rt.assistantHost.Running() {
			cleared = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !cleared {
		info, found := runtimeinfo.Discover(dataDir)
		t.Fatalf("expected PipePath cleared and assistantHost stopped after pipe Serve failure: found=%v info=%+v running=%v", found, info, rt.assistantHost.Running())
	}

	launched, ensureErr := rt.assistantHost.Ensure(provider, rt.BaseURL(), rt.LaunchToken(), true)
	if ensureErr != nil || !launched || !rt.assistantHost.Running() {
		t.Fatalf("expected Ensure to relaunch assistantHost cleanly with empty opsPipe: launched=%v err=%v", launched, ensureErr)
	}
	restartedOpsPipe, readErr := os.ReadFile(filepath.Join(dataDir, "ops-pipe.txt"))
	if readErr != nil || strings.TrimSpace(string(restartedOpsPipe)) != "" {
		t.Fatalf("expected restarted child BEEFTV_OPS_PIPE cleared, got %q (err=%v)", restartedOpsPipe, readErr)
	}
}
