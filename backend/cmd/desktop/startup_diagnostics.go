package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"infinite-canvas/backend/internal/bootstrap"
	"infinite-canvas/backend/internal/diagnostics"
	"infinite-canvas/backend/internal/workspace"
)

const maxAutoStartupBundles = 5

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

	ctx, dialogErr := a.dialogContext()
	if dialogErr != nil {
		if autoPath != "" {
			return autoPath, nil
		}
		return "", dialogErr
	}
	chosen, err := a.promptSavePath(ctx, bootstrap.SanitizeSaveFileName(bundle.FileName))
	if err != nil {
		if autoPath != "" {
			return autoPath, nil
		}
		return "", err
	}
	if strings.TrimSpace(chosen) == "" {
		return "", nil
	}
	if err := bootstrap.WriteOwnedArtifact(chosen, bundle.Data); err != nil {
		return "", err
	}
	return chosen, nil
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
