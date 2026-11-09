package main

import (
	"fmt"
	"strings"
)

// Desktop platform flags may be supplied by LaunchServices/WebView. Positional
// CLI commands must never continue into desktop startup or open a database.
func validateDesktopArgs(args []string) error {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--data-dir" {
			if i+1 == len(args) {
				return fmt.Errorf("--data-dir 需要明确的绝对目录")
			}
			if _, err := explicitDesktopDataDir(args[i+1]); err != nil {
				return err
			}
			i++
			continue
		}
		if strings.HasPrefix(arg, "beeftv:") {
			if _, err := skillLinkRoute(arg); err != nil {
				return err
			}
			continue
		}
		switch arg {
		case "--harness-attach-only":
			return fmt.Errorf("--harness-attach-only 需要同时指定 --harness-runtime")
		case "mcp", "ops", "canvas", "asset", "task", "client", "help", "--help", "-h", "--version", "--json", "-json":
			return fmt.Errorf("此程序是 BeefTV 桌面应用。CLI/MCP 请使用 beeftv 命令行程序；在 BeefTV 设置中重新复制客户端配置")
		}
		// Cocoa also accepts preference overrides as flag/value pairs.
		if (strings.HasPrefix(arg, "-NS") || strings.HasPrefix(arg, "-Apple")) && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
			i++
			continue
		}
		if !strings.HasPrefix(arg, "-") {
			return fmt.Errorf("BeefTV 桌面应用不支持命令 %q；CLI/MCP 请使用 beeftv 命令行程序", arg)
		}
	}
	return nil
}
