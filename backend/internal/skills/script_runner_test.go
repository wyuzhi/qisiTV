package skills

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
)

func TestSkillScriptInterpreterAndMissingInterpreterErrors(t *testing.T) {
	cases := []struct {
		path string
		isSc bool
		kind string
		supp bool
	}{
		{"scripts/analyze.py", true, "python3", true},
		{"script/analyze.py", true, "python3", true},
		{"scripts/build.sh", true, "bash", true},
		{"script/build.bash", true, "bash", true},
		{"scripts/tool.js", true, "node", true},
		{"scripts/tool.mjs", true, "node", true},
		{"script/tool.cjs", true, "node", true},
		{"scripts/legacy.rb", true, "", false},
		{"scripts/", false, "", false},
		{"script/", false, "", false},
		{"references/guide.py", false, "", false},
		{"../scripts/evil.py", false, "", false},
		{"/scripts/evil.py", false, "", false},
	}
	for _, tc := range cases {
		if got := IsSkillScriptPath(tc.path); got != tc.isSc {
			t.Fatalf("IsSkillScriptPath(%q)=%v, want %v", tc.path, got, tc.isSc)
		}
		kind, ok := SkillScriptInterpreter(tc.path)
		if kind != tc.kind || ok != tc.supp {
			t.Fatalf("SkillScriptInterpreter(%q)=(%q,%v), want (%q,%v)", tc.path, kind, ok, tc.kind, tc.supp)
		}
	}

	noneLookPath := func(string) (string, error) {
		return "", errors.New("not found")
	}
	for _, item := range []struct {
		kind    string
		goos    string
		wantSub string
	}{
		{"python3", "darwin", "Python 3"},
		{"python3", "windows", "Python 3"},
		{"bash", "darwin", "Bash"},
		{"bash", "windows", "Git for Windows"},
		{"node", "darwin", "Node.js"},
	} {
		_, _, err := resolveScriptInterpreterWithLookPath(item.kind, "", item.goos, noneLookPath)
		var appErr *kernel.AppError
		if !errors.As(err, &appErr) || appErr.Reason != "script_interpreter_missing" || !strings.Contains(appErr.Message, item.wantSub) {
			t.Fatalf("kind=%s goos=%s err=%+v, want script_interpreter_missing containing %q", item.kind, item.goos, err, item.wantSub)
		}
	}

	// Windows py -3 fallback
	winCmd, winPrefix, err := resolveScriptInterpreterWithLookPath("python3", "", "windows", func(bin string) (string, error) {
		if bin == "py" {
			return `C:\Windows\py.exe`, nil
		}
		return "", errors.New("missing")
	})
	if err != nil || winCmd != `C:\Windows\py.exe` || len(winPrefix) != 1 || winPrefix[0] != "-3" {
		t.Fatalf("unexpected windows py fallback: cmd=%q prefix=%v err=%v", winCmd, winPrefix, err)
	}
}

func TestSkillScriptPathContainmentAndSymlinkRejection(t *testing.T) {
	s, _ := agentSkillFixture(t)
	pin := installAgentSkill(t, s, map[string]string{
		"SKILL.md":            "---\nname: 脚本测试\ndescription: 测试路径隔离\n---\n按需运行脚本",
		"scripts/ok.js":       "console.log('ok')",
		"references/note.txt": "hello",
	})
	for _, badPath := range []string{
		"../SKILL.md",
		"scripts/../SKILL.md",
		"/etc/passwd",
		"SKILL.md",
		"references/note.txt",
		"scripts/missing.js",
		"scripts\\ok.js",
	} {
		_, err := s.ValidateScriptRun("owner", ScriptRunRequest{
			CanvasID:   "canvas-1",
			Pin:        pin,
			ScriptPath: badPath,
		}, "")
		if err == nil {
			t.Fatalf("expected error for invalid script path %q", badPath)
		}
	}

	// Tamper the installed zip on disk to inject a symlink entry; extraction must reject it.
	tamperedPin := installAgentSkill(t, s, map[string]string{
		"SKILL.md":       "---\nname: 篡改测试\ndescription: 测试软链接拒绝\n---\n说明",
		"scripts/run.js": "console.log('hi')",
	})
	zipPath := filepath.Join(s.dataDir, "skill-packages", tamperedPin.SkillID, tamperedPin.VersionID+".zip")
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	hdr := &zip.FileHeader{Name: "scripts/run.js", Method: zip.Deflate}
	hdr.SetMode(os.ModeSymlink | 0o777)
	w, err := zw.CreateHeader(hdr)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte("/etc/passwd"))
	_ = zw.Close()
	if err := os.WriteFile(zipPath, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ExecuteSkillScript(context.Background(), "owner", ScriptRunRequest{
		CanvasID:   "canvas-1",
		Pin:        tamperedPin,
		ScriptPath: "scripts/run.js",
	}, ""); err == nil {
		t.Fatal("expected symlink zip entry to be rejected")
	}
}

func TestSkillScriptExecutionIsolationEnvScrubbingOutputCapTimeoutAndCancel(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not on PATH")
	}
	s, _ := agentSkillFixture(t)
	scriptSrc := `
const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const mode = process.argv[2] || 'normal';
  if (mode === 'mutate') {
    fs.writeFileSync('SKILL.md', 'MUTATED_SKILL');
    fs.writeFileSync('scripts/run.js', 'MUTATED_SCRIPT');
    console.log(fs.readFileSync('references/data.txt', 'utf8').trim() + '|' + input.trim());
    if (process.env.BEEFTV_OUTPUT_DIR) {
      fs.writeFileSync(path.join(process.env.BEEFTV_OUTPUT_DIR, 'out.json'), '{"ok":true}');
    }
    return;
  }
  if (mode === 'env') {
    const leaked = Object.keys(process.env).filter(k =>
      k.startsWith('BEEFTV_AGENT_') || k.startsWith('OPENAI_') || k.startsWith('ANTHROPIC_') || k === 'SECRET_TEST_TOKEN'
    );
    console.log(JSON.stringify({ leaked, home: process.env.HOME, tmp: process.env.TMPDIR }));
    return;
  }
  if (mode === 'flood') {
    process.stdout.write('A'.repeat(80 * 1024));
    process.stderr.write('B'.repeat(70 * 1024));
    return;
  }
  if (mode === 'sleep') {
    setTimeout(() => console.log('done'), 10000);
    return;
  }
});
`
	pin := installAgentSkill(t, s, map[string]string{
		"SKILL.md":            "---\nname: 隔离执行\ndescription: 验证隔离沙箱\n---\n原始内容",
		"scripts/run.js":      scriptSrc,
		"references/data.txt": "REF_OK",
	})

	// 1. Temp dir isolation + argv + stdin + output files
	res1, err := s.ExecuteSkillScript(context.Background(), "owner", ScriptRunRequest{
		CanvasID:              "canvas-iso",
		ProposalID:            "sp-iso1",
		Pin:                   pin,
		ScriptPath:            "scripts/run.js",
		Args:                  []string{"mutate"},
		Stdin:                 "STDIN_OK\n",
		UseWorkspaceOutputDir: true,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if res1.ExitCode != 0 || strings.TrimSpace(res1.Stdout) != "REF_OK|STDIN_OK" {
		t.Fatalf("unexpected run1 result: %+v", res1)
	}
	if len(res1.OutputFiles) != 1 || res1.OutputFiles[0].Path != "out.json" {
		t.Fatalf("expected workspace output file out.json, got %+v", res1.OutputFiles)
	}
	// Run a second time: installed package must be untouched despite first run overwriting SKILL.md and scripts/run.js
	res2, err := s.ExecuteSkillScript(context.Background(), "owner", ScriptRunRequest{
		CanvasID:   "canvas-iso",
		Pin:        pin,
		ScriptPath: "scripts/run.js",
		Args:       []string{"mutate"},
		Stdin:      "SECOND_OK\n",
	}, "")
	if err != nil || res2.ExitCode != 0 || strings.TrimSpace(res2.Stdout) != "REF_OK|SECOND_OK" {
		t.Fatalf("installed skill package was mutated or second run failed: %+v err=%v", res2, err)
	}

	// 2. Environment scrubbing
	t.Setenv("BEEFTV_AGENT_API_KEY", "super-secret-agent-key")
	t.Setenv("BEEFTV_AGENT_HOST_TOKEN", "super-secret-host-token")
	t.Setenv("OPENAI_API_KEY", "sk-openai-secret")
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-secret")
	t.Setenv("SECRET_TEST_TOKEN", "top-secret")
	envRes, err := s.ExecuteSkillScript(context.Background(), "owner", ScriptRunRequest{
		CanvasID:   "canvas-iso",
		Pin:        pin,
		ScriptPath: "scripts/run.js",
		Args:       []string{"env"},
	}, "")
	if err != nil || envRes.ExitCode != 0 {
		t.Fatalf("env check failed: %+v err=%v", envRes, err)
	}
	if !strings.Contains(envRes.Stdout, `"leaked":[]`) || strings.Contains(envRes.Stdout, "super-secret") || strings.Contains(envRes.Stdout, "sk-") {
		t.Fatalf("secrets leaked to script env: %s", envRes.Stdout)
	}

	// 3. Output caps (64 KiB stdout & stderr)
	floodRes, err := s.ExecuteSkillScript(context.Background(), "owner", ScriptRunRequest{
		CanvasID:   "canvas-iso",
		Pin:        pin,
		ScriptPath: "scripts/run.js",
		Args:       []string{"flood"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !floodRes.StdoutTruncated || !floodRes.StderrTruncated || !strings.Contains(floodRes.Stdout, "输出已截断") || !strings.Contains(floodRes.Stderr, "输出已截断") {
		t.Fatalf("expected stdout and stderr truncation, got stdoutLen=%d stderrLen=%d trunc=(%v,%v)",
			len(floodRes.Stdout), len(floodRes.Stderr), floodRes.StdoutTruncated, floodRes.StderrTruncated)
	}

	// 4. Timeout enforcement
	timeoutRes, err := s.ExecuteSkillScript(context.Background(), "owner", ScriptRunRequest{
		CanvasID:   "canvas-iso",
		Pin:        pin,
		ScriptPath: "scripts/run.js",
		Args:       []string{"sleep"},
		TimeoutSec: 1,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !timeoutRes.TimedOut || timeoutRes.Cancelled {
		t.Fatalf("expected TimedOut=true Cancelled=false, got %+v", timeoutRes)
	}

	// 5. Cancellation via CancelScriptRuns
	doneCh := make(chan *ScriptRunResult, 1)
	go func() {
		r, _ := s.ExecuteSkillScript(context.Background(), "owner", ScriptRunRequest{
			CanvasID:   "canvas-cancel",
			SessionID:  "durable:11111111-1111-1111-1111-111111111111",
			TurnID:     "turn-cancel",
			Pin:        pin,
			ScriptPath: "scripts/run.js",
			Args:       []string{"sleep"},
			TimeoutSec: 30,
		}, "")
		doneCh <- r
	}()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if s.CancelScriptRuns("canvas-cancel", "durable:11111111-1111-1111-1111-111111111111", "") > 0 {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	cancelRes := <-doneCh
	if cancelRes == nil || !cancelRes.Cancelled {
		t.Fatalf("expected Cancelled=true after CancelScriptRuns, got %+v", cancelRes)
	}
}
