//go:build windows

package webviewlock

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func isLockFileHeld(lockFilePath string) bool {
	held, _ := probeLockFileFn(lockFilePath)
	return held
}

func openExclusiveLockFile(t *testing.T, lockPath string) (func(), windows.Handle) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		t.Fatal(err)
	}
	ptr, err := windows.UTF16PtrFromString(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(
		ptr,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		0,
		nil,
		windows.CREATE_ALWAYS,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		t.Fatalf("CreateFile exclusive: %v", err)
	}
	closeOnce := sync.OnceFunc(func() {
		_ = windows.CloseHandle(handle)
	})
	t.Cleanup(closeOnce)
	return closeOnce, handle
}

func TestWindowsRestartManagerDetectsHeldLockWithoutKillingNonWebViewProcess(t *testing.T) {
	profileDir := t.TempDir()
	lockPath := LockFileForProfile(profileDir)
	closeLock, _ := openExclusiveLockFile(t, lockPath)

	if !isLockFileHeld(lockPath) {
		t.Fatal("expected exclusively opened lockfile to report held")
	}

	holders, err := findLockHolders(lockPath)
	if err != nil {
		t.Fatalf("findLockHolders: %v", err)
	}
	foundSelf := false
	for _, h := range holders {
		if h.pid == uint32(os.Getpid()) && strings.HasSuffix(strings.ToLower(h.imageName), ".exe") {
			foundSelf = true
		}
	}
	if !foundSelf {
		t.Fatalf("expected Restart Manager to identify current test binary PID %d among holders %+v", os.Getpid(), holders)
	}

	go func() {
		time.Sleep(120 * time.Millisecond)
		closeLock()
	}()
	start := time.Now()
	if err := WaitAndReclaimUnownedProfile(profileDir, 1500*time.Millisecond, 200*time.Millisecond); err != nil {
		t.Fatalf("WaitAndReclaimUnownedProfile: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 1200*time.Millisecond {
		t.Fatalf("expected prompt return once lockfile released, took %v", elapsed)
	}
	if isLockFileHeld(lockPath) {
		t.Fatal("expected lockfile to be unlocked after handle closed")
	}
}

func TestSecondWorkspaceSkipsReclamationWhilePrimaryHoldsSharedProfileLease(t *testing.T) {
	profileDir := t.TempDir()
	// Workspace A acquires its shared profile lease first.
	releaseA, err := PrepareAndLeaseProfile(profileDir, false, 50*time.Millisecond, 50*time.Millisecond)
	if err != nil {
		t.Fatalf("Workspace A PrepareAndLeaseProfile: %v", err)
	}
	defer releaseA()

	// Simulate Workspace A's active WebView2 holding EBWebView/lockfile.
	closeLock, _ := openExclusiveLockFile(t, LockFileForProfile(profileDir))
	defer closeLock()

	var terminateCalls atomic.Int32
	prevTerminate := terminateProcessFn
	terminateProcessFn = func(lockHolder) error {
		terminateCalls.Add(1)
		return nil
	}
	defer func() { terminateProcessFn = prevTerminate }()

	// Workspace B launches against the same WebView2 profile: it must immediately
	// observe Workspace A's active lease without waiting gracefulWait or terminating anything.
	start := time.Now()
	releaseB, err := PrepareAndLeaseProfile(profileDir, true, 2*time.Second, 500*time.Millisecond)
	if err != nil {
		t.Fatalf("Workspace B PrepareAndLeaseProfile: %v", err)
	}
	defer releaseB()

	if elapsed := time.Since(start); elapsed > 400*time.Millisecond {
		t.Fatalf("Workspace B waited %v despite active primary lease", elapsed)
	}
	if terminateCalls.Load() != 0 {
		t.Fatalf("expected 0 terminate calls while primary lease active, got %d", terminateCalls.Load())
	}

	// An updater helper checking the profile while Workspace A/B are running must also skip immediately.
	if err := WaitAndReclaimUnownedProfile(profileDir, 2*time.Second, 500*time.Millisecond); err != nil {
		t.Fatalf("WaitAndReclaimUnownedProfile while leased: %v", err)
	}
}

func TestFilterOrphanWebViewHoldersProtectsLiveParentAndReportsAccessDenied(t *testing.T) {
	// Include an unrelated running CLI/MCP beeftv.exe (PID 7777) AND multi-hop
	// msedgewebview2.exe child trees (both under live host 1001 and dead host 9999).
	snap := map[uint32]procSnapshotEntry{
		1001: {parentPID: 400, exeName: "beeftv.exe"},
		7777: {parentPID: 500, exeName: "beeftv.exe"}, // CLI/MCP `beeftv.exe mcp serve`
		2001: {parentPID: 1001, exeName: "msedgewebview2.exe"},
		2003: {parentPID: 2001, exeName: "msedgewebview2.exe"},
		2002: {parentPID: 9999, exeName: "msedgewebview2.exe"},
		2004: {parentPID: 2002, exeName: "msedgewebview2.exe"},
	}
	holders := []lockHolder{
		{pid: 2001, imageName: "msedgewebview2.exe"},
		{pid: 2003, imageName: "msedgewebview2.exe"},
		{pid: 2002, imageName: "msedgewebview2.exe"},
		{pid: 2004, imageName: "msedgewebview2.exe"},
	}
	orphans, sawLiveHost := classifyLockHolders(holders, snap, 555, func(parentPID uint32, _ windows.Filetime) (bool, windows.Filetime) {
		// Live host 1001, live CLI 7777, and wedged WebView2 browser 2001/2002 are running; dead host 9999 exited.
		switch parentPID {
		case 1001, 7777, 2001, 2002:
			return true, windows.Filetime{}
		default:
			return false, windows.Filetime{}
		}
	})
	if !sawLiveHost || len(orphans) != 2 || orphans[0].pid != 2002 || orphans[1].pid != 2004 {
		t.Fatalf("expected sawLiveHost=true plus orphaned subtree [2002, 2004] despite live CLI 7777, got sawLiveHost=%v orphans=%+v", sawLiveHost, orphans)
	}
	liveOnly, liveProtected := classifyLockHolders([]lockHolder{{pid: 2001, imageName: "msedgewebview2.exe"}}, snap, 555, func(parentPID uint32, _ windows.Filetime) (bool, windows.Filetime) {
		return parentPID == 1001, windows.Filetime{}
	})
	if !liveProtected || len(liveOnly) != 0 {
		t.Fatalf("expected live host holder to report sawLiveHost=true without orphans, got sawLiveHost=%v orphans=%+v", liveProtected, liveOnly)
	}

	// Verify high-integrity residual returning ERROR_ACCESS_DENIED surfaces ErrElevatedWebViewResidual.
	profileDir := t.TempDir()
	lockPath := LockFileForProfile(profileDir)
	closeLock, _ := openExclusiveLockFile(t, lockPath)
	defer closeLock()

	prevHolders := findLockHoldersFn
	prevTerminate := terminateProcessFn
	findLockHoldersFn = func(string) ([]lockHolder, error) {
		return []lockHolder{{pid: 987654321, imageName: "msedgewebview2.exe"}}, nil
	}
	terminateProcessFn = func(lockHolder) error {
		return windows.ERROR_ACCESS_DENIED
	}
	defer func() {
		findLockHoldersFn = prevHolders
		terminateProcessFn = prevTerminate
	}()

	err := WaitAndReclaimUnownedProfile(profileDir, 20*time.Millisecond, 20*time.Millisecond)
	if !errors.Is(err, ErrElevatedWebViewResidual) {
		t.Fatalf("expected ErrElevatedWebViewResidual when OpenProcess returns ERROR_ACCESS_DENIED, got %v", err)
	}
}

func TestUnreadableLockfileAndRestartManagerFailureFailClosed(t *testing.T) {
	// 1. Lockfile probe returning accessDenied=true (e.g. ACL owned by elevated residual)
	// must surface ErrElevatedWebViewResidual rather than failing open as "not held".
	profileDir := t.TempDir()
	prevProbe := probeLockFileFn
	prevHolders := findLockHoldersFn
	probeLockFileFn = func(string) (bool, bool) {
		return true, true
	}
	findLockHoldersFn = func(string) ([]lockHolder, error) {
		return nil, nil
	}
	defer func() {
		probeLockFileFn = prevProbe
		findLockHoldersFn = prevHolders
	}()

	if _, err := PrepareAndLeaseProfile(profileDir, false, 10*time.Millisecond, 10*time.Millisecond); !errors.Is(err, ErrElevatedWebViewResidual) {
		t.Fatalf("expected ErrElevatedWebViewResidual on access-denied lockfile, got %v", err)
	}

	// 2. Restart Manager returning an error while lockfile remains held must also fail closed.
	probeLockFileFn = func(string) (bool, bool) {
		return true, false
	}
	findLockHoldersFn = func(string) ([]lockHolder, error) {
		return nil, windows.ERROR_ACCESS_DENIED
	}
	if err := WaitAndReclaimUnownedProfile(profileDir, 10*time.Millisecond, 10*time.Millisecond); !errors.Is(err, ErrElevatedWebViewResidual) {
		t.Fatalf("expected ErrElevatedWebViewResidual when RmGetList fails on held lockfile, got %v", err)
	}

	// 3. Restart Manager returning (nil, nil) while lockfile remains held must surface ErrWebViewProfileBusy.
	findLockHoldersFn = func(string) ([]lockHolder, error) {
		return nil, nil
	}
	if _, err := PrepareAndLeaseProfile(profileDir, false, 10*time.Millisecond, 10*time.Millisecond); !errors.Is(err, ErrWebViewProfileBusy) {
		t.Fatalf("expected ErrWebViewProfileBusy when held lockfile has zero Rm holders, got %v", err)
	}

	// 4a. A live pre-lease BeefTV.exe window owning the profile for a DIFFERENT workspace
	// (sameWorkspaceActive=false, so Wails will NOT forward) must return ErrWebViewProfileBusy.
	findLockHoldersFn = func(string) ([]lockHolder, error) {
		return []lockHolder{{pid: 4242, imageName: "BeefTV.exe"}}, nil
	}
	if _, err := PrepareAndLeaseProfile(profileDir, false, 10*time.Millisecond, 10*time.Millisecond); !errors.Is(err, ErrWebViewProfileBusy) {
		t.Fatalf("expected ErrWebViewProfileBusy when different-workspace pre-lease BeefTV.exe holds profile, got %v", err)
	}

	// 4b. A live pre-lease BeefTV.exe window owning the profile for the SAME workspace
	// (sameWorkspaceActive=true) must return nil so Wails SingleInstanceLock can forward.
	releaseLive, err := PrepareAndLeaseProfile(profileDir, true, 10*time.Millisecond, 10*time.Millisecond)
	if err != nil {
		t.Fatalf("expected nil when same-workspace BeefTV.exe owns profile so Wails can forward, got %v", err)
	}
	releaseLive()

	// 5. Mixed live-host WebView2 (parent=os.Getpid()) plus orphaned WebView2 (parent=dead):
	// kills ONLY the orphan and returns nil when sameWorkspaceActive=true (or ErrWebViewProfileBusy when false).
	var killedPIDs []uint32
	prevTerm := terminateProcessFn
	prevSnap := snapshotProcessesFn
	terminateProcessFn = func(h lockHolder) error {
		killedPIDs = append(killedPIDs, h.pid)
		return nil
	}
	snapshotProcessesFn = func() map[uint32]procSnapshotEntry {
		return map[uint32]procSnapshotEntry{
			7001: {parentPID: uint32(os.Getpid()), exeName: "msedgewebview2.exe"},
			7002: {parentPID: 99999902, exeName: "msedgewebview2.exe"},
		}
	}
	defer func() {
		terminateProcessFn = prevTerm
		snapshotProcessesFn = prevSnap
	}()
	findLockHoldersFn = func(string) ([]lockHolder, error) {
		return []lockHolder{
			{pid: 7001, imageName: "msedgewebview2.exe"},
			{pid: 7002, imageName: "msedgewebview2.exe"},
		}, nil
	}
	releaseMixed, mixedErr := PrepareAndLeaseProfile(profileDir, true, 10*time.Millisecond, 10*time.Millisecond)
	if mixedErr != nil {
		t.Fatalf("expected nil on mixed live+orphan holders when sameWorkspaceActive=true, got %v", mixedErr)
	}
	releaseMixed()
	if len(killedPIDs) != 1 || killedPIDs[0] != 7002 {
		t.Fatalf("expected only orphan 7002 terminated once (leaving live 7001 untouched), got %v", killedPIDs)
	}
	killedPIDs = nil
	if _, err := PrepareAndLeaseProfile(profileDir, false, 10*time.Millisecond, 10*time.Millisecond); !errors.Is(err, ErrWebViewProfileBusy) {
		t.Fatalf("expected ErrWebViewProfileBusy on mixed live+orphan holders when sameWorkspaceActive=false, got %v", err)
	}

	// 6. Even when probeLockFileFn reports accessDenied=true or orphan termination returns
	// ERROR_ACCESS_DENIED, a live BeefTV host must yield nil for sameWorkspaceActive=true
	// and ErrWebViewProfileBusy (never ErrElevatedWebViewResidual) for sameWorkspaceActive=false.
	probeLockFileFn = func(string) (bool, bool) {
		return true, true
	}
	terminateProcessFn = func(lockHolder) error {
		return windows.ERROR_ACCESS_DENIED
	}
	releaseDeniedSame, errDeniedSame := PrepareAndLeaseProfile(profileDir, true, 10*time.Millisecond, 10*time.Millisecond)
	if errDeniedSame != nil {
		t.Fatalf("expected nil on live same-workspace host even with denied orphan/probe, got %v", errDeniedSame)
	}
	releaseDeniedSame()
	if _, errDeniedDiff := PrepareAndLeaseProfile(profileDir, false, 10*time.Millisecond, 10*time.Millisecond); !errors.Is(errDeniedDiff, ErrWebViewProfileBusy) {
		t.Fatalf("expected ErrWebViewProfileBusy (not ErrElevatedWebViewResidual) on live different-workspace host with denied probe, got %v", errDeniedDiff)
	}
}
