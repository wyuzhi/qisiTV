package desktopupdate

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var relaunchInstall = relaunchTarget

func SwapInstall(req HelperRequest) error {
	switch {
	case strings.HasPrefix(req.Platform, "darwin"):
		return swapDarwin(req)
	case strings.HasPrefix(req.Platform, "windows"):
		return swapWindows(req)
	default:
		return ErrUnsupported
	}
}

func backupRoot(req HelperRequest) string {
	return req.BackupPath
}

func swapDarwin(req HelperRequest) error {
	stagedApp := filepath.Join(req.StagedPath, appBundleName)
	if err := os.MkdirAll(filepath.Dir(req.BackupPath), 0o755); err != nil {
		return err
	}
	if err := retryIO(func() error { return renamePath(req.TargetPath, req.BackupPath) }); err != nil {
		return err
	}
	if err := retryIO(func() error { return renamePath(stagedApp, req.TargetPath) }); err != nil {
		_ = retryIO(func() error { return renamePath(req.BackupPath, req.TargetPath) })
		return err
	}
	return nil
}

func swapWindows(req HelperRequest) error {
	targetDir := filepath.Dir(req.TargetPath)
	stagedExe := filepath.Join(req.StagedPath, windowsExeName)
	stagedPlugins := filepath.Join(req.StagedPath, pluginDirName)
	if err := os.MkdirAll(req.BackupPath, 0o755); err != nil {
		return err
	}
	backupExe := filepath.Join(req.BackupPath, windowsExeName)
	if err := retryIO(func() error { return renamePath(req.TargetPath, backupExe) }); err != nil {
		return err
	}
	targetPlugins := filepath.Join(targetDir, pluginDirName)
	backedUpPlugins := false
	if pathExists(targetPlugins) {
		backupPlugins := filepath.Join(req.BackupPath, pluginDirName)
		if err := retryIO(func() error { return renamePath(targetPlugins, backupPlugins) }); err != nil {
			_ = retryIO(func() error { return renamePath(backupExe, req.TargetPath) })
			return err
		}
		backedUpPlugins = true
	}
	if err := retryIO(func() error { return renamePath(stagedExe, req.TargetPath) }); err != nil {
		return errors.Join(err, restoreWindows(req, backedUpPlugins))
	}
	if pathExists(stagedPlugins) {
		if err := retryIO(func() error { return renamePath(stagedPlugins, targetPlugins) }); err != nil {
			return errors.Join(err, restoreWindows(req, backedUpPlugins))
		}
	}
	return nil
}

func restoreWindows(req HelperRequest, pluginsBackedUp bool) error {
	targetDir := filepath.Dir(req.TargetPath)
	backupExe := filepath.Join(req.BackupPath, windowsExeName)
	var failures []error
	if pathExists(backupExe) {
		if err := retryIO(func() error {
			if err := os.Remove(req.TargetPath); err != nil && !os.IsNotExist(err) {
				return err
			}
			return renamePath(backupExe, req.TargetPath)
		}); err != nil {
			failures = append(failures, fmt.Errorf("还原程序失败: %w", err))
		}
	} else if !pathExists(req.TargetPath) {
		failures = append(failures, fmt.Errorf("没有可还原的程序备份"))
	}
	if pluginsBackedUp {
		if err := retryIO(func() error {
			if err := os.RemoveAll(filepath.Join(targetDir, pluginDirName)); err != nil {
				return err
			}
			return renamePath(filepath.Join(req.BackupPath, pluginDirName), filepath.Join(targetDir, pluginDirName))
		}); err != nil {
			failures = append(failures, fmt.Errorf("还原官方插件失败: %w", err))
		}
	}
	return errors.Join(failures...)
}

func RestoreBackup(req HelperRequest) error {
	switch {
	case strings.HasPrefix(req.Platform, "darwin"):
		if !pathExists(req.BackupPath) {
			if pathExists(req.TargetPath) {
				return nil
			}
			return fmt.Errorf("没有可还原的备份")
		}
		if pathExists(req.TargetPath) {
			failed := req.TargetPath + ".qisitv-failed"
			_ = os.RemoveAll(failed)
			_ = renamePath(req.TargetPath, failed)
		}
		return retryIO(func() error { return renamePath(req.BackupPath, req.TargetPath) })
	case strings.HasPrefix(req.Platform, "windows"):
		return restoreWindows(req, pathExists(filepath.Join(req.BackupPath, pluginDirName)))
	default:
		return ErrUnsupported
	}
}

func renamePath(src, dst string) error {
	// Preparation puts both paths on the target volume. Never expose a partial
	// recursive copy while replacing the installed program.
	return os.Rename(src, dst)
}

func copyTree(src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("更新不能复制符号链接")
	}
	if info.IsDir() {
		if err := os.MkdirAll(dst, info.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := copyTree(filepath.Join(src, entry.Name()), filepath.Join(dst, entry.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	return copyFile(src, dst)
}

func retryIO(op func() error) error {
	attempts := 8
	if runtime.GOOS == "windows" {
		attempts = 50
	}
	var err error
	for i := 0; i < attempts; i++ {
		err = op()
		if err == nil {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return err
}

func relaunchTarget(req HelperRequest) error {
	switch {
	case strings.HasPrefix(req.Platform, "darwin"):
		cmd := exec.Command(filepath.Join(req.TargetPath, "Contents", "MacOS", "qisiTV"))
		cmd.Dir = filepath.Dir(req.TargetPath)
		if err := cmd.Start(); err != nil {
			return err
		}
		return cmd.Process.Release()
	case strings.HasPrefix(req.Platform, "windows"):
		cmd := exec.Command(req.TargetPath)
		cmd.Dir = filepath.Dir(req.TargetPath)
		if err := cmd.Start(); err != nil {
			return err
		}
		return cmd.Process.Release()
	default:
		return ErrUnsupported
	}
}
