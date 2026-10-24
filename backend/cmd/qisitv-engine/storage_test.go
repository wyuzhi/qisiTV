package main

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"qisitv/backend/internal/bootstrap"
	"qisitv/backend/internal/desktopstorage"
	"qisitv/backend/internal/runtimeinfo"
)

func TestClosedEngineSQLiteURIUsesNativeAbsolutePathAndReadOnlyConnection(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "workspace #100%")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(directory, "canvas.db")
	write, err := sql.Open("sqlite3", file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = write.Exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('original')"); err != nil {
		write.Close()
		t.Fatal(err)
	}
	if err = write.Close(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	dsn := closedEngineSQLiteURI(file)
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.Scheme != "file" || parsed.Host != "" || strings.Contains(parsed.Path, `\`) || !strings.HasPrefix(parsed.Path, "/") || !strings.HasSuffix(parsed.Path, "/workspace #100%/canvas.db") {
		t.Fatal("SQLite URI lost or misclassified the native path", dsn, err)
	}
	read, err := sql.Open("sqlite3", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	var value string
	if err = read.QueryRow("SELECT value FROM fixture").Scan(&value); err != nil || value != "original" {
		t.Fatal("URI did not reopen the original database", value, err)
	}
	if _, err = read.Exec("UPDATE fixture SET value='mutated'"); err == nil {
		t.Fatal("offline validation URI allowed a write")
	}
	if err = read.Close(); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(file)
	if err != nil || string(before) != string(after) {
		t.Fatal("read-only validation changed the original database", err)
	}
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err = os.Stat(file + suffix); !os.IsNotExist(err) {
			t.Fatal("read-only validation created a journal", suffix, err)
		}
	}
}

func closedStorageFixture(t *testing.T) string {
	t.Helper()
	profile := filepath.Join(t.TempDir(), "workspace")
	ctx := context.Background()
	rt, err := bootstrap.Open(ctx, bootstrap.Config{Profile: bootstrap.ProfileDesktop, DataDir: profile, ListenAddr: "127.0.0.1:0", AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = newEngineShell(ctx, rt, profile, ""); err != nil {
		t.Fatal(err)
	}
	if err = rt.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(profile, "resources"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(profile, "resources", "owned.png"), []byte("unchanged bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	return profile
}

func TestEngineOfflineMigrationCopiesVerifiesAndRetainsSource(t *testing.T) {
	profile := closedStorageFixture(t)
	target := filepath.Join(t.TempDir(), "relocated")
	before, err := desktopstorage.Snapshot(profile)
	if err != nil {
		t.Fatal(err)
	}
	usage, err := migrateEngineStorage(context.Background(), profile, target)
	if err != nil {
		t.Fatal(err)
	}
	if usage.DataDir != target || usage.PreviousDir != profile {
		t.Fatal("wrong storage receipt", usage)
	}
	resolved, err := desktopstorage.Resolve(profile)
	if err != nil || resolved != target {
		t.Fatal("location not atomically switched", resolved, err)
	}
	if err = desktopstorage.VerifySnapshot(profile, before, false); err != nil {
		t.Fatal("source was changed", err)
	}
	if err = desktopstorage.VerifySnapshot(target, before, false); err != nil {
		t.Fatal("copy does not match", err)
	}
	if err = validateClosedEngine(target); err != nil {
		t.Fatal("copied database invalid", err)
	}
	if _, err = migrateEngineStorage(context.Background(), profile, filepath.Join(t.TempDir(), "again")); err == nil {
		t.Fatal("previous receipt discarded by second migration")
	}
	if err = desktopstorage.CleanupPrevious(profile, target, runtimeinfo.LockWorkspace); err != nil {
		t.Fatal("verified old copy cannot be cleaned", err)
	}
	if _, err = os.Stat(filepath.Join(target, "resources", "owned.png")); err != nil {
		t.Fatal("cleanup changed active media", err)
	}
	if resolved, err = desktopstorage.Resolve(profile); err != nil || resolved != target {
		t.Fatal("cleanup removed fixed pointer", err)
	}
}

func TestEngineOfflineMigrationRefusesLiveAndNonemptyTargets(t *testing.T) {
	profile := closedStorageFixture(t)
	lock, err := runtimeinfo.LockWorkspace(profile)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = migrateEngineStorage(context.Background(), profile, filepath.Join(t.TempDir(), "live")); err == nil {
		t.Fatal("live workspace copied")
	}
	lock.Close()
	target := t.TempDir()
	if err = os.WriteFile(filepath.Join(target, "existing"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = migrateEngineStorage(context.Background(), profile, target); err == nil {
		t.Fatal("nonempty target overwritten")
	}
	resolved, err := desktopstorage.Resolve(profile)
	if err != nil || resolved != profile {
		t.Fatal("failed migration switched pointer")
	}
	if _, err = migrateEngineStorage(context.Background(), profile, filepath.Join(profile, "nested")); err == nil {
		t.Fatal("overlapping target accepted")
	}
	journal := filepath.Join(profile, "open_ai_canvas.db-wal")
	if err = os.WriteFile(journal, []byte("uncheckpointed fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = migrateEngineStorage(context.Background(), profile, filepath.Join(t.TempDir(), "journal")); err == nil {
		t.Fatal("uncheckpointed SQLite journal was ignored")
	}
	if resolved, err = desktopstorage.Resolve(profile); err != nil || resolved != profile {
		t.Fatal("journal failure switched the workspace pointer")
	}
}

func TestOfflineMigrationRejectsStaleBrowserSource(t *testing.T) {
	t.Setenv("QISITV_ENGINE_DATA_DIR", "")
	profile := closedStorageFixture(t)
	target := filepath.Join(t.TempDir(), "target")
	otherWorkspace := t.TempDir()
	err := storageCommand(context.Background(), []string{"migrate", "--profile-dir", profile, "--expected-source", otherWorkspace, "--to", target})
	if err == nil {
		t.Fatal("stale page migrated another workspace")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("rejected command created a destination", err)
	}
	if current, err := desktopstorage.Resolve(profile); err != nil || current != profile {
		t.Fatal("rejected command switched workspace", current, err)
	}
}
