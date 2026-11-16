package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/options"
	"infinite-canvas/backend/internal/bootstrap"
	"infinite-canvas/backend/internal/runtimeinfo"
	"infinite-canvas/backend/internal/webviewlock"
)

func TestSecondLaunchReachesWailsWhilePrimaryOwnsWorkspace(t *testing.T) {
	for _, key := range []string{"TMPDIR", "TEMP", "TMP"} {
		t.Setenv(key, os.Getenv(key))
	}
	primary := newDesktopApp(t.TempDir())
	if err := primary.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { primary.stop(context.Background()) })
	primaryOptions := desktopAppOptions(primary)
	secondary := newDesktopApp(primary.dataDir)
	link := "beeftv://skills/install?id=official-interview-outline&version=official-interview-outline-1.0.0"
	enteredWails := false
	err := runDesktopApp(secondary, func(opts *options.App) error {
		enteredWails = true
		if secondary.runtime() != nil {
			t.Fatal("secondary opened the workspace before single-instance dispatch")
		}
		if opts.SingleInstanceLock.UniqueId != primaryOptions.SingleInstanceLock.UniqueId {
			t.Fatal("same workspace did not select the primary instance")
		}
		// Wails forwards these arguments and exits the second process without
		// calling its OnStartup. Exercise our actual receiver with the real lock held.
		primaryOptions.SingleInstanceLock.OnSecondInstanceLaunch(options.SecondInstanceData{Args: []string{"--data-dir=" + primary.dataDir, link}})
		return nil
	})
	if err != nil || !enteredWails {
		t.Fatalf("second launch could not reach Wails: %v", err)
	}
	if got := primary.ConsumeSkillLink(); got != "/skills?releaseId=official-interview-outline-1.0.0&skillId=official-interview-outline" {
		t.Fatalf("primary did not receive exact-version preview: %q", got)
	}
	if secondary.runtime() != nil || secondary.ConsumeSkillLink() != "" {
		t.Fatal("second launch opened a runtime or consumed the primary's link")
	}
	if primary.runtime() == nil {
		t.Fatal("second launch stopped the primary runtime")
	}
	if _, err := os.Stat(filepath.Join(primary.dataDir, "startup-error.log")); !os.IsNotExist(err) {
		t.Fatalf("forwarding wrote a startup failure: %v", err)
	}
}

func TestSeparateWorkspaceRunsItsOwnStartup(t *testing.T) {
	for _, key := range []string{"TMPDIR", "TEMP", "TMP"} {
		t.Setenv(key, os.Getenv(key))
	}
	primary := newDesktopApp(t.TempDir())
	if err := primary.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { primary.stop(context.Background()) })
	other := newDesktopApp(t.TempDir())
	t.Cleanup(func() { other.shutdown(context.Background()) })
	if err := runDesktopApp(other, func(opts *options.App) error {
		primaryOpts := desktopAppOptions(primary)
		if opts.SingleInstanceLock.UniqueId == primaryOpts.SingleInstanceLock.UniqueId {
			t.Fatal("different data directories share the Wails instance lock")
		}
		if runtime.GOOS == "windows" {
			if opts.Windows.WebviewUserDataPath == "" || opts.Windows.WebviewUserDataPath == primaryOpts.Windows.WebviewUserDataPath {
				t.Fatalf("different data directories share WebviewUserDataPath: primary=%q other=%q", primaryOpts.Windows.WebviewUserDataPath, opts.Windows.WebviewUserDataPath)
			}
		}
		if other.runtime() != nil {
			t.Fatal("backend opened before the Wails primary-instance decision")
		}
		opts.OnStartup(context.Background())
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if got := other.StartupState(); got.BaseURL == "" || got.BaseURL == primary.StartupState().BaseURL {
		t.Fatal("isolated startup did not receive its own backend")
	}
}

func TestWindowsWebViewUserDataPathPreservesDefaultAndIsolatesExtraWorkspaces(t *testing.T) {
	appData := t.TempDir()
	t.Setenv("APPDATA", appData)
	exePath := filepath.Join(t.TempDir(), "BeefTV.exe")
	defaultWS := filepath.Join(t.TempDir(), "DefaultBeefTV")
	wsA := filepath.Join(t.TempDir(), "WorkspaceA")
	wsB := filepath.Join(t.TempDir(), "WorkspaceB")

	canonicalBase := filepath.Join(appData, "BeefTV.exe")
	if got := webviewlock.ProfileDirForWorkspaceWithDefault(exePath, defaultWS, defaultWS); got != canonicalBase {
		t.Fatalf("default workspace must keep canonical profile %q for zero-loss upgrade, got %q", canonicalBase, got)
	}
	profileA := webviewlock.ProfileDirForWorkspaceWithDefault(exePath, wsA, defaultWS)
	profileB := webviewlock.ProfileDirForWorkspaceWithDefault(exePath, wsB, defaultWS)
	if profileA == "" || profileA == canonicalBase || profileB == "" || profileB == canonicalBase || profileA == profileB {
		t.Fatalf("isolated workspaces must get distinct profiles: canonical=%q A=%q B=%q", canonicalBase, profileA, profileB)
	}
	if strings.HasPrefix(profileA, wsA) || strings.HasPrefix(profileB, wsB) {
		t.Fatalf("webview profile must stay outside dataDir before lock acquisition: A=%q B=%q", profileA, profileB)
	}
	if got := webviewlock.ProfileDirForWorkspaceWithDefault(exePath, wsA, defaultWS); got != profileA {
		t.Fatalf("same workspace must resolve deterministically: %q != %q", got, profileA)
	}
}

func TestElevatedWebViewResidualAbortsStartupBeforeWailsRun(t *testing.T) {
	for _, key := range []string{"TMPDIR", "TEMP", "TMP"} {
		t.Setenv(key, os.Getenv(key))
	}
	t.Setenv("BEEFTV_NO_ERROR_DIALOG", "1")
	prev := prepareStartupWebViewFn
	t.Cleanup(func() { prepareStartupWebViewFn = prev })
	for _, blockingErr := range []error{webviewlock.ErrElevatedWebViewResidual, webviewlock.ErrWebViewProfileBusy} {
		prepareStartupWebViewFn = func(*DesktopApp, *options.App) (func(), error) {
			return func() {}, blockingErr
		}
		app := newDesktopApp(t.TempDir())
		enteredWails := false
		err := runDesktopApp(app, func(*options.App) error {
			enteredWails = true
			return nil
		})
		if !errors.Is(err, blockingErr) {
			t.Fatalf("expected %v abort, got %v", blockingErr, err)
		}
		if enteredWails {
			t.Fatalf("runDesktopApp must abort before entering wails.Run on %v", blockingErr)
		}
	}

	elevatedMsg := blockingWebViewErrorMessage(webviewlock.ErrElevatedWebViewResidual)
	busyMsg := blockingWebViewErrorMessage(webviewlock.ErrWebViewProfileBusy)
	if !strings.Contains(elevatedMsg, "msedgewebview2.exe") {
		t.Fatalf("elevated residual message should guide ending residual msedgewebview2.exe, got %q", elevatedMsg)
	}
	if busyMsg == "" || strings.Contains(busyMsg, "msedgewebview2.exe") {
		t.Fatalf("unknown busy message must not instruct killing active msedgewebview2.exe, got %q", busyMsg)
	}
}

func TestPrimaryStartupFailureStillRecordsWorkspaceLockError(t *testing.T) {
	ownerDir := t.TempDir()
	app := newDesktopApp(ownerDir)
	app.tempDir = t.TempDir()
	lock, err := runtimeinfo.LockWorkspace(ownerDir)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()

	beforeEntries, err := os.ReadDir(ownerDir)
	if err != nil {
		t.Fatal(err)
	}

	startupErr := prepareDesktopApp(app)
	if startupErr == nil || app.runtime() != nil {
		t.Fatal("primary startup bypassed an existing workspace lock")
	}

	afterEntries, err := os.ReadDir(ownerDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(afterEntries) != len(beforeEntries) {
		t.Fatalf("locked workspace mutated owner directory entries: before=%d after=%d", len(beforeEntries), len(afterEntries))
	}
	for i := range beforeEntries {
		if beforeEntries[i].Name() != afterEntries[i].Name() {
			t.Fatalf("locked workspace changed owner directory entry %d: %q -> %q", i, beforeEntries[i].Name(), afterEntries[i].Name())
		}
	}

	data, readErr := os.ReadFile(filepath.Join(app.tempDir, "beeftv-diagnostics", "startup-error.log"))
	if readErr != nil || strings.TrimSpace(string(data)) != startupErr.Error() {
		t.Fatalf("startup failure not recorded in temp diagnostics log: %q, %v", data, readErr)
	}
}

func TestOwnedStartupFailureRecordsErrorLogInDataDir(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.tempDir = t.TempDir()
	app.openRuntime = func(_ context.Context, _ string, onPhase func(phase, detail string)) (*bootstrap.Runtime, error) {
		onPhase("migrate", "正在更新本地数据库结构")
		return nil, os.ErrPermission
	}
	err := prepareDesktopApp(app)
	if err == nil {
		t.Fatal("expected prepareDesktopApp failure")
	}
	data, readErr := os.ReadFile(filepath.Join(app.dataDir, "startup-error.log"))
	if readErr != nil || strings.TrimSpace(string(data)) != err.Error() {
		t.Fatalf("owned workspace failure not recorded in dataDir: %q, %v", data, readErr)
	}
}
