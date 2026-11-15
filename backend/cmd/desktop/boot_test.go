package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/bootstrap"
	"infinite-canvas/backend/internal/diagnostics"
	"infinite-canvas/backend/internal/runtimeinfo"
)

func TestStartupStateAndRuntimeConfigEndpointDoNotBlockDuringSlowBoot(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	defer app.stop(context.Background())

	enteredMigrate := make(chan struct{})
	releaseMigrate := make(chan struct{})
	app.openRuntime = func(ctx context.Context, dataDir string, onPhase func(phase, detail string)) (*bootstrap.Runtime, error) {
		onPhase("migrate", "正在更新本地数据库结构")
		close(enteredMigrate)
		<-releaseMigrate
		return openDesktopRuntimeWithPhase(ctx, dataDir, onPhase)
	}

	bootDone := make(chan error, 1)
	go func() {
		bootDone <- app.start(context.Background())
	}()

	<-enteredMigrate

	state := app.StartupState()
	if state.State != "starting" || state.Phase != "migrate" {
		t.Fatalf("StartupState() during boot = %#v, want starting/migrate", state)
	}

	cfgRes := httptest.NewRecorder()
	desktopAssetHandler{app: app}.ServeHTTP(cfgRes, httptest.NewRequest(http.MethodGet, "/__desktop/runtime-config", nil))
	if cfgRes.Code != http.StatusOK {
		t.Fatalf("runtime-config status = %d, want 200", cfgRes.Code)
	}
	var endpointState DesktopStartupState
	if err := json.Unmarshal(cfgRes.Body.Bytes(), &endpointState); err != nil {
		t.Fatal(err)
	}
	if endpointState.State != "starting" || endpointState.Phase != "migrate" {
		t.Fatalf("endpoint state = %#v, want starting/migrate", endpointState)
	}

	apiRes := httptest.NewRecorder()
	desktopAssetHandler{app: app}.ServeHTTP(apiRes, httptest.NewRequest(http.MethodGet, "/api/workspace", nil))
	if apiRes.Code != http.StatusServiceUnavailable || !strings.Contains(apiRes.Body.String(), `"reason":"workspace_starting"`) {
		t.Fatalf("in-flight /api response = %d %s", apiRes.Code, apiRes.Body.String())
	}

	close(releaseMigrate)
	if err := <-bootDone; err != nil {
		t.Fatal(err)
	}
	ready := app.StartupState()
	if ready.State != "ready" || ready.BaseURL == "" || ready.LaunchToken == "" || ready.UIBootstrapToken == "" {
		t.Fatalf("ready state = %#v", ready)
	}
}

func TestStartupFailureStaysOpenExportsDiagnosticsAndRecoversOnRetry(t *testing.T) {
	dataDir := t.TempDir()
	app := newDesktopApp(dataDir)
	defer app.shutdown(context.Background())

	failBoot := true
	app.openRuntime = func(ctx context.Context, dir string, onPhase func(phase, detail string)) (*bootstrap.Runtime, error) {
		onPhase("migrate", "正在更新本地数据库结构")
		if failBoot {
			return nil, errors.New("sqlite migration malformed")
		}
		return openDesktopRuntimeWithPhase(ctx, dir, onPhase)
	}

	app.startup(context.Background())

	failed := app.StartupState()
	if failed.State != "failed" || failed.Reason != "database_migrate_failed" || failed.DiagnosticPath == "" {
		t.Fatalf("failed state = %#v", failed)
	}
	if _, err := os.Stat(failed.DiagnosticPath); err != nil {
		t.Fatalf("auto-saved diagnostic bundle missing: %v", err)
	}

	apiRes := httptest.NewRecorder()
	desktopAssetHandler{app: app}.ServeHTTP(apiRes, httptest.NewRequest(http.MethodGet, "/api/workspace", nil))
	if apiRes.Code != http.StatusServiceUnavailable || !strings.Contains(apiRes.Body.String(), `"reason":"database_migrate_failed"`) {
		t.Fatalf("failed /api response = %d %s", apiRes.Code, apiRes.Body.String())
	}

	chosenExport := filepath.Join(t.TempDir(), "exported-startup-diag.zip")
	app.chooseSavePath = func(_ context.Context, _ string) (string, error) {
		return chosenExport, nil
	}
	savedPath, err := app.ExportStartupDiagnostics(`{"description":"Windows 10 工作区无法加载"}`)
	if err != nil || savedPath != chosenExport {
		t.Fatalf("ExportStartupDiagnostics = %q, %v", savedPath, err)
	}
	rawZip, err := os.ReadFile(chosenExport)
	if err != nil {
		t.Fatal(err)
	}
	findings, err := diagnostics.AnalyzeBundle(rawZip)
	if err != nil {
		t.Fatal(err)
	}
	confirmedBoot := false
	for _, f := range findings {
		if f.Status == "confirmed" && f.Reason == "database_migrate_failed" {
			confirmedBoot = true
		}
	}
	if !confirmedBoot {
		t.Fatalf("exported startup bundle did not confirm boot failure: %+v", findings)
	}

	// Simulate user fixing the issue and clicking Retry via POST /__desktop/runtime-config
	failBoot = false
	retryRes := httptest.NewRecorder()
	desktopAssetHandler{app: app}.ServeHTTP(retryRes, httptest.NewRequest(http.MethodPost, "/__desktop/runtime-config", nil))
	if retryRes.Code != http.StatusOK {
		t.Fatalf("retry status = %d", retryRes.Code)
	}

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if app.StartupState().State == "ready" {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if app.StartupState().State != "ready" {
		t.Fatalf("RetryStartup did not reach ready state: %#v", app.StartupState())
	}
}

func TestDesktopAssetHandlerInjectsUIBootstrapTokenOnSameOriginAPI(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	if err := app.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer app.stop(context.Background())

	req := httptest.NewRequest(http.MethodPost, "http://wails.localhost/api/assistant/ui-session", nil)
	req.Host = "wails.localhost"
	req.RemoteAddr = ""
	req.Header.Set("Origin", "http://wails.localhost")
	res := httptest.NewRecorder()
	desktopAssetHandler{app: app}.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("same-origin ui-session status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestDesktopAssetHandlerBlocksSandboxedOpaqueOriginAPIRequests(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	if err := app.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer app.stop(context.Background())

	for _, tc := range []struct {
		name         string
		origin       string
		secFetchSite string
	}{
		{name: "sandboxed-iframe-opaque-origin", origin: "null", secFetchSite: "cross-site"},
		{name: "opaque-origin-only", origin: "null", secFetchSite: ""},
		{name: "cross-site-fetch", origin: "https://untrusted.example.com", secFetchSite: "cross-site"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, target := range []string{
				"http://wails.localhost/api/assistant/ui-session",
				"http://wails.localhost/__desktop/runtime-config",
			} {
				req := httptest.NewRequest(http.MethodPost, target, nil)
				req.Host = "wails.localhost"
				if tc.origin != "" {
					req.Header.Set("Origin", tc.origin)
				}
				if tc.secFetchSite != "" {
					req.Header.Set("Sec-Fetch-Site", tc.secFetchSite)
				}
				res := httptest.NewRecorder()
				desktopAssetHandler{app: app}.ServeHTTP(res, req)
				if res.Code != http.StatusForbidden {
					t.Fatalf("%s status = %d, want 403; body = %s", target, res.Code, res.Body.String())
				}
			}
		})
	}
}

func TestIdleAPIRequestDoesNotBlockDuringSlowBoot(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	defer app.shutdown(context.Background())

	releaseBoot := make(chan struct{})
	app.openRuntime = func(ctx context.Context, dir string, onPhase func(phase, detail string)) (*bootstrap.Runtime, error) {
		<-releaseBoot
		return openDesktopRuntimeWithPhase(ctx, dir, onPhase)
	}

	started := time.Now()
	res := httptest.NewRecorder()
	desktopAssetHandler{app: app}.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/workspace/bootstrap", nil))
	if time.Since(started) > 250*time.Millisecond {
		close(releaseBoot)
		t.Fatalf("idle /api request blocked on slow boot: %v", time.Since(started))
	}
	if res.Code != http.StatusServiceUnavailable || !strings.Contains(res.Body.String(), `"reason":"workspace_starting"`) {
		close(releaseBoot)
		t.Fatalf("idle /api response = %d %s", res.Code, res.Body.String())
	}
	close(releaseBoot)

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if app.StartupState().State == "ready" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if app.StartupState().State != "ready" {
		t.Fatalf("background boot did not reach ready: %#v", app.StartupState())
	}
}

func TestWorkspaceLockedAutoDiagnosticsUsesTempDirWithoutMutatingOwnerDataDir(t *testing.T) {
	ownerDataDir := t.TempDir()
	ownerMarker := filepath.Join(ownerDataDir, "owner.marker")
	if err := os.WriteFile(ownerMarker, []byte("owned"), 0o600); err != nil {
		t.Fatal(err)
	}
	assertOwnerEntriesUnchanged := func(stage string) {
		t.Helper()
		entries, err := os.ReadDir(ownerDataDir)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 || entries[0].Name() != "owner.marker" {
			names := make([]string, 0, len(entries))
			for _, e := range entries {
				names = append(names, e.Name())
			}
			t.Fatalf("%s mutated active owner dataDir entries: %v", stage, names)
		}
	}

	app := newDesktopApp(ownerDataDir)
	app.tempDir = t.TempDir()
	defer app.shutdown(context.Background())

	enteredRetryLock := make(chan struct{})
	releaseRetryLock := make(chan struct{})
	attempt := 0
	app.openRuntime = func(_ context.Context, _ string, _ func(phase, detail string)) (*bootstrap.Runtime, error) {
		attempt++
		if attempt == 2 {
			close(enteredRetryLock)
			<-releaseRetryLock
		}
		return nil, errors.New("本地工作区已被另一实例使用 (pid 4242)")
	}

	_ = prepareDesktopApp(app)
	assertOwnerEntriesUnchanged("after locked prepareDesktopApp")

	failed := app.StartupState()
	if failed.State != "failed" || failed.Reason != "workspace_locked" || failed.DiagnosticPath == "" {
		t.Fatalf("locked StartupState = %#v", failed)
	}
	if strings.HasPrefix(failed.DiagnosticPath, ownerDataDir) {
		t.Fatalf("workspace_locked wrote diagnostic bundle inside active owner dataDir: %s", failed.DiagnosticPath)
	}
	rawZip, err := os.ReadFile(failed.DiagnosticPath)
	if err != nil {
		t.Fatal(err)
	}
	findings, err := diagnostics.AnalyzeBundle(rawZip)
	if err != nil {
		t.Fatal(err)
	}
	confirmedLocked := false
	for _, f := range findings {
		if f.Status == "confirmed" && f.Reason == "workspace_locked" {
			confirmedLocked = true
		}
	}
	if !confirmedLocked {
		t.Fatalf("auto bundle did not confirm workspace_locked: %+v", findings)
	}

	// Retry while still blocked in lock phase and export diagnostics: must still
	// write only to systemTempDir() without creating any files in ownerDataDir.
	retryState := app.RetryStartup()
	if retryState.State != "starting" {
		t.Fatalf("RetryStartup state = %#v, want starting", retryState)
	}
	<-enteredRetryLock
	exportedDuringRetry, err := app.ExportStartupDiagnostics(`{"description":"重试等待期间导出"}`)
	if err != nil || exportedDuringRetry == "" || strings.HasPrefix(exportedDuringRetry, ownerDataDir) {
		close(releaseRetryLock)
		t.Fatalf("ExportStartupDiagnostics during lock retry = %q, %v", exportedDuringRetry, err)
	}
	assertOwnerEntriesUnchanged("after ExportStartupDiagnostics during lock retry")
	close(releaseRetryLock)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if app.StartupState().State == "failed" {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	assertOwnerEntriesUnchanged("after second lock failure settled")
}

func TestRetryAfterMigrateFailureExportsInconclusiveAndRespectsConcurrentWorkspaceLock(t *testing.T) {
	dataDir := t.TempDir()
	app := newDesktopApp(dataDir)
	app.tempDir = t.TempDir()
	defer app.shutdown(context.Background())

	enteredRetryLock := make(chan struct{})
	releaseRetryLock := make(chan struct{})
	attempt := 0
	var competingLock *os.File
	app.openRuntime = func(_ context.Context, _ string, onPhase func(phase, detail string)) (*bootstrap.Runtime, error) {
		attempt++
		if attempt == 1 {
			onPhase("migrate", "正在检查并升级数据库结构")
			return nil, errors.New("sqlite migration failed")
		}
		if attempt == 2 {
			close(enteredRetryLock)
			<-releaseRetryLock
			return nil, errors.New("本地工作区已被另一实例使用")
		}
		// Attempt 3: entered migrate, then another process acquires workspace.lock right after openRuntime returns.
		onPhase("migrate", "正在检查并升级数据库结构")
		lock, err := runtimeinfo.LockWorkspace(dataDir)
		if err != nil {
			t.Fatalf("failed to simulate competing workspace lock: %v", err)
		}
		competingLock = lock
		return nil, errors.New("sqlite migration failed again")
	}

	_ = prepareDesktopApp(app)
	firstState := app.StartupState()
	if firstState.State != "failed" || firstState.Reason != "database_migrate_failed" || !strings.HasPrefix(firstState.DiagnosticPath, dataDir) {
		t.Fatalf("first migrate failure state = %#v", firstState)
	}

	// Retry enters lock phase: exporting during retry must report inconclusive desktop_boot_in_progress,
	// NEVER the stale confirmed database_migrate_failed from attempt 1.
	if s := app.RetryStartup(); s.State != "starting" {
		t.Fatalf("RetryStartup = %#v, want starting", s)
	}
	<-enteredRetryLock
	retryExportPath, err := app.ExportStartupDiagnostics(`{"description":"重试等待期间导出"}`)
	if err != nil || retryExportPath == "" || strings.HasPrefix(retryExportPath, dataDir) {
		close(releaseRetryLock)
		t.Fatalf("ExportStartupDiagnostics during lock retry = %q, %v", retryExportPath, err)
	}
	rawRetryZip, err := os.ReadFile(retryExportPath)
	if err != nil {
		close(releaseRetryLock)
		t.Fatal(err)
	}
	retryFindings, err := diagnostics.AnalyzeBundle(rawRetryZip)
	if err != nil {
		close(releaseRetryLock)
		t.Fatal(err)
	}
	sawInconclusive := false
	for _, f := range retryFindings {
		if f.Status == "confirmed" && f.Reason == "database_migrate_failed" {
			close(releaseRetryLock)
			t.Fatalf("retry export reported stale confirmed database_migrate_failed: %+v", retryFindings)
		}
		if f.Status == "inconclusive" && f.Reason == "desktop_boot_in_progress" {
			sawInconclusive = true
		}
	}
	if !sawInconclusive {
		close(releaseRetryLock)
		t.Fatalf("retry export missing inconclusive desktop_boot_in_progress: %+v", retryFindings)
	}
	close(releaseRetryLock)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && app.StartupState().State != "failed" {
		time.Sleep(15 * time.Millisecond)
	}

	// Attempt 3: if another window holds workspace.lock when openRuntime returns,
	// post-open failure persistence must fall back to tempDir instead of writing into dataDir.
	_ = os.Remove(filepath.Join(dataDir, "startup-error.log"))
	_ = app.RetryStartup()
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && app.StartupState().State != "failed" {
		time.Sleep(15 * time.Millisecond)
	}
	if competingLock != nil {
		defer competingLock.Close()
	}
	thirdState := app.StartupState()
	if thirdState.State != "failed" || strings.HasPrefix(thirdState.DiagnosticPath, dataDir) {
		t.Fatalf("post-open failure with competing lock wrote into dataDir: %#v", thirdState)
	}
	if _, statErr := os.Stat(filepath.Join(dataDir, "startup-error.log")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("post-open failure with competing lock wrote startup-error.log into dataDir: %v", statErr)
	}
}

func TestExportSaveDialogDoesNotHoldWorkspaceLockAgainstRetryStartup(t *testing.T) {
	dataDir := t.TempDir()
	app := newDesktopApp(dataDir)
	app.tempDir = t.TempDir()
	app.wailsCtx = context.Background()
	defer app.shutdown(context.Background())

	attempt := 0
	app.openRuntime = func(ctx context.Context, dir string, onPhase func(phase, detail string)) (*bootstrap.Runtime, error) {
		attempt++
		if attempt == 1 {
			onPhase("migrate", "正在检查并升级数据库结构")
			return nil, errors.New("sqlite migration failed")
		}
		return openDesktopRuntimeWithPhase(ctx, dir, onPhase)
	}
	_ = prepareDesktopApp(app)
	if s := app.StartupState(); s.State != "failed" {
		t.Fatalf("expected initial failure, got %#v", s)
	}

	dialogOpened := make(chan struct{})
	releaseDialog := make(chan struct{})
	destZip := filepath.Join(t.TempDir(), "exported.zip")
	app.chooseSavePath = func(_ context.Context, _ string) (string, error) {
		close(dialogOpened)
		<-releaseDialog
		return destZip, nil
	}

	exportDone := make(chan error, 1)
	go func() {
		_, err := app.ExportStartupDiagnostics(`{"description":"保存弹窗打开期间重试"}`)
		exportDone <- err
	}()

	<-dialogOpened
	if s := app.RetryStartup(); s.State == "failed" {
		close(releaseDialog)
		t.Fatalf("RetryStartup failed while SaveFileDialog was open: %#v", s)
	}

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && app.StartupState().State != "ready" {
		if app.StartupState().State == "failed" {
			close(releaseDialog)
			t.Fatalf("RetryStartup hit workspace_locked while SaveFileDialog was open: %#v", app.StartupState())
		}
		time.Sleep(20 * time.Millisecond)
	}
	if app.StartupState().State != "ready" {
		close(releaseDialog)
		t.Fatalf("RetryStartup did not reach ready while SaveFileDialog was open: %#v", app.StartupState())
	}

	close(releaseDialog)
	if err := <-exportDone; err != nil {
		t.Fatalf("ExportStartupDiagnostics error: %v", err)
	}
}
