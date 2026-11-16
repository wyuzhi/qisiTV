package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/diagnostics"
	"infinite-canvas/backend/internal/runtimeinfo"
)

type DesktopStartupState struct {
	State            string `json:"state"`
	Phase            string `json:"phase,omitempty"`
	Detail           string `json:"detail,omitempty"`
	DataDir          string `json:"dataDir,omitempty"`
	Reason           string `json:"reason,omitempty"`
	Error            string `json:"error,omitempty"`
	DiagnosticPath   string `json:"diagnosticPath,omitempty"`
	BaseURL          string `json:"baseURL,omitempty"`
	LaunchToken      string `json:"launchToken,omitempty"`
	UIBootstrapToken string `json:"uiBootstrapToken,omitempty"`
}

type desktopBootAttempt struct {
	state               DesktopStartupState
	rawErr              error
	launchID            string
	running             bool
	wait                chan struct{}
	attemptAcquiredLock bool
	transient           *diagnostics.BootLogEntry
}

func (a *DesktopApp) StartupState() DesktopStartupState {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if rt := a.runtime(); rt != nil {
		return DesktopStartupState{
			State:            "ready",
			Phase:            "ready",
			Detail:           "本地工作区已就绪",
			DataDir:          a.dataDir,
			BaseURL:          rt.BaseURL(),
			LaunchToken:      rt.LaunchToken(),
			UIBootstrapToken: rt.UIBootstrapToken(),
		}
	}
	if a.boot.state.State != "" {
		state := a.boot.state
		if state.DataDir == "" {
			state.DataDir = a.dataDir
		}
		return state
	}
	return DesktopStartupState{State: "idle", DataDir: a.dataDir}
}

func (a *DesktopApp) RetryStartup() DesktopStartupState {
	a.mu.Lock()
	if a.runtime() != nil || a.boot.running || a.closing || a.migrating {
		a.mu.Unlock()
		return a.StartupState()
	}
	a.boot = desktopBootAttempt{
		state: DesktopStartupState{State: "idle", DataDir: a.dataDir},
	}
	a.mu.Unlock()
	return a.ensureBootStarted()
}

func (a *DesktopApp) ensureBootStarted() DesktopStartupState {
	a.mu.Lock()
	if a.runtime() != nil || a.boot.running || a.closing || a.migrating || (a.boot.state.State != "" && a.boot.state.State != "idle") {
		a.mu.Unlock()
		return a.StartupState()
	}
	a.boot = desktopBootAttempt{
		launchID: newDesktopBootID("launch"),
		state: DesktopStartupState{
			State:   "starting",
			Phase:   "lock",
			Detail:  "正在检查工作区目录与实例锁",
			DataDir: a.dataDir,
		},
	}
	state := a.boot.state
	a.mu.Unlock()
	go func() {
		_ = prepareDesktopApp(a)
	}()
	return state
}

func (a *DesktopApp) setBootPhase(phase, detail string) {
	var (
		dataDir     string
		launchID    string
		recordPhase bool
	)
	a.mu.Lock()
	if a.boot.state.State == "starting" {
		prevPhase := a.boot.state.Phase
		a.boot.state.Phase = phase
		a.boot.state.Detail = detail
		dataDir = a.dataDir
		launchID = a.boot.launchID
		if phase != "" && phase != "lock" {
			a.boot.attemptAcquiredLock = true
			a.boot.transient = nil
			recordPhase = phase != prevPhase
		}
	}
	a.mu.Unlock()

	if recordPhase {
		_ = diagnostics.AppendBootLogEntry(dataDir, diagnostics.BootLogEntry{
			ID:        newDesktopBootID("boot"),
			LaunchID:  launchID,
			Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
			State:     "starting",
			Phase:     phase,
		})
	}
}

func (a *DesktopApp) startSingleflight(ctx context.Context) error {
	a.mu.Lock()
	if a.migrating || a.closing {
		a.mu.Unlock()
		return errors.New("本地工作区正在关闭或迁移，请稍后重试")
	}
	if rt := a.runtime(); rt != nil {
		a.mu.Unlock()
		return nil
	}
	if a.boot.state.State == "failed" && a.boot.rawErr != nil {
		err := a.boot.rawErr
		a.mu.Unlock()
		return err
	}
	if a.boot.running {
		wait := a.boot.wait
		a.mu.Unlock()
		select {
		case <-wait:
			a.mu.RLock()
			err := a.boot.rawErr
			hasRuntime := a.runtime() != nil
			a.mu.RUnlock()
			if hasRuntime {
				return nil
			}
			return err
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	wait := make(chan struct{})
	launchID := a.boot.launchID
	if launchID == "" {
		launchID = newDesktopBootID("launch")
	}
	dataDir := a.dataDir
	openFn := a.openRuntime
	if openFn == nil {
		openFn = openDesktopRuntimeWithPhase
	}
	a.boot = desktopBootAttempt{
		running:  true,
		wait:     wait,
		launchID: launchID,
		state: DesktopStartupState{
			State:   "starting",
			Phase:   "lock",
			Detail:  "正在检查工作区目录与实例锁",
			DataDir: dataDir,
		},
	}
	a.mu.Unlock()

	// Wait for any in-flight offline diagnostic bundle snapshot (<20ms) to release
	// workspace.lock before openFn attempts LockWorkspace, without holding workspaceLockMu during openFn.
	a.workspaceLockMu.Lock()
	a.workspaceLockMu.Unlock()

	startedAt := time.Now().UTC()
	rt, err := openFn(context.Background(), dataDir, func(phase, detail string) {
		a.setBootPhase(phase, detail)
	})

	a.mu.RLock()
	closing := a.closing
	currentPhase := a.boot.state.Phase
	attemptAcquiredLock := a.boot.attemptAcquiredLock
	fallbackTemp := a.fallbackTempDirLocked()
	a.mu.RUnlock()
	if currentPhase == "" {
		currentPhase = "lock"
	}

	if err == nil && closing {
		a.mu.Lock()
		a.boot = desktopBootAttempt{
			rawErr: errors.New("应用已关闭"),
			state:  DesktopStartupState{State: "idle", DataDir: dataDir},
		}
		close(wait)
		a.mu.Unlock()
		_ = closeDesktopRuntime(context.Background(), rt)
		return errors.New("应用已关闭")
	}

	if err != nil {
		reason, message := classifyBootFailure(currentPhase, err)
		failedEntry := diagnostics.BootLogEntry{
			ID:         newDesktopBootID("boot"),
			LaunchID:   launchID,
			Timestamp:  time.Now().UTC().Format(time.RFC3339Nano),
			State:      "failed",
			Phase:      currentPhase,
			Reason:     reason,
			ErrorKind:  diagnostics.SummarizeBootErrorKind(err),
			DurationMs: time.Since(startedAt).Milliseconds(),
		}
		savedPath, wroteDataDir := persistFailedBootArtifacts(dataDir, fallbackTemp, closing, attemptAcquiredLock && reason != "workspace_locked", failedEntry, err)

		a.mu.Lock()
		if savedPath != "" {
			a.lastDiagnosticPath = savedPath
		}
		entryCopy := failedEntry
		a.boot = desktopBootAttempt{
			rawErr:              err,
			launchID:            launchID,
			attemptAcquiredLock: wroteDataDir,
			transient:           &entryCopy,
			state: DesktopStartupState{
				State:          "failed",
				Phase:          currentPhase,
				Detail:         message,
				DataDir:        dataDir,
				Reason:         reason,
				Error:          message,
				DiagnosticPath: savedPath,
			},
		}
		close(wait)
		a.mu.Unlock()
		return err
	}

	clearStartupErrorFiles(dataDir, fallbackTemp)
	_ = diagnostics.AppendBootLogEntry(dataDir, diagnostics.BootLogEntry{
		ID:         newDesktopBootID("boot"),
		LaunchID:   launchID,
		Timestamp:  time.Now().UTC().Format(time.RFC3339Nano),
		State:      "ready",
		Phase:      "ready",
		DurationMs: time.Since(startedAt).Milliseconds(),
	})

	desktopRuntimeRegistryMu.Lock()
	desktopRuntimeRegistry[a] = rt
	desktopRuntimeRegistryMu.Unlock()

	a.mu.Lock()
	a.boot = desktopBootAttempt{
		launchID:            launchID,
		attemptAcquiredLock: true,
		state: DesktopStartupState{
			State:            "ready",
			Phase:            "ready",
			Detail:           "本地工作区已就绪",
			DataDir:          dataDir,
			BaseURL:          rt.BaseURL(),
			LaunchToken:      rt.LaunchToken(),
			UIBootstrapToken: rt.UIBootstrapToken(),
		},
	}
	close(wait)
	a.mu.Unlock()
	return nil
}

// persistFailedBootArtifacts only writes into dataDir while actively holding
// the OS workspace lock. If openFn failed before acquiring the lock or another
// instance acquired the lock after openFn returned, all artifacts go to fallbackTemp.
func persistFailedBootArtifacts(dataDir, fallbackTemp string, closing, mayLockDataDir bool, failedEntry diagnostics.BootLogEntry, bootErr error) (string, bool) {
	releaseLock := func() {}
	lockHeld := false
	if mayLockDataDir {
		releaseLock, lockHeld = tryLockWorkspaceForDiagnostics(dataDir)
	}
	defer releaseLock()

	if lockHeld {
		_ = diagnostics.AppendBootLogEntry(dataDir, failedEntry)
	}
	writeStartupErrorFile(dataDir, fallbackTemp, lockHeld, bootErr)
	if closing {
		return "", lockHeld
	}
	savedPath := saveAutoStartupDiagnosticBundle(dataDir, fallbackTemp, !lockHeld, failedEntry)
	return savedPath, lockHeld
}

func tryLockWorkspaceForDiagnostics(dataDir string) (func(), bool) {
	trimmed := strings.TrimSpace(dataDir)
	if trimmed == "" {
		return func() {}, false
	}
	if info, err := os.Stat(trimmed); err != nil || !info.IsDir() {
		return func() {}, false
	}
	lock, err := runtimeinfo.LockWorkspace(trimmed)
	if err != nil {
		return func() {}, false
	}
	return func() { _ = lock.Close() }, true
}

func (a *DesktopApp) fallbackTempDirLocked() string {
	if strings.TrimSpace(a.tempDir) != "" {
		return a.tempDir
	}
	return systemTempDir()
}

func writeStartupErrorFile(dataDir, fallbackTemp string, lockHeld bool, err error) {
	if err == nil {
		return
	}
	target := filepath.Join(fallbackTemp, "beeftv-diagnostics", "startup-error.log")
	perm := os.FileMode(0o700)
	if lockHeld && strings.TrimSpace(dataDir) != "" {
		target = filepath.Join(strings.TrimSpace(dataDir), "startup-error.log")
		perm = 0o755
	}
	if mkErr := os.MkdirAll(filepath.Dir(target), perm); mkErr == nil {
		_ = os.WriteFile(target, []byte(err.Error()+"\n"), 0o600)
	}
}

func clearStartupErrorFiles(dataDir, fallbackTemp string) {
	if strings.TrimSpace(dataDir) != "" {
		_ = os.Remove(filepath.Join(strings.TrimSpace(dataDir), "startup-error.log"))
	}
	if strings.TrimSpace(fallbackTemp) != "" {
		_ = os.Remove(filepath.Join(strings.TrimSpace(fallbackTemp), "beeftv-diagnostics", "startup-error.log"))
	}
}

func classifyBootFailure(phase string, err error) (string, string) {
	lower := strings.ToLower(err.Error())
	switch {
	case strings.Contains(lower, "另一实例使用"):
		return "workspace_locked", "当前数据目录正被另一个 BeefTV 窗口占用，请先关闭其他窗口或结束残留进程后重试。"
	case strings.Contains(lower, "permission denied") || strings.Contains(lower, "access is denied") || strings.Contains(lower, "拒绝访问"):
		return "data_dir_permission_denied", "当前数据目录没有读写权限，请检查目录权限或系统受控文件夹访问设置。"
	case strings.Contains(lower, "no space left") || strings.Contains(lower, "not enough space") || strings.Contains(lower, "磁盘空间不足"):
		return "disk_full", "当前数据目录所在磁盘空间不足，请清理磁盘空间后重试。"
	case phase == "listen":
		return "loopback_listen_failed", "无法在本机启动本地服务监听（127.0.0.1），请检查防火墙或安全软件拦截设置。"
	case phase == "migrate":
		return "database_migrate_failed", "本地工作区数据库升级失败，原有数据已保留；请导出诊断包以便定位问题。"
	case phase == "database":
		return "database_open_failed", "无法打开本地工作区数据库，请确认数据目录所在磁盘已连接且可正常读写。"
	case phase == "lock" || phase == "storage":
		return "data_dir_inaccessible", "无法访问本地数据目录，请检查存储盘符连接状态及目录读写权限。"
	default:
		return "service_init_failed", "本地工作区服务初始化失败，请导出诊断包或打开数据目录查看日志。"
	}
}

func newDesktopBootID(prefix string) string {
	var raw [6]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return prefix + "-" + time.Now().UTC().Format("20060102150405")
	}
	return prefix + "-" + hex.EncodeToString(raw[:])
}
