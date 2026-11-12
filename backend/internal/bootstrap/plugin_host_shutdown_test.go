package bootstrap

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"qisitv/backend/internal/pluginhost"
)

// 退出时还在跑的生成任务要等它们自己停下，插件宿主不能先被关掉。
func TestRuntimeClosesPluginHostAfterBackgroundWork(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	script, err := filepath.Abs(filepath.Join("..", "..", "..", "agent-host", "plugin-host.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pluginhost.UseCommandForTesting(node, script))
	module := filepath.Join(t.TempDir(), "provider.mjs")
	source := "export const query = (taskId, request, ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));\n"
	if err := os.WriteFile(module, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	r, err := Open(t.Context(), Config{Profile: ProfileDesktop, DataDir: t.TempDir(), ListenAddr: "127.0.0.1:0", AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Close(context.Background()) })
	background := make(chan struct{})
	r.backgroundDone = background

	running := make(chan error, 1)
	go func() {
		running <- pluginhost.Do(context.Background(), pluginhost.Call{Plugin: "p", Version: "1", Module: module, Method: "query", Args: map[string]any{"taskId": "t"}}, nil)
	}()
	closed := make(chan error, 1)
	go func() { closed <- r.Close(context.Background()) }()

	select {
	case err := <-running:
		t.Fatalf("plugin call ended while background work was still running: %v", err)
	case <-time.After(4 * time.Second):
	}
	close(background)
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-running:
		if err == nil {
			t.Fatal("the plugin call should end with the host")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("plugin call kept running after the runtime closed")
	}
}
