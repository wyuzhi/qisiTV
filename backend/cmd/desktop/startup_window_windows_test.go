//go:build windows

package main

import (
	"path/filepath"
	"testing"
	"unsafe"

	"github.com/wailsapp/wails/v2/pkg/options"
	"golang.org/x/sys/windows"
	"infinite-canvas/backend/internal/runtimeinfo"
)

func TestIsSameWorkspaceInstanceActive(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)

	wsA := filepath.Join(home, "ws-a")
	wsB := filepath.Join(home, "ws-b")
	appA := newDesktopApp(wsA)
	optsA := desktopAppOptions(appA)
	optsB := desktopAppOptions(newDesktopApp(wsB))

	// 1. Neither runtime descriptor nor Wails mutex exists -> false.
	if isSameWorkspaceInstanceActive(optsA) {
		t.Fatal("expected false when no Wails mutex exists")
	}

	// 2. Live runtime descriptor alone (or different UniqueId mutex) cannot be
	// forwarded to by Wails SetupSingleInstance -> must return false.
	if err := runtimeinfo.Write(wsA, "http://127.0.0.1:54322/api", "", "v-test"); err != nil {
		t.Fatal(err)
	}
	defer runtimeinfo.Remove(wsA)
	otherMutexName, err := windows.UTF16PtrFromString("wails-app-" + optsB.SingleInstanceLock.UniqueId + "sim")
	if err != nil {
		t.Fatal(err)
	}
	otherMutex, err := windows.CreateMutex(nil, false, otherMutexName)
	if err != nil {
		t.Fatalf("CreateMutex(other): %v", err)
	}
	defer windows.CloseHandle(otherMutex)
	if isSameWorkspaceInstanceActive(optsA) {
		t.Fatal("expected false when live descriptor has no matching Wails UniqueId mutex")
	}
	if isSameWorkspaceInstanceActive(&options.App{}) {
		t.Fatal("expected false when SingleInstanceLock options are absent")
	}

	// 3. Matching Wails mutex exists, but its DACL denies MUTEX_ALL_ACCESS (simulating
	// an elevated primary whose mutex rejects normal-integrity CreateMutex) -> false.
	restrictedSD, err := windows.SecurityDescriptorFromString("D:P(A;;0x00100000;;;WD)") // SYNCHRONIZE only, no MUTEX_MODIFY_STATE
	if err != nil {
		t.Fatalf("SecurityDescriptorFromString: %v", err)
	}
	mutexNameA, err := windows.UTF16PtrFromString("wails-app-" + optsA.SingleInstanceLock.UniqueId + "sim")
	if err != nil {
		t.Fatal(err)
	}
	restrictedSA := &windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: restrictedSD,
	}
	deniedMutex, err := windows.CreateMutex(restrictedSA, false, mutexNameA)
	if err != nil {
		t.Fatalf("CreateMutex(restricted): %v", err)
	}
	if isSameWorkspaceInstanceActive(optsA) {
		_ = windows.CloseHandle(deniedMutex)
		t.Fatal("expected false when Wails mutex denies MUTEX_ALL_ACCESS (elevated primary simulation)")
	}
	_ = windows.CloseHandle(deniedMutex)

	// 4. Matching Wails single-instance mutex with normal MUTEX_ALL_ACCESS -> true.
	validMutex, err := windows.CreateMutex(nil, false, mutexNameA)
	if err != nil {
		t.Fatalf("CreateMutex(valid): %v", err)
	}
	defer windows.CloseHandle(validMutex)
	if !isSameWorkspaceInstanceActive(optsA) {
		t.Fatal("expected true when matching Wails single-instance mutex grants MUTEX_ALL_ACCESS")
	}
}
