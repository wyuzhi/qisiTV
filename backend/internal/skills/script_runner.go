package skills

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"qisitv/backend/internal/assistantruntime"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
)

const (
	DefaultScriptTimeoutSec = 300
	MaxScriptTimeoutSec     = 1800
	MaxScriptArgs           = 64
	MaxScriptArgBytes       = 4096
	MaxScriptStdinBytes     = 64 * 1024
	MaxScriptOutputBytes    = 64 * 1024
	ScriptOutputTruncNotice = "\n...[输出已截断，仅保留前 64 KiB]"
)

type ScriptRunRequest struct {
	CanvasID              string   `json:"canvasId"`
	SessionID             string   `json:"sessionId,omitempty"`
	TurnID                string   `json:"turnId,omitempty"`
	ProposalID            string   `json:"proposalId,omitempty"`
	Pin                   Pin      `json:"pin"`
	ScriptPath            string   `json:"scriptPath"`
	Args                  []string `json:"args,omitempty"`
	Stdin                 string   `json:"stdin,omitempty"`
	TimeoutSec            int      `json:"timeoutSec,omitempty"`
	UseWorkspaceOutputDir bool     `json:"useWorkspaceOutputDir,omitempty"`
	Note                  string   `json:"note,omitempty"`
}

type ValidatedScriptRun struct {
	Pin             Pin
	SkillName       string
	VersionLabel    string
	Version         *model.SkillVersion
	Files           []model.SkillFile
	ScriptPath      string
	Interpreter     string
	InterpreterPath string
	PrefixArgs      []string
	Args            []string
	Stdin           string
	StdinPreview    string
	HasStdin        bool
	TimeoutSec      int
	UseOutputDir    bool
	Note            string
}

type ScriptOutputFile struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

type ScriptRunResult struct {
	ExitCode        int                `json:"exitCode"`
	TimedOut        bool               `json:"timedOut"`
	Cancelled       bool               `json:"cancelled"`
	DurationMs      int64              `json:"durationMs"`
	Stdout          string             `json:"stdout"`
	Stderr          string             `json:"stderr"`
	StdoutTruncated bool               `json:"stdoutTruncated,omitempty"`
	StderrTruncated bool               `json:"stderrTruncated,omitempty"`
	OutputFiles     []ScriptOutputFile `json:"outputFiles,omitempty"`
}

type activeScriptRun struct {
	canvasID  string
	sessionID string
	turnID    string
	cancel    context.CancelFunc
}

type scriptRuntimeState struct {
	mu       sync.Mutex
	nextID   uint64
	runs     map[uint64]activeScriptRun
	lookPath func(string) (string, error)
}

func newScriptRuntimeState() *scriptRuntimeState {
	return &scriptRuntimeState{
		runs:     make(map[uint64]activeScriptRun),
		lookPath: exec.LookPath,
	}
}

// WithScriptLookPath overrides executable lookup in tests.
func (s *Service) WithScriptLookPath(fn func(string) (string, error)) *Service {
	clone := *s
	state := newScriptRuntimeState()
	if fn != nil {
		state.lookPath = fn
	}
	clone.scriptState = state
	return &clone
}

func BundledNodePath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return assistantruntime.BundledConfig(exe, runtime.GOOS).HostCommand
}

func ResolveScriptInterpreter(kind, bundledNodePath, goos string) (string, []string, error) {
	return resolveScriptInterpreterWithLookPath(kind, bundledNodePath, goos, exec.LookPath)
}

func resolveScriptInterpreterWithLookPath(kind, bundledNodePath, goos string, lookPath func(string) (string, error)) (string, []string, error) {
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	switch kind {
	case "python3":
		if goos != "windows" {
			if resolved, err := lookPath("python3"); err == nil && strings.TrimSpace(resolved) != "" {
				return resolved, nil, nil
			}
		} else {
			for _, candidate := range []string{"python3", "python"} {
				if resolved, err := lookPath(candidate); err == nil && !isWindowsStorePythonStub(resolved) {
					return resolved, nil, nil
				}
			}
			if resolved, err := lookPath("py"); err == nil && !isWindowsStorePythonStub(resolved) {
				return resolved, []string{"-3"}, nil
			}
		}
		return "", nil, &kernel.AppError{
			Status:  400,
			Code:    400,
			Reason:  "script_interpreter_missing",
			Message: "未检测到 Python 3 运行环境，无法运行此技能脚本。请先在电脑上安装 Python 3 并加入系统 PATH 后重试。",
		}
	case "bash":
		if resolved, err := lookPath("bash"); err == nil && strings.TrimSpace(resolved) != "" {
			return resolved, nil, nil
		}
		msg := "未检测到 Bash 运行环境，无法运行此技能脚本。请先在系统中安装 bash 后重试。"
		if goos == "windows" {
			msg = "未检测到 Bash 运行环境，无法运行 .sh 脚本。请先安装 Git for Windows（Git Bash）或 WSL 并加入系统 PATH 后重试。"
		}
		return "", nil, &kernel.AppError{Status: 400, Code: 400, Reason: "script_interpreter_missing", Message: msg}
	case "node":
		if trimmed := strings.TrimSpace(bundledNodePath); trimmed != "" {
			if info, err := os.Stat(trimmed); err == nil && !info.IsDir() {
				return trimmed, nil, nil
			}
		}
		if resolved, err := lookPath("node"); err == nil && strings.TrimSpace(resolved) != "" {
			return resolved, nil, nil
		}
		return "", nil, &kernel.AppError{
			Status:  400,
			Code:    400,
			Reason:  "script_interpreter_missing",
			Message: "未检测到 Node.js 运行环境，无法运行此技能脚本。请重新安装完整客户端或在系统中安装 Node.js 后重试。",
		}
	default:
		return "", nil, &kernel.AppError{
			Status:  400,
			Code:    400,
			Reason:  "script_interpreter_unsupported",
			Message: "不支持运行该类型的脚本文件（仅支持 .py、.sh、.bash、.js、.mjs、.cjs）。",
		}
	}
}

func isWindowsStorePythonStub(resolved string) bool {
	trimmed := strings.TrimSpace(resolved)
	if trimmed == "" {
		return true
	}
	lower := strings.ToLower(filepath.ToSlash(trimmed))
	if strings.Contains(lower, "/microsoft/windowsapps/") {
		if info, err := os.Stat(trimmed); err == nil && info.Size() == 0 {
			return true
		}
	}
	return false
}

func (s *Service) ValidateScriptRun(userID string, req ScriptRunRequest, bundledNodePath string) (*ValidatedScriptRun, error) {
	pin := req.Pin.Identity()
	skill, version, files, err := s.agentPackage(userID, pin)
	if err != nil {
		return nil, err
	}
	rawPath := strings.TrimSpace(req.ScriptPath)
	normPath, normErr := normalizeSkillPath(rawPath)
	if normErr != nil || normPath != rawPath || !IsSkillScriptPath(normPath) {
		return nil, &kernel.AppError{Status: 400, Code: 400, Reason: "invalid_script_path", Message: "技能脚本路径必须位于包内 scripts/ 或 script/ 目录下"}
	}
	foundFile := false
	for _, f := range files {
		if f.Path == normPath {
			foundFile = true
			break
		}
	}
	if !foundFile {
		return nil, &kernel.AppError{Status: 400, Code: 400, Reason: "script_not_found", Message: "这个脚本文件不在所选技能版本中"}
	}
	interpKind, supported := SkillScriptInterpreter(normPath)
	if !supported {
		return nil, &kernel.AppError{
			Status:  400,
			Code:    400,
			Reason:  "script_interpreter_unsupported",
			Message: "不支持运行该类型的脚本文件（仅支持 .py、.sh、.bash、.js、.mjs、.cjs）。",
		}
	}
	if len(req.Args) > MaxScriptArgs {
		return nil, &kernel.AppError{Status: 400, Code: 400, Reason: "invalid_script_args", Message: "脚本参数数量不能超过 64 个"}
	}
	totalArgBytes := 0
	cleanArgs := make([]string, len(req.Args))
	for i, arg := range req.Args {
		if len(arg) > MaxScriptArgBytes || strings.ContainsRune(arg, 0) {
			return nil, &kernel.AppError{Status: 400, Code: 400, Reason: "invalid_script_args", Message: "脚本参数长度超过限制或包含非法字符"}
		}
		totalArgBytes += len(arg)
		if totalArgBytes > MaxScriptStdinBytes {
			return nil, &kernel.AppError{Status: 400, Code: 400, Reason: "invalid_script_args", Message: "脚本参数总长度不能超过 64 KiB"}
		}
		cleanArgs[i] = arg
	}
	if len(req.Stdin) > MaxScriptStdinBytes || strings.ContainsRune(req.Stdin, 0) {
		return nil, &kernel.AppError{Status: 400, Code: 400, Reason: "invalid_script_stdin", Message: "脚本标准输入不能超过 64 KiB"}
	}
	timeoutSec := req.TimeoutSec
	if timeoutSec <= 0 {
		timeoutSec = DefaultScriptTimeoutSec
	}
	if timeoutSec > MaxScriptTimeoutSec {
		return nil, &kernel.AppError{Status: 400, Code: 400, Reason: "invalid_script_timeout", Message: fmt.Sprintf("脚本超时时间必须在 1 到 %d 秒之间", MaxScriptTimeoutSec)}
	}
	lookPath := exec.LookPath
	if s.scriptState != nil && s.scriptState.lookPath != nil {
		lookPath = s.scriptState.lookPath
	}
	if bundledNodePath == "" {
		bundledNodePath = BundledNodePath()
	}
	cmdPath, prefixArgs, err := resolveScriptInterpreterWithLookPath(interpKind, bundledNodePath, runtime.GOOS, lookPath)
	if err != nil {
		return nil, err
	}
	stdinPreview := ""
	if req.Stdin != "" {
		stdinPreview = kernel.TruncateRunes(strings.TrimSpace(req.Stdin), 120)
	}
	return &ValidatedScriptRun{
		Pin:             pin,
		SkillName:       skill.Name,
		VersionLabel:    version.VersionLabel,
		Version:         version,
		Files:           files,
		ScriptPath:      normPath,
		Interpreter:     interpKind,
		InterpreterPath: cmdPath,
		PrefixArgs:      prefixArgs,
		Args:            cleanArgs,
		Stdin:           req.Stdin,
		StdinPreview:    stdinPreview,
		HasStdin:        req.Stdin != "",
		TimeoutSec:      timeoutSec,
		UseOutputDir:    req.UseWorkspaceOutputDir,
		Note:            kernel.TruncateRunes(strings.TrimSpace(req.Note), 500),
	}, nil
}

func (s *Service) ExecuteSkillScript(ctx context.Context, userID string, req ScriptRunRequest, bundledNodePath string) (*ScriptRunResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	validated, err := s.ValidateScriptRun(userID, req, bundledNodePath)
	if err != nil {
		return nil, err
	}
	tempDir, err := os.MkdirTemp("", "beeftv-skill-run-*")
	if err != nil {
		return nil, kernel.WrapAppError(500, "无法创建脚本隔离运行目录", err)
	}
	defer os.RemoveAll(tempDir)
	_ = os.Chmod(tempDir, 0o700)

	skillDir := filepath.Join(tempDir, "skill")
	homeDir := filepath.Join(tempDir, "home")
	tmpSubDir := filepath.Join(tempDir, "tmp")
	for _, dir := range []string{skillDir, homeDir, tmpSubDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, kernel.WrapAppError(500, "无法准备脚本隔离运行目录", err)
		}
	}
	if err := s.extractVerifiedSkillPackage(validated.Version, validated.Files, skillDir); err != nil {
		return nil, err
	}
	var outputDir string
	if validated.UseOutputDir && strings.TrimSpace(s.dataDir) != "" {
		runKey := sanitizePathSegment(req.ProposalID)
		if runKey == "" {
			var b [8]byte
			_, _ = rand.Read(b[:])
			runKey = "run-" + hex.EncodeToString(b[:])
		}
		canvasKey := sanitizePathSegment(req.CanvasID)
		if canvasKey == "" {
			canvasKey = "workspace"
		}
		outputDir = filepath.Join(s.dataDir, "workspace-outputs", canvasKey, runKey)
		if err := os.MkdirAll(outputDir, 0o700); err != nil {
			return nil, kernel.WrapAppError(500, "无法准备脚本输出目录", err)
		}
	}

	runCtx, cancelRun := context.WithCancel(ctx)
	runID := s.registerActiveScriptRun(req.CanvasID, req.SessionID, req.TurnID, cancelRun)
	defer func() {
		s.unregisterActiveScriptRun(runID)
		cancelRun()
	}()

	execCtx, cancelTimeout := context.WithTimeout(runCtx, time.Duration(validated.TimeoutSec)*time.Second)
	defer cancelTimeout()

	argv := make([]string, 0, len(validated.PrefixArgs)+1+len(validated.Args))
	argv = append(argv, validated.PrefixArgs...)
	argv = append(argv, filepath.FromSlash(validated.ScriptPath))
	argv = append(argv, validated.Args...)

	cmd := exec.CommandContext(execCtx, validated.InterpreterPath, argv...)
	cmd.Dir = skillDir
	cmd.Env = BuildCleanScriptEnv(homeDir, tmpSubDir, outputDir, bundledNodePath, runtime.GOOS)
	configureScriptProcess(cmd)
	if validated.Stdin != "" {
		cmd.Stdin = strings.NewReader(validated.Stdin)
	} else {
		cmd.Stdin = bytes.NewReader(nil)
	}
	stdoutBuf := &boundedScriptBuffer{max: MaxScriptOutputBytes}
	stderrBuf := &boundedScriptBuffer{max: MaxScriptOutputBytes}
	cmd.Stdout = stdoutBuf
	cmd.Stderr = stderrBuf

	started := time.Now()
	runErr := cmd.Run()
	durationMs := time.Since(started).Milliseconds()

	cancelled := runCtx.Err() != nil
	timedOut := !cancelled && errors.Is(execCtx.Err(), context.DeadlineExceeded)
	exitCode := 0
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}
	stdoutText := stdoutBuf.String()
	if stdoutBuf.truncated {
		stdoutText += ScriptOutputTruncNotice
	}
	stderrText := stderrBuf.String()
	if stderrBuf.truncated {
		stderrText += ScriptOutputTruncNotice
	}
	return &ScriptRunResult{
		ExitCode:        exitCode,
		TimedOut:        timedOut,
		Cancelled:       cancelled,
		DurationMs:      durationMs,
		Stdout:          stdoutText,
		Stderr:          stderrText,
		StdoutTruncated: stdoutBuf.truncated,
		StderrTruncated: stderrBuf.truncated,
		OutputFiles:     collectOutputFiles(outputDir),
	}, nil
}

func (s *Service) extractVerifiedSkillPackage(version *model.SkillVersion, files []model.SkillFile, destDir string) error {
	archivePath := filepath.Join(s.dataDir, "skill-packages", filepath.FromSlash(version.PackageKey))
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return kernel.WrapAppError(400, "所选技能版本文件不可读取，请重新安装或选择可用版本", err)
	}
	defer reader.Close()

	expected := make(map[string]model.SkillFile, len(files))
	for _, f := range files {
		expected[f.Path] = f
	}
	extracted := make(map[string]bool, len(files))
	var total int64
	cleanDest := filepath.Clean(destDir)
	for _, entry := range reader.File {
		if entry.FileInfo().IsDir() {
			continue
		}
		if entry.Mode()&os.ModeSymlink != 0 || !entry.Mode().IsRegular() {
			return kernel.BadAuthRequest("技能包不能包含软链接或特殊文件")
		}
		normPath, err := normalizeSkillPath(entry.Name)
		if err != nil || normPath != entry.Name {
			return kernel.BadAuthRequest("技能包文件路径无效")
		}
		meta, ok := expected[normPath]
		if !ok {
			return kernel.NewAppError(409, "技能包内容与登记清单不一致，请重新选择")
		}
		rc, err := entry.Open()
		if err != nil {
			return kernel.WrapAppError(400, "无法读取技能包文件", err)
		}
		data, readErr := io.ReadAll(io.LimitReader(rc, maxSkillPackageBytes-total+1))
		_ = rc.Close()
		if readErr != nil {
			return kernel.WrapAppError(400, "无法读取技能包文件", readErr)
		}
		total += int64(len(data))
		if total > maxSkillPackageBytes {
			return errSkillPackageTooLarge()
		}
		sum := sha256.Sum256(data)
		if int64(len(data)) != meta.Size || hex.EncodeToString(sum[:]) != meta.SHA256 {
			return kernel.NewAppError(409, "技能文件内容校验失败，请重新选择")
		}
		targetPath := filepath.Join(cleanDest, filepath.FromSlash(normPath))
		rel, relErr := filepath.Rel(cleanDest, targetPath)
		if relErr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return kernel.BadAuthRequest("技能文件路径越界")
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o700); err != nil {
			return kernel.WrapAppError(500, "无法创建技能脚本目录", err)
		}
		mode := os.FileMode(0o600)
		if IsSkillScriptPath(normPath) {
			mode = 0o700
		}
		if err := os.WriteFile(targetPath, data, mode); err != nil {
			return kernel.WrapAppError(500, "无法写入技能脚本文件", err)
		}
		extracted[normPath] = true
	}
	if len(extracted) != len(expected) {
		return kernel.NewAppError(409, "技能包文件缺失，请重新安装或选择可用版本")
	}
	return nil
}

func BuildCleanScriptEnv(homeDir, tmpDir, outputDir, bundledNodePath, goos string) []string {
	pathVal := os.Getenv("PATH")
	if trimmed := strings.TrimSpace(bundledNodePath); trimmed != "" {
		nodeDir := filepath.Dir(trimmed)
		if pathVal == "" {
			pathVal = nodeDir
		} else {
			pathVal = nodeDir + string(os.PathListSeparator) + pathVal
		}
	}
	lang := strings.TrimSpace(os.Getenv("LANG"))
	if lang == "" {
		lang = "en_US.UTF-8"
	}
	env := []string{
		"PATH=" + pathVal,
		"HOME=" + homeDir,
		"TMPDIR=" + tmpDir,
		"TEMP=" + tmpDir,
		"TMP=" + tmpDir,
		"LANG=" + lang,
		"PYTHONIOENCODING=utf-8",
		"PYTHONUTF8=1",
		"PYTHONDONTWRITEBYTECODE=1",
		"NO_COLOR=1",
		"TERM=dumb",
	}
	if lcAll := strings.TrimSpace(os.Getenv("LC_ALL")); lcAll != "" {
		env = append(env, "LC_ALL="+lcAll)
	}
	if goos == "windows" {
		for _, key := range []string{"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"} {
			if val := os.Getenv(key); val != "" {
				env = append(env, key+"="+val)
			}
		}
		appData := filepath.Join(homeDir, "AppData", "Roaming")
		localAppData := filepath.Join(homeDir, "AppData", "Local")
		_ = os.MkdirAll(appData, 0o700)
		_ = os.MkdirAll(localAppData, 0o700)
		env = append(env, "USERPROFILE="+homeDir, "APPDATA="+appData, "LOCALAPPDATA="+localAppData)
	}
	if strings.TrimSpace(outputDir) != "" {
		env = append(env, "BEEFTV_OUTPUT_DIR="+outputDir)
	}
	return env
}

func (s *Service) registerActiveScriptRun(canvasID, sessionID, turnID string, cancel context.CancelFunc) uint64 {
	if s == nil || s.scriptState == nil {
		return 0
	}
	s.scriptState.mu.Lock()
	defer s.scriptState.mu.Unlock()
	s.scriptState.nextID++
	id := s.scriptState.nextID
	s.scriptState.runs[id] = activeScriptRun{
		canvasID:  strings.TrimSpace(canvasID),
		sessionID: strings.TrimSpace(sessionID),
		turnID:    strings.TrimSpace(turnID),
		cancel:    cancel,
	}
	return id
}

func (s *Service) unregisterActiveScriptRun(id uint64) {
	if s == nil || s.scriptState == nil || id == 0 {
		return
	}
	s.scriptState.mu.Lock()
	defer s.scriptState.mu.Unlock()
	delete(s.scriptState.runs, id)
}

func (s *Service) CancelScriptRuns(canvasID, sessionID, turnID string) int {
	if s == nil || s.scriptState == nil {
		return 0
	}
	canvasID = strings.TrimSpace(canvasID)
	sessionID = strings.TrimSpace(sessionID)
	turnID = strings.TrimSpace(turnID)
	s.scriptState.mu.Lock()
	var cancels []context.CancelFunc
	for _, run := range s.scriptState.runs {
		if canvasID != "" && run.canvasID != canvasID {
			continue
		}
		if sessionID != "" && run.sessionID != "" && run.sessionID != sessionID {
			continue
		}
		if turnID != "" && run.turnID != turnID {
			continue
		}
		if run.cancel != nil {
			cancels = append(cancels, run.cancel)
		}
	}
	s.scriptState.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	return len(cancels)
}

type boundedScriptBuffer struct {
	buf       bytes.Buffer
	max       int
	truncated bool
}

func (b *boundedScriptBuffer) Write(p []byte) (int, error) {
	total := len(p)
	remaining := b.max - b.buf.Len()
	if remaining <= 0 {
		b.truncated = true
		return total, nil
	}
	if len(p) > remaining {
		_, _ = b.buf.Write(p[:remaining])
		b.truncated = true
		return total, nil
	}
	_, _ = b.buf.Write(p)
	return total, nil
}

func (b *boundedScriptBuffer) String() string {
	return strings.ToValidUTF8(b.buf.String(), "�")
}

func collectOutputFiles(outputDir string) []ScriptOutputFile {
	if strings.TrimSpace(outputDir) == "" {
		return nil
	}
	var out []ScriptOutputFile
	_ = filepath.WalkDir(outputDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		if len(out) >= 20 {
			return fs.SkipAll
		}
		rel, relErr := filepath.Rel(outputDir, p)
		if relErr != nil {
			return nil
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return nil
		}
		out = append(out, ScriptOutputFile{Path: filepath.ToSlash(rel), Size: info.Size()})
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

func sanitizePathSegment(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	var b strings.Builder
	for _, r := range trimmed {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
