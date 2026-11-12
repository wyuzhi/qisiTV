package main

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"sync"
	"unsafe"

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
)

const (
	perMonitorAwareDPI    = ^uintptr(2) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE (-3)
	monitorDefaultNearest = 2           // MONITOR_DEFAULTTONEAREST
	startupNoZOrder       = 0x0004      // SWP_NOZORDER
	startupNoActivate     = 0x0010      // SWP_NOACTIVATE
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
