// Package webviewlock coordinates host profile leases and orphan reclamation
// for the Windows WebView2 user-data directory (%APPDATA%\<exe>) without
// deleting or modifying user IndexedDB or draft files.
package webviewlock

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/desktopstorage"
)

// DefaultGracefulWait gives shutting-down WebView2 child processes time to
// flush LevelDB/IndexedDB cleanly before orphan reclamation is attempted.
const (
	DefaultGracefulWait = 4 * time.Second
	DefaultReclaimWait  = 2 * time.Second
)

// ErrElevatedWebViewResidual reports that an orphaned WebView2 process running
// at higher integrity (Administrator) holds the profile lock and cannot be
// terminated by a normal-integrity desktop launch.
var ErrElevatedWebViewResidual = errors.New("检测到管理员权限残留的 WebView2 进程占用浏览器目录，请在任务管理器结束残留的 msedgewebview2.exe 或重启电脑后再打开 BeefTV")

// ErrWebViewProfileBusy reports that the WebView2 lockfile remains held after
// the graceful shutdown window by a process that cannot be identified or safely
// terminated (for example another session, service, or security-software hook).
var ErrWebViewProfileBusy = errors.New("检测到 WebView2 浏览器目录仍被其他进程占用，请关闭占用程序或重启电脑后再打开 BeefTV")

// IsBlockingProfileError reports whether err prevents WebView2 from opening
// its userDataFolder and should abort desktop startup with a user-visible notice.
func IsBlockingProfileError(err error) bool {
	return errors.Is(err, ErrElevatedWebViewResidual) || errors.Is(err, ErrWebViewProfileBusy)
}

// ProfileDirForExecutable resolves the default WebView2 userDataFolder matching
// go-webview2 (%APPDATA%\<filepath.Base(exe)>).
func ProfileDirForExecutable(exePath string) string {
	appData := strings.TrimSpace(os.Getenv("AppData"))
	if appData == "" {
		appData = strings.TrimSpace(os.Getenv("APPDATA"))
	}
	base := filepath.Base(strings.TrimSpace(exePath))
	if appData == "" || base == "" || base == "." || base == string(filepath.Separator) {
		return ""
	}
	return filepath.Join(appData, base)
}

// ProfileDirForWorkspace is the single-source resolver shared by cmd/desktop
// and desktopupdate: the resolved default desktop workspace keeps the canonical
// %APPDATA%\<exe> profile (preserving IndexedDB drafts on upgrade), while any
// isolated workspace (--data-dir / CANVAS_DESKTOP_DATA_DIR) gets a dedicated
// %APPDATA%\<exe>.ws-<hash> profile outside dataDir.
func ProfileDirForWorkspace(exePath, dataDir string) string {
	return ProfileDirForWorkspaceWithDefault(exePath, dataDir, resolvedDefaultWorkspaceDir())
}

// ProfileDirForWorkspaceWithDefault resolves the workspace-aware WebView2
// profile directory against an explicit defaultWorkspaceDir.
func ProfileDirForWorkspaceWithDefault(exePath, dataDir, defaultWorkspaceDir string) string {
	baseProfile := ProfileDirForExecutable(exePath)
	if baseProfile == "" {
		return ""
	}
	cleanData := canonicalWorkspacePath(dataDir)
	cleanDefault := canonicalWorkspacePath(defaultWorkspaceDir)
	if cleanData == "" || (cleanDefault != "" && strings.EqualFold(cleanData, cleanDefault)) {
		return baseProfile
	}
	sum := sha256.Sum256([]byte(strings.ToLower(cleanData)))
	return baseProfile + ".ws-" + hex.EncodeToString(sum[:6])
}

func resolvedDefaultWorkspaceDir() string {
	root, err := desktopstorage.DefaultRoot()
	if err != nil {
		return ""
	}
	resolved, err := desktopstorage.Resolve(root)
	if err != nil {
		return ""
	}
	return canonicalWorkspacePath(resolved)
}

func canonicalWorkspacePath(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	cleaned := filepath.Clean(trimmed)
	if abs, err := filepath.Abs(cleaned); err == nil {
		cleaned = abs
	}
	if resolved, err := filepath.EvalSymlinks(cleaned); err == nil {
		cleaned = resolved
	}
	return cleaned
}

// LockFileForProfile returns the Chromium/WebView2 lockfile inside profileDir.
func LockFileForProfile(profileDir string) string {
	trimmed := strings.TrimSpace(profileDir)
	if trimmed == "" {
		return ""
	}
	return filepath.Join(trimmed, "EBWebView", "lockfile")
}

// PrepareAndLeaseProfile reclaims orphaned WebView2 locks only when no live
// BeefTV host owns profileDir, then acquires a shared host lease held until
// release() or process exit so concurrent workspaces never kill each other's WebView2.
// When a pre-lease BeefTV host still holds the profile lock, sameWorkspaceActive
// indicates whether a running instance of the same workspace exists so Wails
// SingleInstanceLock can forward to it instead of aborting as busy.
func PrepareAndLeaseProfile(profileDir string, sameWorkspaceActive bool, gracefulWait, reclaimWait time.Duration) (func(), error) {
	return prepareAndLeasePlatformProfile(strings.TrimSpace(profileDir), sameWorkspaceActive, gracefulWait, reclaimWait)
}

// WaitAndReclaimUnownedProfile waits for or reclaims an orphaned WebView2 lock
// only when no live host holds a shared lease on profileDir.
func WaitAndReclaimUnownedProfile(profileDir string, gracefulWait, reclaimWait time.Duration) error {
	return waitAndReclaimPlatformProfile(strings.TrimSpace(profileDir), gracefulWait, reclaimWait)
}
