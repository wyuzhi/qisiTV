package main

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"unsafe"

	"infinite-canvas/backend/internal/webviewlock"

	"github.com/wailsapp/wails/v2/pkg/options"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows"
)

var (
	startupWindowUser32     = windows.NewLazySystemDLL("user32.dll")
	findStartupWindow       = startupWindowUser32.NewProc("FindWindowW")
	setStartupThreadDPI     = startupWindowUser32.NewProc("SetThreadDpiAwarenessContext")
	getStartupWindowRect    = startupWindowUser32.NewProc("GetWindowRect")
	monitorForStartupWindow = startupWindowUser32.NewProc("MonitorFromWindow")
	getStartupMonitorInfo   = startupWindowUser32.NewProc("GetMonitorInfoW")
	setStartupWindowPos     = startupWindowUser32.NewProc("SetWindowPos")
	showStartupMessageBox   = startupWindowUser32.NewProc("MessageBoxW")
)

const (
	perMonitorAwareDPI     = ^uintptr(2)             // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE (-3)
	monitorDefaultNearest  = 2                       // MONITOR_DEFAULTTONEAREST
	startupNoZOrder        = 0x0004                  // SWP_NOZORDER
	startupNoActivate      = 0x0010                  // SWP_NOACTIVATE
	mbWarningForegroundBox = 0x00000030 | 0x00010000 // MB_ICONWARNING | MB_SETFOREGROUND
	wailsMutexAllAccess    = 0x001F0001              // MUTEX_ALL_ACCESS (STANDARD_RIGHTS_REQUIRED | SYNCHRONIZE | MUTANT_QUERY_STATE)
)

type startupWindowRect struct {
	left, top, right, bottom int32
}

type startupMonitorInfo struct {
	size          uint32
	monitor, work startupWindowRect
	flags         uint32
}

func configureStartupWindow(opts *options.App) {
	// Locate this process's window after Wails has selected its initial monitor.
	className := fmt.Sprintf("BeefTVMainWindow-%d", os.Getpid())
	opts.Windows.WindowClassName = className
	opts.StartHidden = true
	var firstNavigation sync.Once
	opts.OnDomReady = func(ctx context.Context) {
		firstNavigation.Do(func() {
			if err := fitStartupWindow(className); err != nil {
				wailsruntime.LogWarningf(ctx, "无法调整启动窗口: %v", err)
			}
			wailsruntime.WindowShow(ctx)
		})
	}
}

func prepareStartupWebView(app *DesktopApp, opts *options.App) (func(), error) {
	if opts == nil {
		return func() {}, nil
	}
	profileDir := ""
	if opts.Windows != nil && strings.TrimSpace(opts.Windows.WebviewUserDataPath) != "" {
		profileDir = strings.TrimSpace(opts.Windows.WebviewUserDataPath)
	} else if exe, err := os.Executable(); err == nil {
		profileDir = webviewlock.ProfileDirForExecutable(exe)
	}
	if profileDir == "" {
		return func() {}, nil
	}
	sameWorkspaceActive := isSameWorkspaceInstanceActive(opts)
	release, err := webviewlock.PrepareAndLeaseProfile(profileDir, sameWorkspaceActive, webviewlock.DefaultGracefulWait, webviewlock.DefaultReclaimWait)
	if err != nil {
		if app != nil {
			releaseWsLock, lockHeld := tryLockWorkspaceForDiagnostics(app.dataDir)
			writeStartupErrorFile(app.dataDir, app.fallbackTempDirLocked(), lockHeld, err)
			releaseWsLock()
		}
		if webviewlock.IsBlockingProfileError(err) {
			notifyBlockingWebViewProfileError(err)
		}
	}
	return release, err
}

func isSameWorkspaceInstanceActive(opts *options.App) bool {
	if opts == nil || opts.SingleInstanceLock == nil {
		return false
	}
	uniqueID := strings.TrimSpace(opts.SingleInstanceLock.UniqueId)
	if uniqueID == "" {
		return false
	}
	mutexName, err := windows.UTF16PtrFromString("wails-app-" + uniqueID + "sim")
	if err != nil {
		return false
	}
	// Wails SetupSingleInstance forwards only when CreateMutex succeeds with
	// ERROR_ALREADY_EXISTS (requiring MUTEX_ALL_ACCESS); an elevated primary or
	// descriptor-only backend without a writable matching mutex cannot be forwarded to.
	h, openErr := windows.OpenMutex(wailsMutexAllAccess, false, mutexName)
	if openErr != nil {
		return false
	}
	_ = windows.CloseHandle(h)
	return true
}

func notifyBlockingWebViewProfileError(err error) {
	if strings.TrimSpace(os.Getenv("BEEFTV_NO_ERROR_DIALOG")) == "1" {
		return
	}
	msg := blockingWebViewErrorMessage(err)
	if msg == "" {
		return
	}
	title, err1 := windows.UTF16PtrFromString("BeefTV 启动受阻")
	body, err2 := windows.UTF16PtrFromString(msg)
	if err1 != nil || err2 != nil {
		return
	}
	_, _, _ = showStartupMessageBox.Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), mbWarningForegroundBox)
}

func fitStartupWindow(className string) error {
	class, err := windows.UTF16PtrFromString(className)
	if err != nil {
		return err
	}
	hwnd, _, _ := findStartupWindow.Call(uintptr(unsafe.Pointer(class)), 0)
	if hwnd == 0 {
		return fmt.Errorf("找不到主窗口")
	}
	if err := setStartupThreadDPI.Find(); err != nil {
		return err
	}
	// Read the work area and place the window in the same physical pixel space.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	previousDPI, _, err := setStartupThreadDPI.Call(perMonitorAwareDPI)
	if previousDPI == 0 {
		return fmt.Errorf("读取物理像素坐标: %w", err)
	}
	defer setStartupThreadDPI.Call(previousDPI)

	monitor, _, _ := monitorForStartupWindow.Call(hwnd, monitorDefaultNearest)
	info := startupMonitorInfo{size: uint32(unsafe.Sizeof(startupMonitorInfo{}))}
	if ok, _, err := getStartupMonitorInfo.Call(monitor, uintptr(unsafe.Pointer(&info))); ok == 0 {
		return fmt.Errorf("读取显示器工作区: %w", err)
	}
	var current startupWindowRect
	if ok, _, err := getStartupWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&current))); ok == 0 {
		return fmt.Errorf("读取窗口位置: %w", err)
	}
	next := fitRectToWorkArea(current, info.work)
	if next == current {
		return nil
	}
	if ok, _, err := setStartupWindowPos.Call(hwnd, 0, uintptr(next.left), uintptr(next.top),
		uintptr(next.right-next.left), uintptr(next.bottom-next.top), startupNoZOrder|startupNoActivate); ok == 0 {
		return fmt.Errorf("设置窗口大小与位置: %w", err)
	}
	return nil
}

func fitRectToWorkArea(window, work startupWindowRect) startupWindowRect {
	width, height := window.right-window.left, window.bottom-window.top
	workWidth, workHeight := work.right-work.left, work.bottom-work.top
	if width <= 0 || height <= 0 || workWidth <= 0 || workHeight <= 0 {
		return window
	}
	if window.left >= work.left && window.top >= work.top && window.right <= work.right && window.bottom <= work.bottom {
		return window
	}
	width, height = min(width, workWidth), min(height, workHeight)
	left := work.left + (workWidth-width)/2
	top := work.top + (workHeight-height)/2
	return startupWindowRect{left: left, top: top, right: left + width, bottom: top + height}
}
