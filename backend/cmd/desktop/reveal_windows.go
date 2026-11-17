//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

func platformDownloadsDir() string {
	if known, err := windows.KnownFolderPath(windows.FOLDERID_Downloads, 0); err == nil {
		trimmed := strings.TrimSpace(known)
		if trimmed != "" {
			if info, statErr := os.Stat(trimmed); statErr == nil && info.IsDir() {
				return trimmed
			}
		}
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return ""
	}
	candidate := filepath.Join(home, "Downloads")
	if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
		return candidate
	}
	return ""
}

func revealFileInFileManager(targetPath string) error {
	clean := filepath.Clean(strings.TrimSpace(targetPath))
	if clean == "" || !filepath.IsAbs(clean) || strings.ContainsAny(clean, "\"\r\n\x00") {
		return errors.New("诊断包文件路径无效")
	}
	info, err := os.Stat(clean)
	if err != nil || info.IsDir() {
		return errors.New("未找到已导出的诊断包文件")
	}
	command := exec.Command("explorer.exe")
	command.SysProcAttr = &syscall.SysProcAttr{
		CmdLine: fmt.Sprintf(`explorer.exe /select,"%s"`, clean),
	}
	if err := command.Start(); err != nil {
		return errors.New("无法在资源管理器中定位诊断包文件")
	}
	go func() { _ = command.Wait() }()
	return nil
}
