package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"qisitv/backend/internal/brand"
	"qisitv/backend/internal/desktopupdate"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

func main() {
	// The updater helper must run before defaultDataDir/prepareDesktopApp so a
	// replacement never opens the user database or data directory.
	if done, err := desktopupdate.HandleHelperCommand(os.Args); done {
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	dataDir, err := defaultDataDir()
	if err != nil {
		log.Fatal(err)
	}
	app := newDesktopApp(dataDir)
	startupErrorPath := filepath.Join(dataDir, "startup-error.log")
	if err := prepareDesktopApp(app); err != nil {
		_ = os.MkdirAll(dataDir, 0o755)
		_ = os.WriteFile(startupErrorPath, []byte(err.Error()+"\n"), 0o600)
		log.Fatalf("启动本地后端失败: %v", err)
	}
	_ = os.Remove(startupErrorPath)

	err = wails.Run(&options.App{
		Title:  "qisiTV",
		Width:  1440,
		Height: 960,
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: desktopAssetHandler{app: app},
		},
		OnStartup:  app.startup,
		OnShutdown: app.shutdown,
		Bind:       []interface{}{app},
	})
	if err != nil {
		log.Fatal(err)
	}
}

func prepareDesktopApp(app *DesktopApp) error {
	return app.start(context.Background())
}

func defaultDataDir() (string, error) {
	if override := strings.TrimSpace(os.Getenv("CANVAS_DESKTOP_DATA_DIR")); override != "" {
		return override, nil
	}
	root, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("定位用户应用数据目录: %w", err)
	}
	return brand.DesktopDataDir(root)
}
