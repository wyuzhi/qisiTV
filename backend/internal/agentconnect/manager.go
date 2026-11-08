package agentconnect

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"infinite-canvas/backend/internal/agentops"
)

var (
	// ErrAgentNotFound means no usable official CLI was found.
	ErrAgentNotFound = errors.New("agent not found")
	// ErrUnsupported means the kind has no one-click integration.
	ErrUnsupported = errors.New("unsupported agent")
	// ErrUnsafeCommand means the CLI exists but its path, arguments or
	// environment values cannot be passed safely through a Windows cmd shim.
	ErrUnsafeCommand = errors.New("unsafe cli command")
)

// DefaultCommandTimeout bounds every external CLI call. A wedged CLI must not
// hold the connect lock forever.
const DefaultCommandTimeout = 30 * time.Second

const commandWaitDelay = 5 * time.Second

// Runner isolates process execution so tests never touch the real CLIs.
type Runner interface {
	LookPath(file string) (string, error)
	Run(ctx context.Context, name string, args []string, env []string) error
}

type execRunner struct{}

func (execRunner) LookPath(file string) (string, error) { return exec.LookPath(file) }

func (execRunner) Run(ctx context.Context, name string, args []string, env []string) error {
	comspec := ""
	if isBatchScript(name) {
		comspec = windowsComspec()
	}
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" && comspec != "" {
		line, err := windowsBatchCommandLine(comspec, name, args)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrUnsafeCommand, err)
		}
		cmd = scriptCommand(ctx, comspec, line)
		if cmd == nil {
			return fmt.Errorf("%w: 无法创建命令解释器", ErrUnsafeCommand)
		}
	} else {
		cmd = exec.CommandContext(ctx, name, args...)
	}
	cmd.WaitDelay = commandWaitDelay
	cmd.Env = env
	var stderr strings.Builder
	cmd.Stderr = &stderr
	cmd.Stdout = nil
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if len(message) > 300 {
			message = message[:300]
		}
		if message == "" {
			return err
		}
		return fmt.Errorf("%w: %s", err, message)
	}
	return nil
}

// Manager finds and invokes the official agent CLIs under one home directory
// and owns BeefTV's one-click records and token files.
type Manager struct {
	Home           string
	DataDir        string
	Runner         Runner
	CLIDirs        []string
	CommandTimeout time.Duration
}

// NewDefault uses the current user's home and the desktop workspace data dir.
func NewDefault(dataDir string) *Manager {
	home, _ := os.UserHomeDir()
	dataDir = strings.TrimSpace(dataDir)
	if dataDir != "" {
		if absolute, err := filepath.Abs(dataDir); err == nil {
			dataDir = absolute
		}
	}
	return &Manager{Home: home, DataDir: dataDir, Runner: execRunner{}}
}

// Available reports whether both the home and data directories are known.
func (m *Manager) Available() bool {
	return m != nil && strings.TrimSpace(m.Home) != "" && strings.TrimSpace(m.DataDir) != ""
}

func displayName(kind agentops.ClientKind) string {
	switch kind {
	case agentops.ClientKindClaude:
		return "Claude Code"
	case agentops.ClientKindCodex:
		return "Codex"
	default:
		return ""
	}
}

func cliName(kind agentops.ClientKind) string {
	switch kind {
	case agentops.ClientKindClaude:
		return "claude"
	case agentops.ClientKindCodex:
		return "codex"
	default:
		return ""
	}
}

// executable finds a CLI even when the desktop app was launched from Finder
// with a minimal PATH. A batch shim whose path cannot be escaped safely is
// treated as not found.
func (m *Manager) executable(kind agentops.ClientKind) string {
	name := cliName(kind)
	if name == "" || !m.Available() {
		return ""
	}
	if path := m.lookup(name); path != "" {
		return path
	}
	return ""
}

func (m *Manager) lookup(name string) string {
	if m.Runner != nil {
		if path, err := m.Runner.LookPath(name); err == nil && path != "" {
			return path
		}
	}
	names := []string{name}
	if runtime.GOOS == "windows" && !strings.HasSuffix(name, ".exe") {
		names = append(names, name+".exe", name+".cmd", name+".bat")
	}
	dirs := m.CLIDirs
	if dirs == nil {
		dirs = []string{
			filepath.Join(m.Home, ".local", "bin"),
			filepath.Join(m.Home, ".bun", "bin"),
			filepath.Join(m.Home, ".npm-global", "bin"),
			"/opt/homebrew/bin",
			"/usr/local/bin",
		}
	}
	for _, dir := range dirs {
		for _, candidateName := range names {
			candidate := filepath.Join(dir, candidateName)
			if executableFile(candidate) {
				return candidate
			}
		}
	}
	return ""
}

func executableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		return false
	}
	return runtime.GOOS == "windows" || info.Mode().Perm()&0o111 != 0
}

// Detected reports whether the official CLI is present and safely executable
// on its own. Validate additionally checks the full launch.
func (m *Manager) Detected(kind agentops.ClientKind) bool {
	return m.Available() && m.executable(kind) != ""
}

// Validate checks the complete CLI invocation (command, arguments and env
// values) before any credential is issued or any configuration is removed.
// Batch shims are validated even on non-Windows hosts so tests can exercise
// the same rules.
func (m *Manager) Validate(kind agentops.ClientKind, spec LaunchSpec) error {
	cli := m.executable(kind)
	if cli == "" {
		return ErrAgentNotFound
	}
	return validateCommand(cli, addArgs(kind, spec))
}

func validateCommand(cli string, args []string) error {
	if !isBatchScript(cli) {
		return nil
	}
	if _, err := windowsBatchCommandLine(windowsComspec(), cli, args); err != nil {
		return err
	}
	return nil
}

// Connect writes the MCP entry through the official CLI, confirms it once with
// `mcp get`, and installs the canvas skill. The caller owns credential
// issuance, the token file and the persisted record.
func (m *Manager) Connect(kind agentops.ClientKind, spec LaunchSpec) error {
	if !m.Available() || displayName(kind) == "" {
		return ErrUnsupported
	}
	if err := m.Validate(kind, spec); err != nil {
		return err
	}
	cli := m.executable(kind)
	// Removing first makes repeated connects idempotent. A missing entry is
	// expected and must not block the add.
	_ = m.run(cli, removeArgs(kind))
	if err := m.run(cli, addArgs(kind, spec)); err != nil {
		if errors.Is(err, ErrUnsafeCommand) {
			return err
		}
		return fmt.Errorf("写入 %s 配置失败：%w", displayName(kind), err)
	}
	if err := m.run(cli, getArgs()); err != nil {
		return fmt.Errorf("%s 配置没有生效：%w", displayName(kind), err)
	}
	// A skill ownership conflict must not fail the connection. The status
	// reports whether the usage note was actually installed.
	_ = m.installSkill(kind)
	return nil
}

// RemoveConfig attempts to remove the beeftv entry. Callers use its error as a
// user-visible warning after access has already been cut.
func (m *Manager) RemoveConfig(kind agentops.ClientKind) error {
	if displayName(kind) == "" {
		return ErrUnsupported
	}
	cli := m.executable(kind)
	if cli == "" {
		return ErrAgentNotFound
	}
	if err := validateCommand(cli, removeArgs(kind)); err != nil {
		return err
	}
	return m.run(cli, removeArgs(kind))
}

// RemoveSkill removes only the managed skill directory.
func (m *Manager) RemoveSkill(kind agentops.ClientKind) error {
	if !m.Available() {
		return ErrUnsupported
	}
	return m.removeSkill(kind)
}

// SkillInstalled reports whether every managed skill target is present.
func (m *Manager) SkillInstalled(kind agentops.ClientKind) bool {
	if !m.Available() {
		return false
	}
	return m.skillInstalled(kind)
}

func (m *Manager) run(cli string, args []string) error {
	if m.Runner == nil {
		return errors.New("no command runner")
	}
	timeout := m.CommandTimeout
	if timeout <= 0 {
		timeout = DefaultCommandTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return m.Runner.Run(ctx, cli, args, m.childEnv())
}

// childEnv pins HOME when tests use a temporary home. In production it is the
// same value the process already has.
func (m *Manager) childEnv() []string {
	current, _ := os.UserHomeDir()
	if !m.Available() || filepath.Clean(current) == filepath.Clean(m.Home) {
		return os.Environ()
	}
	env := make([]string, 0, len(os.Environ())+2)
	for _, item := range os.Environ() {
		if strings.HasPrefix(item, "HOME=") || strings.HasPrefix(item, "USERPROFILE=") {
			continue
		}
		env = append(env, item)
	}
	env = append(env, "HOME="+m.Home, "USERPROFILE="+m.Home)
	return env
}

func getArgs() []string {
	return []string{"mcp", "get", ServerName}
}

func removeArgs(kind agentops.ClientKind) []string {
	if kind == agentops.ClientKindClaude {
		return []string{"mcp", "remove", "--scope", "user", ServerName}
	}
	return []string{"mcp", "remove", ServerName}
}

func addArgs(kind agentops.ClientKind, spec LaunchSpec) []string {
	if kind == agentops.ClientKindClaude {
		args := []string{"mcp", "add", ServerName, "--scope", "user"}
		for _, item := range spec.Env {
			args = append(args, "-e", item.Key+"="+item.Value)
		}
		args = append(args, "--", spec.Command)
		return append(args, spec.Args...)
	}
	args := []string{"mcp", "add", ServerName}
	for _, item := range spec.Env {
		args = append(args, "--env", item.Key+"="+item.Value)
	}
	args = append(args, "--", spec.Command)
	return append(args, spec.Args...)
}
