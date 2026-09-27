package brand

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnvironmentNewNameOverridesLegacyIncludingEmpty(t *testing.T) {
	t.Setenv("BEEFTV_RENAME_TEST", "legacy")
	if got := Getenv("QISITV_RENAME_TEST"); got != "legacy" {
		t.Fatalf("legacy fallback = %q", got)
	}
	t.Setenv("QISITV_RENAME_TEST", "current")
	if got := Getenv("QISITV_RENAME_TEST"); got != "current" {
		t.Fatalf("new setting = %q", got)
	}
	t.Setenv("QISITV_RENAME_TEST", "")
	if got := Getenv("QISITV_RENAME_TEST"); got != "" {
		t.Fatalf("explicitly cleared setting fell back: %q", got)
	}
}

func TestDesktopDataDirectoryKeepsExistingAssets(t *testing.T) {
	root := t.TempDir()
	current, legacy := filepath.Join(root, "qisiTV"), filepath.Join(root, "BeefTV")
	if got, err := DesktopDataDir(root); err != nil || got != current {
		t.Fatalf("new install = %q, %v", got, err)
	}
	if err := os.MkdirAll(legacy, 0o700); err != nil {
		t.Fatal(err)
	}
	asset := filepath.Join(legacy, "existing-resource.bin")
	if err := os.WriteFile(asset, []byte("persisted-resource"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := DesktopDataDir(root); err != nil || got != legacy {
		t.Fatalf("existing workspace = %q, %v", got, err)
	}
	if body, err := os.ReadFile(asset); err != nil || string(body) != "persisted-resource" {
		t.Fatal("existing absolute resource path changed")
	}
	if err := os.MkdirAll(current, 0o700); err != nil {
		t.Fatal(err)
	}
	if got, err := DesktopDataDir(root); err != nil || got != current {
		t.Fatalf("explicit new workspace = %q, %v", got, err)
	}
}
