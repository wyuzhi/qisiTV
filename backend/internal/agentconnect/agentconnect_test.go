package agentconnect

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"qisitv/backend/internal/agentops"
	"qisitv/backend/internal/securefile"
)

type runCall struct {
	name string
	args []string
}

type fakeRunner struct {
	mu         sync.Mutex
	paths      map[string]string
	runs       []runCall
	present    bool
	addErr     error
	blockOnAdd bool
}

func (f *fakeRunner) LookPath(file string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if path := f.paths[file]; path != "" {
		return path, nil
	}
	return "", exec.ErrNotFound
}

func (f *fakeRunner) Run(ctx context.Context, name string, args []string, _ []string) error {
	f.mu.Lock()
	f.runs = append(f.runs, runCall{name: name, args: append([]string(nil), args...)})
	block := f.blockOnAdd
	f.mu.Unlock()
	if block && len(args) > 1 && args[1] == "add" {
		<-ctx.Done()
		return ctx.Err()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(args) > 1 {
		switch args[1] {
		case "add":
			if f.addErr != nil {
				return f.addErr
			}
			f.present = true
		case "remove":
			f.present = false
		case "get":
			if f.present {
				return nil
			}
			return errors.New("not found")
		}
	}
	return nil
}

func (f *fakeRunner) calls() []runCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]runCall(nil), f.runs...)
}

func testManager(t *testing.T, runner Runner) *Manager {
	t.Helper()
	return &Manager{
		Home:           t.TempDir(),
		DataDir:        t.TempDir(),
		Runner:         runner,
		CLIDirs:        []string{},
		CommandTimeout: 2 * time.Second,
	}
}

func cliManager(t *testing.T) (*Manager, *fakeRunner) {
	t.Helper()
	runner := &fakeRunner{paths: map[string]string{"claude": "/fake/claude", "codex": "/fake/codex"}}
	return testManager(t, runner), runner
}

func spec(tokenFile string) LaunchSpec {
	return Launch("/Applications/qisiTV.app/Contents/MacOS/cli/qisitv", "/tmp/qisitv data", tokenFile, agentops.ClientReadWrite, "client-1")
}

func TestLaunchUsesTokenFileForOneClickAndTokenForManualSetup(t *testing.T) {
	oneClick := Launch("/cli/qisitv", "/data", "/data/agent-clients/claude.token", agentops.ClientReadOnly, "client-1")
	if oneClick.Command != "/cli/qisitv" {
		t.Fatalf("command = %q", oneClick.Command)
	}
	if got := strings.Join(oneClick.Args, " "); got != "mcp serve --read-only" {
		t.Fatalf("args = %q", got)
	}
	if len(oneClick.Env) != 3 || oneClick.Env[0].Key != "BEEFTV_DATA_DIR" || oneClick.Env[1].Key != "BEEFTV_CLIENT_ID" || oneClick.Env[2].Key != "BEEFTV_CLIENT_TOKEN_FILE" {
		t.Fatalf("env order = %#v", oneClick.Env)
	}
	if oneClick.EnvMap()["BEEFTV_CLIENT_TOKEN_FILE"] != "/data/agent-clients/claude.token" {
		t.Fatalf("env map = %#v", oneClick.EnvMap())
	}
	if _, ok := oneClick.EnvMap()["BEEFTV_CLIENT_TOKEN"]; ok {
		t.Fatal("one-click launch must not carry the raw token")
	}

	manual := ManualLaunch("/cli/qisitv", "/data", agentops.ClientReadWrite, "client-1", "secret")
	if manual.EnvMap()["BEEFTV_CLIENT_TOKEN"] != "secret" {
		t.Fatalf("manual env = %#v", manual.EnvMap())
	}
}

func TestConnectUsesClaudeCLIAndInstallsManagedSkill(t *testing.T) {
	manager, runner := cliManager(t)
	tokenFile := filepath.Join(manager.DataDir, "agent-clients", "claude.token")
	if err := manager.Connect(agentops.ClientKindClaude, spec(tokenFile)); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	calls := runner.calls()
	if len(calls) != 3 {
		t.Fatalf("calls = %#v", calls)
	}
	remove := calls[0]
	if remove.name != "/fake/claude" || strings.Join(remove.args, " ") != "mcp remove --scope user qisitv-engine" {
		t.Fatalf("remove call = %#v", remove)
	}
	add := calls[1]
	if add.name != "/fake/claude" || add.args[0] != "mcp" || add.args[1] != "add" || add.args[2] != "qisitv-engine" || add.args[3] != "--scope" || add.args[4] != "user" {
		t.Fatalf("add call = %#v", add)
	}
	joined := strings.Join(add.args, " ")
	for _, want := range []string{"-e BEEFTV_DATA_DIR=/tmp/qisitv data", "-e BEEFTV_CLIENT_TOKEN_FILE=" + tokenFile, "-- /Applications/qisiTV.app/Contents/MacOS/cli/qisitv mcp serve"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("add call missing %q: %s", want, joined)
		}
	}
	if strings.Contains(joined, "secret") {
		t.Fatalf("raw token leaked into CLI args: %s", joined)
	}
	if !manager.SkillInstalled(agentops.ClientKindClaude) {
		t.Fatal("skill was not installed")
	}
	marker, err := os.ReadFile(filepath.Join(manager.Home, ".claude", "skills", SkillName, skillMarkerName))
	if err != nil {
		t.Fatalf("marker: %v", err)
	}
	if !strings.Contains(string(marker), "source: "+skillSource+"\n") || !strings.Contains(string(marker), "version: ") {
		t.Fatalf("marker = %q", marker)
	}
	skill, err := os.ReadFile(filepath.Join(manager.Home, ".claude", "skills", SkillName, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(skill) != string(canvasSkill) {
		t.Fatal("installed skill differs from the embedded skill")
	}
}

func TestConnectIsIdempotentAndRemovesBeforeAdd(t *testing.T) {
	manager, runner := cliManager(t)
	if err := manager.Connect(agentops.ClientKindCodex, spec("/tmp/token")); err != nil {
		t.Fatal(err)
	}
	if err := manager.Connect(agentops.ClientKindCodex, spec("/tmp/token")); err != nil {
		t.Fatal(err)
	}
	calls := runner.calls()
	if len(calls) != 6 {
		t.Fatalf("calls = %#v", calls)
	}
	for index := 0; index < len(calls); index += 3 {
		if calls[index].args[1] != "remove" || calls[index+1].args[1] != "add" {
			t.Fatalf("unexpected sequence: %#v", calls)
		}
	}
}

func TestConnectReportsMissingCLI(t *testing.T) {
	manager := testManager(t, &fakeRunner{})
	for _, kind := range []agentops.ClientKind{agentops.ClientKindClaude, agentops.ClientKindCodex} {
		if err := manager.Connect(kind, spec("/tmp/token")); !errors.Is(err, ErrAgentNotFound) {
			t.Fatalf("Connect(%s) error = %v, want ErrAgentNotFound", kind, err)
		}
		if manager.SkillInstalled(kind) {
			t.Fatalf("skill(%s) must not be installed", kind)
		}
	}
}

func TestConnectFailsWhenCLIAddFails(t *testing.T) {
	manager, runner := cliManager(t)
	runner.addErr = errors.New("add failed")
	if err := manager.Connect(agentops.ClientKindClaude, spec("/tmp/token")); err == nil {
		t.Fatal("add failure must be reported")
	}
	if manager.SkillInstalled(agentops.ClientKindClaude) {
		t.Fatal("skill must not be installed when config writing failed")
	}
}

func TestValidateRejectsUnsafeFullCommand(t *testing.T) {
	runner := &fakeRunner{paths: map[string]string{"claude": `C:\Tools&Co\claude.cmd`}}
	manager := testManager(t, runner)
	if err := manager.Validate(agentops.ClientKindClaude, spec(`C:\data\claude.token`)); !errors.Is(err, ErrUnsafeCommand) {
		t.Fatalf("install path with & should fail preflight, err = %v", err)
	}

	runner = &fakeRunner{paths: map[string]string{"claude": `C:\Tools\claude.cmd`}}
	manager = testManager(t, runner)
	if err := manager.Validate(agentops.ClientKindClaude, spec(`C:\data%20\claude.token`)); !errors.Is(err, ErrUnsafeCommand) {
		t.Fatalf("data path with %% should fail preflight, err = %v", err)
	}
	if err := manager.Validate(agentops.ClientKindClaude, spec(`C:\data\claude.token`)); err != nil {
		t.Fatalf("safe command should pass: %v", err)
	}
}

func TestRemoveConfigPreflightDoesNotRunUnsafeCommand(t *testing.T) {
	runner := &fakeRunner{paths: map[string]string{"claude": `C:\Tools&Co\claude.cmd`}}
	manager := testManager(t, runner)
	if err := manager.RemoveConfig(agentops.ClientKindClaude); !errors.Is(err, ErrUnsafeCommand) {
		t.Fatalf("unsafe remove preflight error = %v", err)
	}
	if calls := runner.calls(); len(calls) != 0 {
		t.Fatalf("unsafe remove ran the CLI: %#v", calls)
	}
}

func TestConnectTimesOutAndReleasesTheCall(t *testing.T) {
	manager, runner := cliManager(t)
	runner.blockOnAdd = true
	manager.CommandTimeout = 50 * time.Millisecond
	start := time.Now()
	err := manager.Connect(agentops.ClientKindClaude, spec("/tmp/token"))
	if err == nil {
		t.Fatal("blocked CLI must fail")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("timeout took too long: %s", elapsed)
	}
}

func TestTokenFileAndRecordArePersisted(t *testing.T) {
	manager, _ := cliManager(t)
	path, err := manager.WriteToken(agentops.ClientKindClaude, "secret-token")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(raw)) != "secret-token" {
		t.Fatalf("token file = %q", raw)
	}
	if err := securefile.Verify(path); err != nil {
		t.Fatalf("token file is not owner-only: %v", err)
	}

	record := IntegrationRecord{Kind: string(agentops.ClientKindClaude), ClientID: "client-1", TokenFile: path, ConnectedAt: time.Now().UTC()}
	if err := manager.SaveRecord(record); err != nil {
		t.Fatal(err)
	}
	found, present, err := manager.Record(agentops.ClientKindClaude)
	if err != nil || !present || found.ClientID != "client-1" {
		t.Fatalf("record = %#v present=%v err=%v", found, present, err)
	}
	if !manager.TokenFilePresent(path) {
		t.Fatal("token file should be present")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if manager.TokenFilePresent(path) {
		t.Fatal("missing token file must not be reported present")
	}
	if err := manager.DeleteRecord(agentops.ClientKindClaude); err != nil {
		t.Fatal(err)
	}
	if _, present, _ := manager.Record(agentops.ClientKindClaude); present {
		t.Fatal("record was not deleted")
	}
	if err := manager.DeleteToken(agentops.ClientKindClaude); err != nil {
		t.Fatalf("deleting a missing token must succeed: %v", err)
	}
}

func TestTokenPermissionsSetBeforeBytesWritten(t *testing.T) {
	manager, _ := cliManager(t)
	var stages []string
	var secureSize int64 = -1
	var securePerm os.FileMode
	var written string
	previous := tokenWriteStage
	tokenWriteStage = func(stage, path string) {
		stages = append(stages, stage)
		switch stage {
		case "secure":
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			secureSize = info.Size()
			securePerm = info.Mode().Perm()
		case "write":
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			written = string(raw)
		}
	}
	t.Cleanup(func() { tokenWriteStage = previous })

	if _, err := manager.WriteToken(agentops.ClientKindClaude, "secret-token"); err != nil {
		t.Fatal(err)
	}
	if strings.Join(stages, ",") != "secure,write,rename" {
		t.Fatalf("stages = %v", stages)
	}
	if secureSize != 0 {
		t.Fatalf("permissions were set after %d bytes were written", secureSize)
	}
	if runtime.GOOS != "windows" && securePerm != 0o600 {
		t.Fatalf("temporary file permissions = %o before write", securePerm)
	}
	if written != "secret-token" {
		t.Fatalf("bytes at write stage = %q", written)
	}
}

func TestSaveRecordRecoversCorruptState(t *testing.T) {
	manager, _ := cliManager(t)
	if err := os.MkdirAll(manager.stateDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manager.statePath(), []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	record := IntegrationRecord{Kind: string(agentops.ClientKindClaude), ClientID: "client-1", TokenFile: "/tmp/token", ConnectedAt: time.Now().UTC()}
	if err := manager.SaveRecord(record); err != nil {
		t.Fatalf("save should replace corrupt state: %v", err)
	}
	if found, present, err := manager.Record(agentops.ClientKindClaude); err != nil || !present || found.ClientID != "client-1" {
		t.Fatalf("record = %#v present=%v err=%v", found, present, err)
	}
}

func TestConnectDoesNotOverwriteUserOwnedSkillDirectory(t *testing.T) {
	manager, _ := cliManager(t)
	target := filepath.Join(manager.Home, ".claude", "skills", SkillName)
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	own := filepath.Join(target, "SKILL.md")
	if err := os.WriteFile(own, []byte("user skill"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := manager.Connect(agentops.ClientKindClaude, spec("/tmp/token")); err != nil {
		t.Fatalf("connect must still succeed: %v", err)
	}
	raw, err := os.ReadFile(own)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "user skill" {
		t.Fatalf("user skill was overwritten: %q", raw)
	}
	if manager.SkillInstalled(agentops.ClientKindClaude) {
		t.Fatal("unmanaged directory must not be reported as installed")
	}
	if err := manager.RemoveSkill(agentops.ClientKindClaude); err != nil {
		t.Fatalf("RemoveSkill() error = %v", err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal("must not delete a user-owned skill directory")
	}
}

func TestConnectDoesNotFollowSymlinkedSkillDirectory(t *testing.T) {
	manager, _ := cliManager(t)
	realDir := filepath.Join(t.TempDir(), "real")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	realSkill := filepath.Join(realDir, "SKILL.md")
	if err := os.WriteFile(realSkill, []byte("real skill"), 0o644); err != nil {
		t.Fatal(err)
	}
	skillsDir := filepath.Join(manager.Home, ".claude", "skills")
	if err := os.MkdirAll(skillsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(skillsDir, SkillName)
	if err := os.Symlink(realDir, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := manager.Connect(agentops.ClientKindClaude, spec("/tmp/token")); err != nil {
		t.Fatalf("connect must still succeed: %v", err)
	}
	if string(mustRead(t, realSkill)) != "real skill" {
		t.Fatal("symlink target was overwritten")
	}
	if _, err := os.Lstat(link); err != nil {
		t.Fatal("symlink should be left in place")
	}
	if manager.SkillInstalled(agentops.ClientKindClaude) {
		t.Fatal("symlinked directory must not be reported as installed")
	}
	if err := manager.RemoveSkill(agentops.ClientKindClaude); err != nil {
		t.Fatalf("RemoveSkill() error = %v", err)
	}
	if _, err := os.Lstat(link); err != nil {
		t.Fatal("must not delete the user's symlink")
	}
	if string(mustRead(t, realSkill)) != "real skill" {
		t.Fatal("must not modify the symlink target")
	}
}

func TestConnectDoesNotFollowSymlinkedSkillFile(t *testing.T) {
	manager, _ := cliManager(t)
	if err := manager.Connect(agentops.ClientKindClaude, spec("/tmp/token")); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(manager.Home, ".claude", "skills", SkillName, "SKILL.md")
	realFile := filepath.Join(t.TempDir(), "real.md")
	if err := os.WriteFile(realFile, []byte("real skill"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realFile, target); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := manager.Connect(agentops.ClientKindClaude, spec("/tmp/token")); err != nil {
		t.Fatalf("connect must still succeed: %v", err)
	}
	if string(mustRead(t, realFile)) != "real skill" {
		t.Fatal("symlinked SKILL.md target was overwritten")
	}
	if manager.SkillInstalled(agentops.ClientKindClaude) {
		t.Fatal("symlinked SKILL.md must not be reported as installed")
	}
}

func TestRemoveSkillRemovesOnlyManagedSkill(t *testing.T) {
	manager, _ := cliManager(t)
	if err := manager.Connect(agentops.ClientKindClaude, spec("/tmp/token")); err != nil {
		t.Fatal(err)
	}
	if !manager.SkillInstalled(agentops.ClientKindClaude) {
		t.Fatal("skill should be installed")
	}
	if err := manager.RemoveSkill(agentops.ClientKindClaude); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(manager.Home, ".claude", "skills", SkillName)); !os.IsNotExist(err) {
		t.Fatalf("managed skill directory should be removed, err = %v", err)
	}
}

func TestIntegrationOriginDoesNotDependOnLabel(t *testing.T) {
	if !IsIntegrationOrigin(agentops.ClientKindClaude, "one-click:claude") {
		t.Fatal("reserved origin should match")
	}
	if IsIntegrationOrigin(agentops.ClientKindClaude, "") {
		t.Fatal("legacy registrations must stay manual")
	}
	if IsIntegrationOrigin(agentops.ClientKindClaude, "one-click:codex") {
		t.Fatal("origin must match the kind")
	}
}

func TestWindowsBatchCommandLineQuotesAndRejectsUnsafeCharacters(t *testing.T) {
	line, err := windowsBatchCommandLine(`C:\Windows\System32\cmd.exe`, `C:\Users\A B\claude.cmd`, []string{"mcp", "add", "qisitv", "--", `C:\Program Files\qisiTV\cli\qisitv.exe`, "mcp", "serve"})
	if err != nil {
		t.Fatal(err)
	}
	want := `"C:\Windows\System32\cmd.exe" /d /s /c ""C:\Users\A B\claude.cmd" "mcp" "add" "qisitv" "--" "C:\Program Files\qisiTV\cli\qisitv.exe" "mcp" "serve""`
	if line != want {
		t.Fatalf("line = %s\nwant = %s", line, want)
	}

	for _, token := range []string{"100%", "a&b", "a|b", "a<b", "a>b", "a^b", "a!b", `a"b`, "a\rb", "a\nb"} {
		if _, err := windowsBatchCommandLine("cmd.exe", "claude.cmd", []string{token}); !errors.Is(err, ErrUnsafeCommand) {
			t.Fatalf("token %q should be rejected, err = %v", token, err)
		}
	}

	line, err = windowsBatchCommandLine("cmd.exe", `C:\tools\claude.cmd`, []string{`C:\tmp\`})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(line, `"C:\tmp\\""`) {
		t.Fatalf("trailing backslashes were not doubled: %s", line)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestTokenPermissionsAreVerified(t *testing.T) {
	manager, _ := cliManager(t)
	path, err := manager.WriteToken(agentops.ClientKindClaude, "secret-token")
	if err != nil {
		t.Fatal(err)
	}
	if err := securefile.Verify(path); err != nil {
		t.Fatalf("owner-only token should pass: %v", err)
	}
	loosenTokenPermissions(t, path)
	if err := securefile.Verify(path); err == nil {
		t.Fatal("token readable by others must be rejected")
	}
}

type fakeRegistry struct {
	mu      sync.Mutex
	items   []agentops.ClientRegistration
	revoked []string
	fail    map[string]bool
}

func (f *fakeRegistry) List() []agentops.ClientRegistration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]agentops.ClientRegistration(nil), f.items...)
}

func (f *fakeRegistry) ListLive() ([]agentops.ClientRegistration, error) {
	return f.List(), nil
}

func (f *fakeRegistry) Revoke(clientID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail[clientID] {
		return errors.New("revoke failed")
	}
	live := f.items[:0]
	for _, item := range f.items {
		if item.ID != clientID {
			live = append(live, item)
		}
	}
	f.items = live
	f.revoked = append(f.revoked, clientID)
	return nil
}

func TestRetryStaleOneClickCredentialsKeepsCurrent(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewDefault(dataDir)
	if err := manager.SaveRecord(IntegrationRecord{
		Kind: string(agentops.ClientKindClaude), ClientID: "current",
		TokenFile: manager.TokenPath(agentops.ClientKindClaude), ConnectedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	registry := &fakeRegistry{items: []agentops.ClientRegistration{
		{ID: "current", Kind: agentops.ClientKindClaude, Origin: "one-click:claude"},
		{ID: "stale", Kind: agentops.ClientKindClaude, Origin: "one-click:claude"},
		{ID: "manual", Kind: agentops.ClientKindClaude, Origin: ""},
		{ID: "codex-stale", Kind: agentops.ClientKindCodex, Origin: "one-click:codex"},
	}}
	if err := RetryStaleOneClickCredentials(registry, dataDir); err != nil {
		t.Fatal(err)
	}
	remaining := map[string]bool{}
	for _, item := range registry.List() {
		remaining[item.ID] = true
	}
	if !remaining["current"] {
		t.Fatal("current credential must not be revoked")
	}
	if remaining["stale"] || remaining["codex-stale"] {
		t.Fatalf("stale credentials survived: %+v", registry.List())
	}
	if !remaining["manual"] {
		t.Fatal("manual credential must not be revoked")
	}
}

func TestRetryStaleOneClickCredentialsSkipsCorruptState(t *testing.T) {
	dataDir := t.TempDir()
	manager := NewDefault(dataDir)
	if err := os.MkdirAll(manager.stateDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manager.statePath(), []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	registry := &fakeRegistry{items: []agentops.ClientRegistration{
		{ID: "client-1", Kind: agentops.ClientKindClaude, Origin: "one-click:claude"},
	}}
	if err := RetryStaleOneClickCredentials(registry, dataDir); err != nil {
		t.Fatal(err)
	}
	if len(registry.List()) != 1 {
		t.Fatal("unreadable record must not trigger automatic revocation")
	}
}

func TestEmbeddedCanvasSkillMatchesCanonicalPluginSource(t *testing.T) {
	canonical, err := os.ReadFile(filepath.Join("..", "..", "..", "plugins", "qisitv-skills", "skills", SkillName, "SKILL.md"))
	if err != nil {
		t.Fatalf("read canonical skill: %v", err)
	}
	if string(canonical) != string(canvasSkill) {
		t.Fatal("embedded skill is stale; run scripts/sync-agent-skill.mjs")
	}
	if !strings.HasPrefix(string(canvasSkill), "---\nname: "+SkillName+"\n") {
		t.Fatal("skill frontmatter is missing or has the wrong name")
	}
}
