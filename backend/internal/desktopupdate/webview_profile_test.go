package desktopupdate

import (
	"path/filepath"
	"runtime"
	"testing"

	"infinite-canvas/backend/internal/webviewlock"
)

func TestResolvePlatformWebViewProfileDirMatchesDesktopResolver(t *testing.T) {
	appData := filepath.Join(t.TempDir(), "Roaming")
	t.Setenv("AppData", appData)
	t.Setenv("APPDATA", appData)
	exe := filepath.Join(t.TempDir(), "BeefTV.exe")
	customWS := filepath.Join(t.TempDir(), "custom-workspace")

	got := resolvePlatformWebViewProfileDir(exe, customWS)
	if runtime.GOOS != "windows" {
		if got != "" {
			t.Fatalf("expected empty profile on %s, got %q", runtime.GOOS, got)
		}
		return
	}
	want := webviewlock.ProfileDirForWorkspace(exe, customWS)
	if got == "" || got != want {
		t.Fatalf("updater WebView profile %q != desktop single-source %q", got, want)
	}
}
