//go:build !windows

package main

import "github.com/wailsapp/wails/v2/pkg/options"

func configureStartupWindow(*options.App) {}

func prepareStartupWebView(*DesktopApp, *options.App) (func(), error) {
	return func() {}, nil
}
