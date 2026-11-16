package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"infinite-canvas/backend/internal/desktopstorage"
	"infinite-canvas/backend/internal/desktopupdate"
	"infinite-canvas/backend/internal/webviewlock"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

func main() {
	// The updater helper must run before defaultDataDir/runDesktopApp so a
	// replacement never opens the user database or data directory.
	if done, err := desktopupdate.HandleHelperCommand(os.Args); done {
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	if done, err := handleHarnessCommand(os.Args[1:]); done {
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := validateDesktopArgs(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	dataDir, err := defaultDataDir()
	if err != nil {
		log.Fatal(err)
	}
	app := newDesktopApp(dataDir)
	app.usePlatformDownloads = true
	for _, arg := range os.Args[1:] {
		if strings.HasPrefix(arg, "beeftv:") {
			app.queueSkillLink(arg)
		}
	}
	err = runDesktopApp(app, wails.Run)
	if err != nil {
		log.Fatal(err)
	}
}

var initialSystemTempDir = os.TempDir()

func systemTempDir() string {
	if strings.TrimSpace(initialSystemTempDir) != "" {
		return initialSystemTempDir
	}
	return os.TempDir()
}

var prepareStartupWebViewFn = prepareStartupWebView

func runDesktopApp(app *DesktopApp, run func(*options.App) error) error {
	if err := configureDesktopTemp(app.dataDir); err != nil {
		log.Printf("配置数据目录临时文件夹失败，继续使用系统默认临时目录: %v", err)
	}
	opts := desktopAppOptions(app)
	releaseWebViewLease, prepErr := prepareStartupWebViewFn(app, opts)
	defer releaseWebViewLease()
	if prepErr != nil {
		if webviewlock.IsBlockingProfileError(prepErr) {
			return fmt.Errorf("%s: %w", blockingWebViewErrorMessage(prepErr), prepErr)
		}
		log.Printf("准备 WebView2 用户目录失败: %v", prepErr)
	}
	// Wails must forward a second launch before the primary instance's workspace
	// lock is acquired. Only OnStartup (or its asset-server fallback) opens it.
	return run(opts)
}

func blockingWebViewErrorMessage(err error) string {
	if errors.Is(err, webviewlock.ErrElevatedWebViewResidual) {
		return "检测到管理员权限残留的 WebView2 进程占用了运行目录，当前普通权限无法自动结束。\r\n\r\n请在任务管理器结束残留的 msedgewebview2.exe 进程，或重新运行安装程序完成修复。"
	}
	if errors.Is(err, webviewlock.ErrWebViewProfileBusy) {
		return "检测到 WebView2 浏览器运行目录正被其他程序占用，暂时无法打开新窗口。\r\n\r\n请先关闭正在占用该目录的程序或稍后重试；若已关闭所有窗口仍无法打开，请重启电脑后再试。"
	}
	return ""
}

func desktopAppOptions(app *DesktopApp) *options.App {
	var webviewUserDataPath string
	if runtime.GOOS == "windows" && app != nil {
		if exe, err := os.Executable(); err == nil {
			webviewUserDataPath = webviewlock.ProfileDirForWorkspace(exe, app.dataDir)
		}
	}
	opts := &options.App{
		Title:            "BeefTV",
		Width:            1440,
		Height:           960,
		BackgroundColour: &options.RGBA{R: 13, G: 15, B: 18, A: 255},
		Mac: &mac.Options{
			OnUrlOpen: app.queueSkillLink,
			// WKWebView disables element fullscreen by default, including the
			// video player's fullscreen control.
			Preferences: &mac.Preferences{FullscreenEnabled: mac.Enabled},
		},
		Windows: &windows.Options{
			WebviewUserDataPath: webviewUserDataPath,
			Theme:               windows.Dark,
			CustomTheme: &windows.ThemeSettings{
				DarkModeTitleBar:          windows.RGB(13, 15, 18),
				DarkModeTitleBarInactive:  windows.RGB(13, 15, 18),
				DarkModeTitleText:         windows.RGB(244, 244, 245),
				DarkModeTitleTextInactive: windows.RGB(161, 161, 170),
				DarkModeBorder:            windows.RGB(39, 39, 42),
				DarkModeBorderInactive:    windows.RGB(39, 39, 42),
			},
		},
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: desktopAssetHandler{app: app},
		},
		OnStartup: app.startup,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: skillInstanceID(app.dataDir),
			OnSecondInstanceLaunch: func(data options.SecondInstanceData) {
				for _, arg := range data.Args {
					if strings.HasPrefix(arg, "beeftv:") {
						app.queueSkillLink(arg)
					}
				}
				app.revealWindow()
			},
		},
		OnShutdown: app.shutdown,
		Bind:       []interface{}{app},
	}
	configureStartupWindow(opts)
	return opts
}

func prepareDesktopApp(app *DesktopApp) error {
	return app.start(context.Background())
}

func defaultDataDir() (string, error) {
	for i := 1; i < len(os.Args); i++ {
		arg := os.Args[i]
		if arg == "--data-dir" {
			if i+1 == len(os.Args) {
				return "", fmt.Errorf("--data-dir 需要明确的绝对目录")
			}
			return explicitDesktopDataDir(os.Args[i+1])
		}
		if strings.HasPrefix(arg, "--data-dir=") {
			return explicitDesktopDataDir(strings.TrimPrefix(arg, "--data-dir="))
		}
	}
	if override := strings.TrimSpace(os.Getenv("CANVAS_DESKTOP_DATA_DIR")); override != "" {
		return override, nil
	}
	root, err := desktopstorage.DefaultRoot()
	if err != nil {
		return "", fmt.Errorf("定位用户应用数据目录: %w", err)
	}
	return desktopstorage.Resolve(root)
}

func explicitDesktopDataDir(dir string) (string, error) {
	dir = strings.TrimSpace(dir)
	clean := filepath.Clean(dir)
	if !filepath.IsAbs(dir) || filepath.Dir(clean) == clean {
		return "", fmt.Errorf("--data-dir 需要明确的绝对目录")
	}
	return clean, nil
}

func configureDesktopTemp(dataDir string) error {
	path := filepath.Join(dataDir, "cache", "tmp")
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	for _, name := range []string{"TMPDIR", "TEMP", "TMP"} {
		if err := os.Setenv(name, path); err != nil {
			return err
		}
	}
	return nil
}
