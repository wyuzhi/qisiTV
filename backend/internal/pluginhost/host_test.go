package pluginhost

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const fixture = `
import { appendFileSync } from 'node:fs';

export async function submit(request) {
  appendFileSync(request.marker, 'submit');
  return { taskId: 'now' };
}

export async function query(taskId, request, ctx) {
  if (taskId === 'spin') {
    appendFileSync(request.marker, 'spin');
    for (;;) {}
  }
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

func TestCancelledCallNeverReachesThePlugin(t *testing.T) {
	host, module := testHost(t)
	marker := filepath.Join(t.TempDir(), "marker")
	submit := Call{Plugin: "p", Version: "1", Module: module, Method: "submit", Args: map[string]any{"request": map[string]any{"marker": marker}}}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := host.Do(cancelled, submit, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if host.current != nil {
		t.Fatal("a cancelled call should not start the plugin host")
	}

	// 拿到进程之后才取消，也不能发出去。
	p, err := host.acquire(submit)
	if err != nil {
		t.Fatal(err)
	}
	defer p.release()
	if _, err := p.call(cancelled, map[string]any{"module": module, "fn": "submit", "args": submit.Args}); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	var after answer
	if err := host.Do(context.Background(), Call{Plugin: "p", Version: "1", Module: module, Method: "query", Args: map[string]any{"taskId": "now"}}, &after); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("submit reached the plugin: %v", err)
	}
}

func spinCall(module, marker string) Call {
	return Call{Plugin: "p", Version: "1", Module: module, Method: "query", Args: map[string]any{"taskId": "spin", "request": map[string]any{"marker": marker}}}
}

func expectFreshProcess(t *testing.T, host *Host, module string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var after answer
	if err := host.Do(ctx, Call{Plugin: "p", Version: "1", Module: module, Method: "query", Args: map[string]any{"taskId": "now"}}, &after); err != nil || after.PID == 0 {
		t.Fatalf("next call after a stuck plugin: %+v %v", after, err)
	}
}

// 插件写了死循环时 Node 不再回消息，调用超时后要换掉进程，不然后面的调用都等到超时。
func TestPluginThatStopsRespondingIsReplaced(t *testing.T) {
	host, module := testHost(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := host.Do(ctx, spinCall(module, filepath.Join(t.TempDir(), "marker")), nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	expectFreshProcess(t, host, module)
}

// Node 卡住后不再读 stdin，管道写满，写入本身也要能被取消。
func TestWriteToAStuckPluginCanBeCancelled(t *testing.T) {
	host, module := testHost(t)
	marker := filepath.Join(t.TempDir(), "marker")
	stuck := make(chan error, 1)
	spinCtx, cancelSpin := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelSpin()
	go func() { stuck <- host.Do(spinCtx, spinCall(module, marker), nil) }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("plugin never started spinning")
		}
		time.Sleep(10 * time.Millisecond)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	started := time.Now()
	larger := map[string]any{"taskId": "now", "padding": strings.Repeat("x", 1<<20)}
	if err := host.Do(ctx, Call{Plugin: "p", Version: "1", Module: module, Method: "query", Args: larger}, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	if elapsed := time.Since(started); elapsed > abortAckTimeout+5*time.Second {
		t.Fatalf("cancelled call returned after %s", elapsed)
	}
	select {
	case err := <-stuck:
		if err == nil {
			t.Fatal("the stuck call should fail")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the stuck call never returned")
	}
	expectFreshProcess(t, host, module)
}

func TestCloseEndsOldVersionsStillRunning(t *testing.T) {
	host, module := testHost(t)
	var first answer
	if err := host.Do(context.Background(), Call{Plugin: "p", Version: "1", Module: module, Method: "query", Args: map[string]any{"taskId": "now"}}, &first); err != nil {
		t.Fatal(err)
	}
	old := host.current
	waiting := make(chan error, 1)
	go func() {
		waiting <- host.Do(context.Background(), Call{Plugin: "p", Version: "1", Module: module, Method: "query", Args: map[string]any{"taskId": "wait"}}, nil)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		old.mu.Lock()
		active := old.active
		old.mu.Unlock()
		if active == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("call never reached the process")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := host.Do(context.Background(), Call{Plugin: "p", Version: "2", Module: module, Method: "query", Args: map[string]any{"taskId": "now"}}, nil); err != nil {
		t.Fatal(err)
	}
	if host.current == old {
		t.Fatal("new version should run in a new process")
	}

	host.Close()
	select {
	case err := <-waiting:
		if err == nil {
			t.Fatal("the running call should fail when the host closes")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("old process kept running after Close")
	}
	if !old.exited() {
		t.Fatal("old process did not exit")
	}
}
