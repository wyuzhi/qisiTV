// Package pluginhost 在一个 Node 子进程里运行插件的 JS 生成接口。做法照 Magpie 的插件
// 宿主：按行收发 JSON，后端按 id 配对请求与回复，取消时发 abort；插件代码自己发请求。
// 同一插件换了版本时，新调用进新进程，旧进程等手上的调用结束后随 stdin 关闭退出。
package pluginhost

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/assistantruntime"
)

const scriptName = "plugin-host.mjs"

// 单次调用的上限，覆盖插件自己的网络超时；轮询节奏由调用方决定。
var methodTimeouts = map[string]time.Duration{"submit": 5 * time.Minute, "query": time.Minute, "models": 25 * time.Second}

// Call 描述一次插件函数调用。Version 变化会让该插件进入新的宿主进程。
type Call struct {
	Plugin  string
	Version string
	Module  string
	Method  string
	Args    any
}

type Host struct {
	mu      sync.Mutex
	resolve func() (string, string, error)
	current *process
}

var defaultHost = &Host{resolve: resolveCommand}

// Do 用进程级宿主执行一次调用；每个后端进程只服务一个工作区，所以只有一个宿主。
func Do(ctx context.Context, call Call, out any) error { return defaultHost.Do(ctx, call, out) }

// Close 结束宿主进程，由桌面运行时在退出时调用。
func Close() { defaultHost.Close() }

// UseCommandForTesting 让测试用指定的 node 与脚本启动宿主，返回恢复函数。
func UseCommandForTesting(node, script string) func() {
	defaultHost.Close()
	defaultHost.mu.Lock()
	previous := defaultHost.resolve
	defaultHost.resolve = func() (string, string, error) { return node, script, nil }
	defaultHost.mu.Unlock()
	return func() {
		defaultHost.Close()
		defaultHost.mu.Lock()
		defaultHost.resolve = previous
		defaultHost.mu.Unlock()
	}
}

func (h *Host) Do(ctx context.Context, call Call, out any) error {
	if timeout, ok := methodTimeouts[call.Method]; ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	p, err := h.acquire(call)
	if err != nil {
		return err
	}
	defer p.release()
	raw, err := p.call(ctx, map[string]any{"module": call.Module, "fn": call.Method, "args": call.Args})
	if err != nil || out == nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

func (h *Host) Close() {
	h.mu.Lock()
	p := h.current
	h.current = nil
	h.mu.Unlock()
	if p != nil {
		p.kill()
	}
}

func (h *Host) acquire(call Call) (*process, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	p := h.current
	if p != nil && (p.exited() || p.loadsOtherVersion(call.Plugin, call.Version)) {
		p.retire()
		p = nil
	}
	if p == nil {
		node, script, err := h.resolve()
		if err != nil {
			return nil, err
		}
		if p, err = start(node, script); err != nil {
			return nil, err
		}
		h.current = p
	}
	p.hold(call.Plugin, call.Version)
	return p, nil
}

type reply struct {
	ID     int64           `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
	Event   string `json:"event"`
	Level   string `json:"level"`
	Message string `json:"message"`
}

type process struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	done  chan struct{}

	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  int64
	waiting map[int64]chan reply
	loaded  map[string]string
	active  int
	retired bool
	failure error
}

func start(node, script string) (*process, error) {
	cmd := exec.Command(node, script)
	cmd.Dir = filepath.Dir(script)
	cmd.Env = childEnv()
	cmd.Stderr = logWriter{}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("启动插件宿主失败：%w", err)
	}
	p := &process{cmd: cmd, stdin: stdin, done: make(chan struct{}), waiting: map[int64]chan reply{}, loaded: map[string]string{}}
	go p.read(stdout)
	return p, nil
}

func (p *process) read(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), 32<<20)
	for scanner.Scan() {
		var message reply
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			continue
		}
		if message.Event == "log" {
			log.Printf("plugin host %s: %s", message.Level, message.Message)
			continue
		}
		p.mu.Lock()
		ch := p.waiting[message.ID]
		delete(p.waiting, message.ID)
		p.mu.Unlock()
		if ch != nil {
			ch <- message
		}
	}
	waitErr := p.cmd.Wait()
	p.mu.Lock()
	p.failure = fmt.Errorf("插件宿主已退出：%v", waitErr)
	for id, ch := range p.waiting {
		delete(p.waiting, id)
		close(ch)
	}
	p.mu.Unlock()
	close(p.done)
}

func (p *process) call(ctx context.Context, params map[string]any) (json.RawMessage, error) {
	ch := make(chan reply, 1)
	p.mu.Lock()
	if p.failure != nil {
		err := p.failure
		p.mu.Unlock()
		return nil, err
	}
	p.nextID++
	id := p.nextID
	p.waiting[id] = ch
	p.mu.Unlock()
	if err := p.write(map[string]any{"id": id, "method": "call", "params": params}); err != nil {
		p.forget(id)
		return nil, err
	}
	select {
	case message, ok := <-ch:
		if !ok {
			return nil, p.exitError()
		}
		if message.Error != nil {
			return nil, errors.New(message.Error.Message)
		}
		return message.Result, nil
	case <-ctx.Done():
		p.forget(id)
		_ = p.write(map[string]any{"method": "abort", "params": map[string]any{"id": id}})
		return nil, ctx.Err()
	}
}

func (p *process) write(message any) error {
	line, err := json.Marshal(message)
	if err != nil {
		return err
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	_, err = p.stdin.Write(append(line, '\n'))
	return err
}

func (p *process) forget(id int64) {
	p.mu.Lock()
	delete(p.waiting, id)
	p.mu.Unlock()
}

func (p *process) exitError() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.failure != nil {
		return p.failure
	}
	return errors.New("插件宿主已退出")
}

func (p *process) exited() bool {
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

func (p *process) loadsOtherVersion(plugin, version string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	loaded, ok := p.loaded[plugin]
	return ok && loaded != version
}

func (p *process) hold(plugin, version string) {
	p.mu.Lock()
	p.loaded[plugin] = version
	p.active++
	p.mu.Unlock()
}

func (p *process) release() {
	p.mu.Lock()
	p.active--
	closeNow := p.retired && p.active == 0
	p.mu.Unlock()
	if closeNow {
		_ = p.stdin.Close()
	}
}

// retire 让旧进程不再接新调用；手上的调用结束后关闭 stdin，Node 端随之退出。
func (p *process) retire() {
	p.mu.Lock()
	p.retired = true
	closeNow := p.active == 0
	p.mu.Unlock()
	if closeNow {
		_ = p.stdin.Close()
	}
}

func (p *process) kill() {
	_ = p.stdin.Close()
	select {
	case <-p.done:
	case <-time.After(3 * time.Second):
		_ = p.cmd.Process.Kill()
	}
}

type logWriter struct{}

func (logWriter) Write(data []byte) (int, error) {
	if text := strings.TrimSpace(string(data)); text != "" {
		log.Printf("plugin host: %s", text)
	}
	return len(data), nil
}

// childEnv 只传系统运行需要的变量和代理设置；插件拿到的密钥只来自每次调用的参数。
func childEnv() []string {
	keep := map[string]bool{"PATH": true, "HOME": true, "USERPROFILE": true, "TMPDIR": true, "TMP": true, "TEMP": true, "SYSTEMROOT": true, "LANG": true, "LC_ALL": true,
		"HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true, "ALL_PROXY": true}
	env := make([]string, 0, len(keep))
	for _, item := range os.Environ() {
		name, _, _ := strings.Cut(item, "=")
		if keep[strings.ToUpper(name)] {
			env = append(env, item)
		}
	}
	return env
}

// resolveCommand 优先用安装包自带的 Node 与脚本；开发时用 PATH 上的 node 和仓库里的脚本。
func resolveCommand() (string, string, error) {
	executable, _ := os.Executable()
	if bundled := assistantruntime.BundledConfig(executable, runtime.GOOS); bundled.HostCommand != "" && len(bundled.HostArgs) > 0 {
		script := filepath.Join(filepath.Dir(bundled.HostArgs[0]), scriptName)
		if _, err := os.Stat(script); err == nil {
			return bundled.HostCommand, script, nil
		}
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return "", "", errors.New("找不到运行插件需要的 Node")
	}
	dir, _ := os.Getwd()
	for range 6 {
		script := filepath.Join(dir, "agent-host", scriptName)
		if _, err := os.Stat(script); err == nil {
			return node, script, nil
		}
		dir = filepath.Dir(dir)
	}
	return "", "", errors.New("找不到插件宿主脚本 " + scriptName)
}
