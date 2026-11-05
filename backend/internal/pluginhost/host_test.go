package pluginhost

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

const fixture = `
export async function query(taskId, request, ctx) {
  if (taskId === 'wait') {
    await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  }
  console.log('stdout stays clean');
  return { pid: process.pid, apiKey: ctx.config.apiKey };
}
`

func testHost(t *testing.T) (*Host, string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	script, err := filepath.Abs(filepath.Join("..", "..", "..", "agent-host", scriptName))
	if err != nil {
		t.Fatal(err)
	}
	module := filepath.Join(t.TempDir(), "provider.mjs")
	if err := os.WriteFile(module, []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
	host := &Host{resolve: func() (string, string, error) { return node, script, nil }}
	t.Cleanup(host.Close)
	return host, module
}

type answer struct {
	PID    int    `json:"pid"`
	APIKey string `json:"apiKey"`
}

func TestNewPluginVersionGetsANewProcess(t *testing.T) {
	host, module := testHost(t)
	args := map[string]any{"taskId": "now", "config": map[string]any{"apiKey": "k"}}
	var first, same, upgraded answer
	for _, step := range []struct {
		version string
		out     *answer
	}{{"1.0.0", &first}, {"1.0.0", &same}, {"1.1.0", &upgraded}} {
		if err := host.Do(context.Background(), Call{Plugin: "p", Version: step.version, Module: module, Method: "query", Args: args}, step.out); err != nil {
			t.Fatal(err)
		}
	}
	if first.APIKey != "k" || first.PID != same.PID || upgraded.PID == first.PID {
		t.Fatalf("first=%+v same=%+v upgraded=%+v", first, same, upgraded)
	}
}

func TestCancelAbortsThePluginCall(t *testing.T) {
	host, module := testHost(t)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	err := host.Do(ctx, Call{Plugin: "p", Version: "1", Module: module, Method: "query", Args: map[string]any{"taskId": "wait"}}, nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	var after answer
	if err := host.Do(context.Background(), Call{Plugin: "p", Version: "1", Module: module, Method: "query", Args: map[string]any{"taskId": "now"}}, &after); err != nil || after.PID == 0 {
		t.Fatalf("host after abort: %+v %v", after, err)
	}
}
