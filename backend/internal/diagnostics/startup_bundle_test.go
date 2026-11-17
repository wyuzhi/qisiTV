package diagnostics

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestExportStartupBundleWorksOfflineWithoutLeakingPathsAndAnalyzesBootFailure(t *testing.T) {
	dataDir := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)

	if err := AppendBootLogEntry(dataDir, BootLogEntry{
		ID:        "boot-start-1",
		LaunchID:  "launch-1",
		Timestamp: now.Add(-5 * time.Second).Format(time.RFC3339Nano),
		State:     "starting",
		Phase:     "migrate",
	}); err != nil {
		t.Fatal(err)
	}
	if err := AppendBootLogEntry(dataDir, BootLogEntry{
		ID:         "boot-fail-1",
		LaunchID:   "launch-1",
		Timestamp:  now.Add(-2 * time.Second).Format(time.RFC3339Nano),
		State:      "failed",
		Phase:      "migrate",
		Reason:     "database_migrate_failed",
		ErrorKind:  "corrupt-database",
		DurationMs: 3000,
	}); err != nil {
		t.Fatal(err)
	}

	bundle, err := ExportStartupBundle(context.Background(), StartupExportOptions{
		DataDir: dataDir,
		Now:     func() time.Time { return now },
		Request: ExportRequest{
			Description: "Windows 10 启动失败 token=secret-value",
			ClientEvents: []ClientEvent{
				{
					ID:        "evt-fallback-1",
					Timestamp: now.Add(-time.Second).Format(time.RFC3339Nano),
					Level:     "warn",
					Category:  "startup",
					Code:      "desktop_loopback_fallback",
					Reason:    "loopback_unreachable_same_origin_active",
					Message:   "回环地址不可达，已切回同源通道",
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	files := readTestZIP(t, bundle.Data)
	for _, body := range files {
		if strings.Contains(body, dataDir) || strings.Contains(body, "secret-value") {
			t.Fatalf("startup bundle leaked private path or token: %s", body)
		}
	}
	if !strings.Contains(files["desktop/boot.jsonl"], `"database_migrate_failed"`) {
		t.Fatalf("missing desktop/boot.jsonl failure entry: %s", files["desktop/boot.jsonl"])
	}

	findings, err := AnalyzeBundle(bundle.Data)
	if err != nil {
		t.Fatal(err)
	}
	assertFindingReferences(t, files, findings)

	byReason := map[string]Finding{}
	for _, f := range findings {
		byReason[f.Reason] = f
	}
	if byReason["database_migrate_failed"].Status != "confirmed" || byReason["database_migrate_failed"].Stage != "desktop_boot/migrate" {
		t.Fatalf("expected confirmed boot failure finding, got %+v", findings)
	}
	if byReason["loopback_blocked_using_asset_proxy"].Status != "confirmed" {
		t.Fatalf("expected confirmed loopback fallback finding, got %+v", findings)
	}

	// Once a subsequent boot reaches ready, the older failure is not reported as active.
	if err := AppendBootLogEntry(dataDir, BootLogEntry{
		ID:         "boot-ready-2",
		LaunchID:   "launch-2",
		Timestamp:  now.Add(time.Second).Format(time.RFC3339Nano),
		State:      "ready",
		Phase:      "ready",
		DurationMs: 420,
	}); err != nil {
		t.Fatal(err)
	}
	recovered, err := ExportStartupBundle(context.Background(), StartupExportOptions{
		DataDir: dataDir,
		Now:     func() time.Time { return now.Add(2 * time.Second) },
	})
	if err != nil {
		t.Fatal(err)
	}
	recoveredFindings, err := AnalyzeBundle(recovered.Data)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range recoveredFindings {
		if f.Reason == "database_migrate_failed" {
			t.Fatalf("recovered boot still reported old failure as active: %+v", f)
		}
	}
}

func TestExportStartupBundleDuringRetryDoesNotConfirmPreviousFailureAndSupportsExtraBootEvents(t *testing.T) {
	dataDir := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)

	if err := AppendBootLogEntry(dataDir, BootLogEntry{
		ID:         "boot-fail-prev",
		LaunchID:   "launch-prev",
		Timestamp:  now.Add(-8 * time.Second).Format(time.RFC3339Nano),
		State:      "failed",
		Phase:      "migrate",
		Reason:     "database_migrate_failed",
		ErrorKind:  "corrupt-database",
		DurationMs: 2200,
	}); err != nil {
		t.Fatal(err)
	}
	if err := AppendBootLogEntry(dataDir, BootLogEntry{
		ID:        "boot-retry-start",
		LaunchID:  "launch-retry",
		Timestamp: now.Add(-1 * time.Second).Format(time.RFC3339Nano),
		State:     "starting",
		Phase:     "migrate",
	}); err != nil {
		t.Fatal(err)
	}

	retryingBundle, err := ExportStartupBundle(context.Background(), StartupExportOptions{
		DataDir: dataDir,
		Now:     func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	retryingFindings, err := AnalyzeBundle(retryingBundle.Data)
	if err != nil {
		t.Fatal(err)
	}
	sawInProgress := false
	for _, f := range retryingFindings {
		if f.Reason == "database_migrate_failed" && f.Status == "confirmed" {
			t.Fatalf("active retry must not confirm previous launch failure: %+v", retryingFindings)
		}
		if f.Reason == "desktop_boot_in_progress" && f.Status == "inconclusive" && f.Stage == "desktop_boot/migrate" {
			sawInProgress = true
		}
	}
	if !sawInProgress {
		t.Fatalf("expected desktop_boot_in_progress inconclusive finding during retry, got %+v", retryingFindings)
	}

	lockedOwnerDir := t.TempDir()
	lockedBundle, err := ExportStartupBundle(context.Background(), StartupExportOptions{
		DataDir: lockedOwnerDir,
		Now:     func() time.Time { return now },
		ExtraBootEvents: []BootLogEntry{
			{
				ID:         "boot-locked-1",
				LaunchID:   "launch-locked",
				Timestamp:  now.Add(-500 * time.Millisecond).Format(time.RFC3339Nano),
				State:      "failed",
				Phase:      "lock",
				Reason:     "workspace_locked",
				ErrorKind:  "locked",
				DurationMs: 12,
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	lockedFindings, err := AnalyzeBundle(lockedBundle.Data)
	if err != nil {
		t.Fatal(err)
	}
	confirmedLocked := false
	for _, f := range lockedFindings {
		if f.Status == "confirmed" && f.Reason == "workspace_locked" && f.Stage == "desktop_boot/lock" {
			confirmedLocked = true
		}
	}
	if !confirmedLocked {
		t.Fatalf("expected confirmed workspace_locked finding from ExtraBootEvents, got %+v", lockedFindings)
	}
}
