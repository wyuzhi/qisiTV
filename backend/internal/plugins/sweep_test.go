package plugins

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"qisitv/backend/internal/protocol"
)

// Each release that changed an official archive used to leave the previous blob
// behind. Startup must drop blobs no committed record points at, keep the ones
// that are referenced, and never touch fresh writes or files it did not create.
func TestStartupSweepsUnreferencedPackageBlobs(t *testing.T) {
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", t.TempDir())
	dataDir, store, _ := newSQLitePluginEnv(t)
	packageDir := filepath.Join(dataDir, "plugin-packages")
	if err := os.MkdirAll(packageDir, 0o700); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	write := func(name string, modTime time.Time) string {
		path := filepath.Join(packageDir, name)
		if err := os.WriteFile(path, []byte("blob"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, modTime, modTime); err != nil {
			t.Fatal(err)
		}
		return path
	}
	stale := write(strings.Repeat("a", 64)+protocol.PluginPackageExtension, old)
	fresh := write(strings.Repeat("b", 64)+protocol.PluginPackageExtension, time.Now())
	foreign := write("my-plugin.beeftv-plugin", old)

	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("kept-plugin", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "kept-plugin.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	kept := filepath.Join(packageDir, pluginHash(pkg)+protocol.PluginPackageExtension)
	if err := os.Chtimes(kept, old, old); err != nil {
		t.Fatal(err)
	}

	if _, err := NewRuntimeWithStore(dataDir, store); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("unreferenced blob survived startup: %v", err)
	}
	for _, path := range []string{kept, fresh, foreign} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("%s was removed: %v", filepath.Base(path), err)
		}
	}
}

// Once the database holds the registry, the old JSON file is a stale copy.
func TestStartupRemovesLegacyRegistryOnceTheDatabaseOwnsIt(t *testing.T) {
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", t.TempDir())
	dataDir, store, _ := newSQLitePluginEnv(t)
	legacy := filepath.Join(dataDir, "plugin_registry.json")
	if err := os.WriteFile(legacy, []byte("[]"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewRuntimeWithStore(dataDir, store); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy registry kept after import: %v", err)
	}
}

// A sweep working from a snapshot taken before an install must not delete the
// blob that install now references: the committed registry wins.
func TestSweepRereadsTheCommittedRegistry(t *testing.T) {
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", t.TempDir())
	dataDir, store, _ := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	pkg := testPluginPackage(t, testManifest("reused-plugin", "1.0.0"))
	if _, err := New(runtime, store).InstallUploaded("admin-1", pkg, "reused-plugin.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	blob := filepath.Join(dataDir, "plugin-packages", pluginHash(pkg)+protocol.PluginPackageExtension)
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(blob, old, old); err != nil {
		t.Fatal(err)
	}
	runtime.sweepStartupLeftovers(nil)
	if _, err := os.Stat(blob); err != nil {
		t.Fatalf("referenced blob removed by a stale sweep: %v", err)
	}
}
