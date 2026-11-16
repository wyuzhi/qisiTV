package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"infinite-canvas/backend/internal/bootstrap"
	"infinite-canvas/backend/internal/diagnostics"
	"infinite-canvas/backend/internal/workspace"
)

const (
	maxAutoStartupBundles            = 5
	maxDiagnosticBundleArtifactBytes = 32 << 20
)

func (a *DesktopApp) SaveDiagnosticBundle(fileName string, data []byte) (string, error) {
	if len(data) == 0 {
		return "", errors.New("没有可导出的诊断包内容")
	}
	if len(data) > maxDiagnosticBundleArtifactBytes {
		return "", errors.New("诊断包超过允许导出上限，请缩短日志范围后重试")
	}
	return a.saveAndRevealDiagnosticZip(fileName, data, "")
}

// RevealDiagnosticBundle accepts no caller path; it only reveals the diagnostic
// archive most recently written by this DesktopApp process (or opens dataDir).
func (a *DesktopApp) RevealDiagnosticBundle() error {
	if _, err := a.dialogContext(); err != nil {
		return err
	}
	target := a.resolveKnownDiagnosticBundlePath()
	if target == "" {
		return a.OpenUpdateLogDirectory()
	}
	return a.revealSavedFile(target)
}

func (a *DesktopApp) ExportStartupDiagnostics(clientPayload string) (string, error) {
	a.mu.RLock()
	dataDir := a.dataDir
	fallbackTemp := a.fallbackTempDirLocked()
	runtimeHeld := a.runtime() != nil
	bootState := a.boot.state
	launchID := a.boot.launchID
	attemptAcquiredLock := a.boot.attemptAcquiredLock
	var extra []diagnostics.BootLogEntry
	if !runtimeHeld && bootState.State == "starting" {
		phase := bootState.Phase
		if phase == "" {
			phase = "lock"
		}
		if launchID == "" {
			launchID = newDesktopBootID("launch")
		}
		extra = append(extra, diagnostics.BootLogEntry{
			ID:        newDesktopBootID("boot"),
			LaunchID:  launchID,
			Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
			State:     "starting",
			Phase:     phase,
		})
	} else if a.boot.transient != nil {
		extra = append(extra, *a.boot.transient)
	}
	a.mu.RUnlock()

	var req diagnostics.ExportRequest
	trimmed := strings.TrimSpace(clientPayload)
	if trimmed != "" {
		if err := json.Unmarshal([]byte(trimmed), &req); err != nil {
			req.Description = trimmed
		}
	}

	bundle, autoPath, err := a.collectAndSnapshotStartupBundle(dataDir, fallbackTemp, runtimeHeld, attemptAcquiredLock && bootState.Reason != "workspace_locked", req, extra)
	if err != nil {
		return "", err
	}
	return a.saveAndRevealDiagnosticZip(bundle.FileName, bundle.Data, autoPath)
}

func (a *DesktopApp) saveAndRevealDiagnosticZip(fileName string, data []byte, autoFallbackPath string) (string, error) {
	cleanName := sanitizeDiagnosticZipName(fileName)

	if targetDir := a.targetDownloadsDir(); targetDir != "" {
		if savedPath, err := writeUniqueDiagnosticZip(targetDir, cleanName, data); err == nil {
			return a.finishSavedDiagnosticZip(savedPath), nil
		}
	}

	ctx, dialogErr := a.dialogContext()
	if dialogErr != nil {
		if autoFallbackPath != "" {
			return a.finishSavedDiagnosticZip(autoFallbackPath), nil
		}
		return "", dialogErr
	}
	chosen, err := a.promptSavePath(ctx, cleanName)
	if err != nil {
		if autoFallbackPath != "" {
			return a.finishSavedDiagnosticZip(autoFallbackPath), nil
		}
		return "", err
	}
	if strings.TrimSpace(chosen) == "" {
		return "", nil
	}
	if err := bootstrap.WriteOwnedArtifact(chosen, data); err != nil {
		return "", err
	}
	return a.finishSavedDiagnosticZip(chosen), nil
}

func (a *DesktopApp) targetDownloadsDir() string {
	a.mu.RLock()
	downloadsDir := strings.TrimSpace(a.downloadsDir)
	usePlatform := a.usePlatformDownloads
	hasCustomDialog := a.chooseSavePath != nil
	resolveDir := a.resolveDownloadsDir
	a.mu.RUnlock()

	if downloadsDir != "" {
		return downloadsDir
	}
	if !usePlatform || hasCustomDialog {
		return ""
	}
	if resolveDir != nil {
		return strings.TrimSpace(resolveDir())
	}
	return platformDownloadsDir()
}

func (a *DesktopApp) finishSavedDiagnosticZip(savedPath string) string {
	a.recordLastDiagnosticBundlePath(savedPath)
	a.revealSavedFileBestEffort(savedPath)
	return savedPath
}

func sanitizeDiagnosticZipName(fileName string) string {
	cleaned := bootstrap.SanitizeSaveFileNameWithFallbackStem(fileName, "beeftv-diagnostics")
	if !strings.HasSuffix(strings.ToLower(cleaned), ".zip") {
		cleaned += ".zip"
	}
	return cleaned
}

func writeUniqueDiagnosticZip(dir, cleanName string, data []byte) (string, error) {
	cleanDir := filepath.Clean(strings.TrimSpace(dir))
	if cleanDir == "" || !filepath.IsAbs(cleanDir) {
		return "", errors.New("下载目录无效")
	}
	info, err := os.Stat(cleanDir)
	if err != nil || !info.IsDir() {
		return "", errors.New("下载目录不存在")
	}

	tmpFile, tmpErr := os.CreateTemp(cleanDir, ".beeftv-diag-*.tmp")
	if tmpErr != nil {
		return "", tmpErr
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Chmod(0o600)
	_, writeErr := tmpFile.Write(data)
	syncErr := tmpFile.Sync()
	closeErr := tmpFile.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		_ = os.Remove(tmpPath)
		if writeErr != nil {
			return "", writeErr
		}
		if syncErr != nil {
			return "", syncErr
		}
		return "", closeErr
	}

	ext := filepath.Ext(cleanName)
	stem := strings.TrimSuffix(cleanName, ext)
	for attempt := 1; attempt <= 100; attempt++ {
		name := cleanName
		if attempt > 1 {
			name = fmt.Sprintf("%s-%d%s", stem, attempt, ext)
		}
		candidate := filepath.Join(cleanDir, name)
		linkErr := os.Link(tmpPath, candidate)
		if linkErr == nil {
			_ = os.Remove(tmpPath)
			return candidate, nil
		}
		if errors.Is(linkErr, os.ErrExist) {
			continue
		}
		// Filesystem does not support hard links (e.g. exFAT/FAT32); fall back to O_EXCL.
		_ = os.Remove(tmpPath)
		return writeUniqueDiagnosticZipDirect(cleanDir, stem, ext, cleanName, attempt, data)
	}
	_ = os.Remove(tmpPath)
	return "", errors.New("下载目录中同名诊断包过多")
}

func writeUniqueDiagnosticZipDirect(cleanDir, stem, ext, cleanName string, startAttempt int, data []byte) (string, error) {
	for attempt := startAttempt; attempt <= 100; attempt++ {
		name := cleanName
		if attempt > 1 {
			name = fmt.Sprintf("%s-%d%s", stem, attempt, ext)
		}
		candidate := filepath.Join(cleanDir, name)
		file, openErr := os.OpenFile(candidate, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(openErr, os.ErrExist) {
			continue
		}
		if openErr != nil {
			return "", openErr
		}
		_, writeErr := file.Write(data)
		syncErr := file.Sync()
		closeErr := file.Close()
		if writeErr != nil || syncErr != nil || closeErr != nil {
			_ = os.Remove(candidate)
			if writeErr != nil {
				return "", writeErr
			}
			if syncErr != nil {
				return "", syncErr
			}
			return "", closeErr
		}
		return candidate, nil
	}
	return "", errors.New("下载目录中同名诊断包过多")
}

func (a *DesktopApp) recordLastDiagnosticBundlePath(path string) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return
	}
	a.mu.Lock()
	a.lastDiagnosticPath = filepath.Clean(trimmed)
	a.mu.Unlock()
}

func (a *DesktopApp) resolveKnownDiagnosticBundlePath() string {
	a.mu.RLock()
	candidates := []string{a.lastDiagnosticPath, a.boot.state.DiagnosticPath}
	a.mu.RUnlock()
	for _, raw := range candidates {
		clean := filepath.Clean(strings.TrimSpace(raw))
		if clean == "" || clean == "." || !filepath.IsAbs(clean) {
			continue
		}
		if info, err := os.Stat(clean); err == nil && !info.IsDir() {
			return clean
		}
	}
	return ""
}

func (a *DesktopApp) revealSavedFile(path string) error {
	a.mu.RLock()
	reveal := a.revealFile
	a.mu.RUnlock()
	if reveal != nil {
		return reveal(path)
	}
	return revealFileInFileManager(path)
}

func (a *DesktopApp) revealSavedFileBestEffort(path string) {
	a.mu.RLock()
	shouldReveal := a.revealFile != nil || a.usePlatformDownloads
	a.mu.RUnlock()
	if !shouldReveal {
		return
	}
	_ = a.revealSavedFile(path)
}

func (a *DesktopApp) collectAndSnapshotStartupBundle(
	dataDir, fallbackTemp string,
	runtimeHeld, mayLockDataDir bool,
	req diagnostics.ExportRequest,
	extra []diagnostics.BootLogEntry,
) (*diagnostics.Bundle, string, error) {
	if !runtimeHeld && mayLockDataDir {
		a.workspaceLockMu.Lock()
		defer a.workspaceLockMu.Unlock()
	}

	releaseLock := func() {}
	lockHeld := runtimeHeld
	if !lockHeld && mayLockDataDir {
		releaseLock, lockHeld = tryLockWorkspaceForDiagnostics(dataDir)
	}
	defer releaseLock()

	preferTemp := !lockHeld
	bundleDataDir := ""
	var modelCfg diagnostics.ModelConfigProvider
	if lockHeld && strings.TrimSpace(dataDir) != "" {
		bundleDataDir = dataDir
		if provider, err := workspace.NewProviderConfig(dataDir); err == nil {
			modelCfg = provider
		}
	}

	bundle, err := diagnostics.ExportStartupBundle(context.Background(), diagnostics.StartupExportOptions{
		DataDir:         bundleDataDir,
		UpdateLogDir:    bundleDataDir,
		OwnsDataDir:     lockHeld,
		Config:          modelCfg,
		Request:         req,
		ExtraBootEvents: extra,
	})
	if err != nil {
		return nil, "", err
	}
	autoPath := writeStartupDiagnosticSnapshot(dataDir, fallbackTemp, preferTemp, bundle)
	return bundle, autoPath, nil
}

func saveAutoStartupDiagnosticBundle(dataDir, fallbackTemp string, preferTemp bool, extra ...diagnostics.BootLogEntry) string {
	bundleDataDir := dataDir
	if preferTemp {
		bundleDataDir = ""
	}
	bundle, err := diagnostics.ExportStartupBundle(context.Background(), diagnostics.StartupExportOptions{
		DataDir:         bundleDataDir,
		UpdateLogDir:    bundleDataDir,
		OwnsDataDir:     false,
		ExtraBootEvents: extra,
	})
	if err != nil {
		return ""
	}
	return writeStartupDiagnosticSnapshot(dataDir, fallbackTemp, preferTemp, bundle)
}

func writeStartupDiagnosticSnapshot(dataDir, fallbackTemp string, preferTemp bool, bundle *diagnostics.Bundle) string {
	if bundle == nil || len(bundle.Data) == 0 {
		return ""
	}
	if strings.TrimSpace(fallbackTemp) == "" {
		fallbackTemp = systemTempDir()
	}
	tempDiagDir := filepath.Join(fallbackTemp, "beeftv-diagnostics")
	candidates := []string{}
	if !preferTemp && strings.TrimSpace(dataDir) != "" {
		candidates = append(candidates, filepath.Join(dataDir, "diagnostics"))
	}
	candidates = append(candidates, tempDiagDir)

	fileName := bootstrap.SanitizeSaveFileName(bundle.FileName)
	if fileName == "" {
		fileName = "beeftv-startup-diagnostics.zip"
	}
	for _, dir := range candidates {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			continue
		}
		target := filepath.Join(dir, fileName)
		if err := os.WriteFile(target, bundle.Data, 0o600); err != nil {
			continue
		}
		pruneStartupDiagnosticSnapshots(dir)
		return target
	}
	return ""
}

func pruneStartupDiagnosticSnapshots(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.Contains(entry.Name(), "startup-diagnostics-") && strings.HasSuffix(entry.Name(), ".zip") {
			names = append(names, entry.Name())
		}
	}
	if len(names) <= maxAutoStartupBundles {
		return
	}
	sort.Strings(names)
	for _, old := range names[:len(names)-maxAutoStartupBundles] {
		_ = os.Remove(filepath.Join(dir, old))
	}
}
