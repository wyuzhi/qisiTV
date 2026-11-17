//go:build windows

package webviewlock

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	cchRmSessionKey   = 32
	cchRmMaxAppName   = 255
	cchRmMaxSvcName   = 63
	errorMoreData     = windows.ERROR_MORE_DATA
	webviewExeName    = "msedgewebview2.exe"
	desktopExeName    = "beeftv.exe"
	hostLeaseFileName = ".beeftv-host.lock"
)

var (
	rstrtmgrDLL             = windows.NewLazySystemDLL("rstrtmgr.dll")
	procRmStartSession      = rstrtmgrDLL.NewProc("RmStartSession")
	procRmRegisterResources = rstrtmgrDLL.NewProc("RmRegisterResources")
	procRmGetList           = rstrtmgrDLL.NewProc("RmGetList")
	procRmEndSession        = rstrtmgrDLL.NewProc("RmEndSession")

	findLockHoldersFn   = findLockHolders
	terminateProcessFn  = terminateMatchingProcess
	probeLockFileFn     = probeLockFileState
	snapshotProcessesFn = snapshotProcesses
)

type rmUniqueProcess struct {
	ProcessID        uint32
	ProcessStartTime windows.Filetime
}

type rmProcessInfo struct {
	Process          rmUniqueProcess
	AppName          [cchRmMaxAppName + 1]uint16
	ServiceShortName [cchRmMaxSvcName + 1]uint16
	ApplicationType  uint32
	AppStatus        uint32
	TSSessionID      uint32
	Restartable      int32
}

type lockHolder struct {
	pid       uint32
	startTime windows.Filetime
	imageName string
}

type procSnapshotEntry struct {
	parentPID uint32
	exeName   string
}

func prepareAndLeasePlatformProfile(profileDir string, sameWorkspaceActive bool, gracefulWait, reclaimWait time.Duration) (func(), error) {
	if profileDir == "" {
		return func() {}, nil
	}
	leaseHandle, err := openHostLeaseFile(profileDir)
	if err != nil {
		if errors.Is(err, ErrElevatedWebViewResidual) {
			return func() {}, err
		}
		return func() {}, nil
	}

	var ov windows.Overlapped
	// Attempt non-blocking exclusive lock first: if another live BeefTV host
	// already holds a shared lease on this profile, skip reclamation immediately.
	if exErr := windows.LockFileEx(leaseHandle, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov); exErr == nil {
		reclaimErr := reclaimUnderExclusiveLease(profileDir, sameWorkspaceActive, gracefulWait, reclaimWait)
		_ = windows.UnlockFileEx(leaseHandle, 0, 1, 0, &ov)
		if reclaimErr != nil {
			_ = windows.CloseHandle(leaseHandle)
			return func() {}, reclaimErr
		}
	}

	// Acquire shared host lease for the lifetime of this desktop window.
	if shErr := windows.LockFileEx(leaseHandle, windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov); shErr != nil {
		_ = windows.CloseHandle(leaseHandle)
		return func() {}, nil
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			var unlockOv windows.Overlapped
			_ = windows.UnlockFileEx(leaseHandle, 0, 1, 0, &unlockOv)
			_ = windows.CloseHandle(leaseHandle)
		})
	}, nil
}

func waitAndReclaimPlatformProfile(profileDir string, gracefulWait, reclaimWait time.Duration) error {
	if profileDir == "" {
		return nil
	}
	leaseHandle, err := openHostLeaseFile(profileDir)
	if err != nil {
		if errors.Is(err, ErrElevatedWebViewResidual) {
			return err
		}
		return nil
	}
	defer windows.CloseHandle(leaseHandle)

	var ov windows.Overlapped
	if exErr := windows.LockFileEx(leaseHandle, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov); exErr != nil {
		// Another live BeefTV workspace owns this profile; never touch its WebView2.
		return nil
	}
	defer func() {
		_ = windows.UnlockFileEx(leaseHandle, 0, 1, 0, &ov)
	}()
	return reclaimUnderExclusiveLease(profileDir, false, gracefulWait, reclaimWait)
}

func openHostLeaseFile(profileDir string) (windows.Handle, error) {
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		if errors.Is(err, os.ErrPermission) || errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return 0, ErrElevatedWebViewResidual
		}
		return 0, err
	}
	leasePath := filepath.Join(profileDir, hostLeaseFileName)
	ptr, err := windows.UTF16PtrFromString(leasePath)
	if err != nil {
		return 0, err
	}
	h, err := windows.CreateFile(
		ptr,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_ALWAYS,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil && (errors.Is(err, os.ErrPermission) || errors.Is(err, windows.ERROR_ACCESS_DENIED)) {
		return 0, ErrElevatedWebViewResidual
	}
	return h, err
}

func reclaimUnderExclusiveLease(profileDir string, sameWorkspaceActive bool, gracefulWait, reclaimWait time.Duration) error {
	lockFilePath := LockFileForProfile(profileDir)
	if lockFilePath == "" {
		return nil
	}
	held, accessDenied := probeLockFileFn(lockFilePath)
	if !held {
		return nil
	}
	selfPID := uint32(os.Getpid())

	deadline := time.Now().Add(max(time.Duration(0), gracefulWait))
	for {
		held, accessDenied = probeLockFileFn(lockFilePath)
		if !held {
			return nil
		}
		if !time.Now().Before(deadline) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	holders, rmErr := findLockHoldersFn(lockFilePath)
	if rmErr != nil || len(holders) == 0 {
		stillHeld, stillDenied := probeLockFileFn(lockFilePath)
		if !stillHeld {
			return nil
		}
		if accessDenied || stillDenied || rmErr != nil {
			return ErrElevatedWebViewResidual
		}
		return ErrWebViewProfileBusy
	}
	snap := snapshotProcessesFn()
	orphans, sawLiveHost := classifyLockHolders(holders, snap, selfPID, isParentAliveBeforeChild)
	if len(orphans) == 0 {
		stillHeld, stillDenied := probeLockFileFn(lockFilePath)
		if !stillHeld {
			return nil
		}
		return resolveRemainingLockError(sawLiveHost, sameWorkspaceActive, accessDenied || stillDenied)
	}

	termDenied := accessDenied
	for _, orphan := range orphans {
		if termErr := terminateProcessFn(orphan); errors.Is(termErr, windows.ERROR_ACCESS_DENIED) {
			termDenied = true
		}
	}

	reclaimDeadline := time.Now().Add(max(time.Duration(0), reclaimWait))
	for time.Now().Before(reclaimDeadline) {
		stillHeld, _ := probeLockFileFn(lockFilePath)
		if !stillHeld {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	if stillHeld, stillDenied := probeLockFileFn(lockFilePath); stillHeld {
		return resolveRemainingLockError(sawLiveHost, sameWorkspaceActive, termDenied || stillDenied)
	}
	return nil
}

func resolveRemainingLockError(sawLiveHost, sameWorkspaceActive, denied bool) error {
	if sawLiveHost {
		if sameWorkspaceActive {
			return nil
		}
		return ErrWebViewProfileBusy
	}
	if denied {
		return ErrElevatedWebViewResidual
	}
	return ErrWebViewProfileBusy
}

func classifyLockHolders(
	holders []lockHolder,
	snap map[uint32]procSnapshotEntry,
	selfPID uint32,
	parentAlive func(parentPID uint32, childStart windows.Filetime) (bool, windows.Filetime),
) (orphans []lockHolder, sawLiveHost bool) {
	for _, holder := range holders {
		if holder.pid == 0 || holder.pid == selfPID {
			continue
		}
		lower := strings.ToLower(holder.imageName)
		if lower == desktopExeName {
			return nil, true
		}
		if lower != webviewExeName {
			continue
		}
		if hasLiveHostAncestor(holder, snap, selfPID, parentAlive) {
			sawLiveHost = true
			continue
		}
		orphans = append(orphans, holder)
	}
	return orphans, sawLiveHost
}

func hasLiveHostAncestor(
	holder lockHolder,
	snap map[uint32]procSnapshotEntry,
	selfPID uint32,
	parentAlive func(parentPID uint32, childStart windows.Filetime) (bool, windows.Filetime),
) bool {
	curPID := holder.pid
	curStart := holder.startTime
	visited := make(map[uint32]struct{}, 8)
	for depth := 0; depth < 8; depth++ {
		visited[curPID] = struct{}{}
		entry, ok := snap[curPID]
		if !ok || entry.parentPID == 0 {
			return false
		}
		parentPID := entry.parentPID
		if parentPID == selfPID {
			return true
		}
		if _, seen := visited[parentPID]; seen {
			return false
		}
		alive, parentStart := parentAlive(parentPID, curStart)
		if !alive {
			return false
		}
		parentEntry, hasParent := snap[parentPID]
		if !hasParent || parentEntry.exeName != webviewExeName {
			// Reached a live non-WebView2 host ancestor (such as BeefTV.exe).
			return true
		}
		curPID = parentPID
		curStart = parentStart
	}
	return true
}

func snapshotProcesses() map[uint32]procSnapshotEntry {
	out := make(map[uint32]procSnapshotEntry, 128)
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return out
	}
	defer windows.CloseHandle(snap)

	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err := windows.Process32First(snap, &entry); err != nil {
		return out
	}
	for {
		out[entry.ProcessID] = procSnapshotEntry{
			parentPID: entry.ParentProcessID,
			exeName:   strings.ToLower(windows.UTF16ToString(entry.ExeFile[:])),
		}
		entry.Size = uint32(unsafe.Sizeof(entry))
		if err := windows.Process32Next(snap, &entry); err != nil {
			break
		}
	}
	return out
}

func isParentAliveBeforeChild(parentPID uint32, childStart windows.Filetime) (bool, windows.Filetime) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, parentPID)
	if err != nil {
		// Conservative safety: if another user/elevated process cannot be opened, treat parent as alive.
		return errors.Is(err, windows.ERROR_ACCESS_DENIED), windows.Filetime{}
	}
	defer windows.CloseHandle(h)
	status, waitErr := windows.WaitForSingleObject(h, 0)
	if waitErr != nil || status != uint32(windows.WAIT_TIMEOUT) {
		return false, windows.Filetime{}
	}
	var pCreate, pExit, pKernel, pUser windows.Filetime
	if err := windows.GetProcessTimes(h, &pCreate, &pExit, &pKernel, &pUser); err != nil {
		return true, windows.Filetime{}
	}
	if childStart.LowDateTime != 0 || childStart.HighDateTime != 0 {
		if pCreate.Nanoseconds() > childStart.Nanoseconds() {
			return false, windows.Filetime{}
		}
	}
	return true, pCreate
}

func probeLockFileState(lockFilePath string) (held bool, accessDenied bool) {
	info, err := os.Stat(lockFilePath)
	if err != nil {
		if errors.Is(err, os.ErrPermission) || errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return true, true
		}
		return false, false
	}
	if info.IsDir() {
		return false, false
	}
	ptr, err := windows.UTF16PtrFromString(lockFilePath)
	if err != nil {
		return false, false
	}
	h, err := windows.CreateFile(
		ptr,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err == nil {
		_ = windows.CloseHandle(h)
		return false, false
	}
	if errors.Is(err, os.ErrPermission) || errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return true, true
	}
	if errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return true, false
	}
	return false, false
}

func findLockHolders(lockFilePath string) ([]lockHolder, error) {
	if err := rstrtmgrDLL.Load(); err != nil {
		return nil, err
	}
	var session uint32
	var sessionKey [cchRmSessionKey + 1]uint16
	r1, _, _ := procRmStartSession.Call(
		uintptr(unsafe.Pointer(&session)),
		0,
		uintptr(unsafe.Pointer(&sessionKey[0])),
	)
	if r1 != 0 {
		return nil, windows.Errno(r1)
	}
	defer procRmEndSession.Call(uintptr(session))

	filePtr, err := windows.UTF16PtrFromString(lockFilePath)
	if err != nil {
		return nil, err
	}
	files := []*uint16{filePtr}
	r1, _, _ = procRmRegisterResources.Call(
		uintptr(session),
		1,
		uintptr(unsafe.Pointer(&files[0])),
		0, 0,
		0, 0,
	)
	if r1 != 0 {
		return nil, windows.Errno(r1)
	}

	var needed uint32
	var count uint32
	var rebootReasons uint32
	r1, _, _ = procRmGetList.Call(
		uintptr(session),
		uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&count)),
		0,
		uintptr(unsafe.Pointer(&rebootReasons)),
	)
	if r1 == 0 || needed == 0 {
		return nil, nil
	}
	if windows.Errno(r1) != errorMoreData {
		return nil, windows.Errno(r1)
	}

	entries := make([]rmProcessInfo, needed+4)
	count = uint32(len(entries))
	r1, _, _ = procRmGetList.Call(
		uintptr(session),
		uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&count)),
		uintptr(unsafe.Pointer(&entries[0])),
		uintptr(unsafe.Pointer(&rebootReasons)),
	)
	if r1 != 0 {
		return nil, windows.Errno(r1)
	}

	out := make([]lockHolder, 0, count)
	for i := uint32(0); i < count; i++ {
		entry := entries[i]
		name := queryProcessBaseName(entry.Process.ProcessID, entry.Process.ProcessStartTime)
		if name == "" {
			appName := strings.TrimSpace(windows.UTF16ToString(entry.AppName[:]))
			if strings.Contains(strings.ToLower(appName), "webview2") {
				name = webviewExeName
			} else {
				name = appName
			}
		}
		out = append(out, lockHolder{
			pid:       entry.Process.ProcessID,
			startTime: entry.Process.ProcessStartTime,
			imageName: name,
		})
	}
	return out, nil
}

func queryProcessBaseName(pid uint32, expectedStart windows.Filetime) string {
	if pid == 0 {
		return ""
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)

	if expectedStart.LowDateTime != 0 || expectedStart.HighDateTime != 0 {
		var creation, exit, kernel, user windows.Filetime
		if err := windows.GetProcessTimes(h, &creation, &exit, &kernel, &user); err == nil {
			if creation != expectedStart {
				return ""
			}
		}
	}

	buf := make([]uint16, windows.MAX_PATH*2)
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &size); err != nil || size == 0 {
		return ""
	}
	return filepath.Base(windows.UTF16ToString(buf[:size]))
}

func terminateMatchingProcess(target lockHolder) error {
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, target.pid)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)

	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &creation, &exit, &kernel, &user); err != nil || creation != target.startTime {
		return nil
	}
	if err := windows.TerminateProcess(h, 1); err != nil {
		return err
	}
	_, _ = windows.WaitForSingleObject(h, 1500)
	return nil
}
