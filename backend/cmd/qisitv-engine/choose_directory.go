package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os/exec"
	"runtime"
	"strings"
	"unicode/utf16"
)

// The command is fixed. No website-supplied path or script is interpolated into
// a shell, AppleScript, or PowerShell command.
func chooseProjectDirectory(ctx context.Context) (string, error) {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.CommandContext(ctx, "/usr/bin/osascript", "-e", `try
POSIX path of (choose folder with prompt "选择 qisiTV 项目根文件夹（下一步确认后使用）")
on error number -128
return ""
end try`)
	case "windows":
		script := `Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = 'qisiTV project folder'; if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $picker.SelectedPath }; $picker.Dispose()`
		units := utf16.Encode([]rune(script))
		bytes := make([]byte, len(units)*2)
		for i, unit := range units {
			binary.LittleEndian.PutUint16(bytes[i*2:], unit)
		}
		command = exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", base64.StdEncoding.EncodeToString(bytes))
	case "linux":
		if path, err := exec.LookPath("zenity"); err == nil {
			command = exec.CommandContext(ctx, path, "--file-selection", "--directory", "--title=选择 qisiTV 项目根文件夹")
		} else if path, err := exec.LookPath("kdialog"); err == nil {
			command = exec.CommandContext(ctx, path, "--getexistingdirectory", ".", "--title", "qisiTV 项目根文件夹")
		} else {
			return "", errors.New("没有可用的本机文件选择器，请在网页手动输入项目目录")
		}
	default:
		return "", errors.New("当前系统不支持目录选择，请在网页手动输入项目目录")
	}
	result, err := command.Output()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if err != nil {
		var exit *exec.ExitError
		if runtime.GOOS == "linux" && errors.As(err, &exit) && exit.ExitCode() == 1 {
			return "", nil
		}
		return "", errors.New("本机文件夹选择器未能打开，请手动输入目录")
	}
	value := strings.TrimSpace(strings.TrimPrefix(string(result), "\ufeff"))
	if value == "" {
		return "", nil
	}
	return checkedProjectDirectory(value)
}
