package webviewlock

import (
	"path/filepath"
	"testing"
	"time"
)

func TestProfileDirForExecutable(t *testing.T) {
	appData := filepath.Join(t.TempDir(), "Roaming")
	t.Setenv("AppData", appData)
	portable := ProfileDirForExecutable(filepath.Join(t.TempDir(), "BeefTV.exe"))
	want := filepath.Join(appData, "BeefTV.exe")
	if portable != want {
		t.Fatalf("ProfileDirForExecutable=%q want %q", portable, want)
	}
	wantLock := filepath.Join(want, "EBWebView", "lockfile")
	if gotLock := LockFileForProfile(portable); gotLock != wantLock {
		t.Fatalf("LockFileForProfile=%q want %q", gotLock, wantLock)
	}
	release, err := PrepareAndLeaseProfile(portable, false, 20*time.Millisecond, 20*time.Millisecond)
	if err != nil {
		t.Fatalf("PrepareAndLeaseProfile failed: %v", err)
	}
	release()
	if err := WaitAndReclaimUnownedProfile(portable, 20*time.Millisecond, 20*time.Millisecond); err != nil {
		t.Fatalf("missing lockfile should succeed immediately: %v", err)
	}

	exe := filepath.Join(t.TempDir(), "BeefTV.exe")
	defDir := filepath.Join(t.TempDir(), "default-ws")
	customDir := filepath.Join(t.TempDir(), "custom-ws")
	if got := ProfileDirForWorkspaceWithDefault(exe, defDir, defDir); got != want {
		t.Fatalf("default workspace profile=%q want %q", got, want)
	}
	isolated := ProfileDirForWorkspaceWithDefault(exe, customDir, defDir)
	if isolated == "" || isolated == want {
		t.Fatalf("custom workspace must resolve isolated .ws-<hash> profile, got %q", isolated)
	}
}
