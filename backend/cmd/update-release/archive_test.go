package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPackageDarwinLayoutAndModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("macOS packaging requires a filesystem that preserves Unix executable modes")
	}
	root := t.TempDir()
	app := writeFakeDarwinApp(t, filepath.Join(root, "qisiTV.app"))
	outside := filepath.Join(root, "outside.txt")
	if err := os.WriteFile(outside, []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, ".env"), []byte("SECRET=1"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, "Contents", "Resources", "user.db"), []byte("sqlite"), 0o644); err != nil {
		t.Fatal(err)
	}
	pluginDir := filepath.Join(app, "Contents", "Resources", "plugin-packages")
	if err := os.WriteFile(filepath.Join(pluginDir, "real.qisitv-plugin"), []byte("plugin-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink("real.qisitv-plugin", filepath.Join(pluginDir, "alias.qisitv-plugin")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(app, "Contents", "MacOS", "escaped")); err != nil {
			t.Fatal(err)
		}
	}

	out := filepath.Join(t.TempDir(), "qisiTV-v1.6.0-darwin-arm64.zip")
	var stdout bytes.Buffer
	err := run([]string{"package", "--platform", "darwin-arm64", "--input", app, "--output", out}, &stdout, ioDiscard{})
	if runtime.GOOS != "windows" {
		if err == nil {
			t.Fatal("expected escaping symlink to fail")
		}
		if err := os.Remove(filepath.Join(app, "Contents", "MacOS", "escaped")); err != nil {
			t.Fatal(err)
		}
		stdout.Reset()
		if err := run([]string{"package", "--platform", "darwin-arm64", "--input", app, "--output", out}, &stdout, ioDiscard{}); err != nil {
			t.Fatal(err)
		}
	} else if err != nil {
		t.Fatal(err)
	}

	names := zipNames(t, out)
	if !names["qisiTV.app/Contents/MacOS/qisiTV"] {
		t.Fatalf("missing executable: %v", names)
	}
	if names["qisiTV.app/.env"] || names["qisiTV.app/Contents/Resources/user.db"] {
		t.Fatalf("secret or db leaked into zip: %v", names)
	}
	if runtime.GOOS != "windows" {
		if !names["qisiTV.app/Contents/Resources/plugin-packages/alias.qisitv-plugin"] {
			t.Fatalf("dereferenced plugin alias missing: %v", names)
		}
	}
	reader, err := zip.OpenReader(out)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var sawExec, sawSymlink bool
	for _, file := range reader.File {
		if file.Mode()&os.ModeSymlink != 0 {
			sawSymlink = true
		}
		if file.Name == "qisiTV.app/Contents/MacOS/qisiTV" {
			sawExec = true
			if file.Mode()&0o111 == 0 {
				t.Fatalf("executable mode not preserved: %s", file.Mode())
			}
			opened, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			buf := make([]byte, 8)
			n, _ := opened.Read(buf)
			opened.Close()
			if string(buf[:n]) != "binary" && !bytes.HasPrefix(buf, []byte("binary")) {
				content := readZipFile(t, file)
				if string(content) != "binary" {
					t.Fatalf("unexpected executable content %q", content)
				}
			}
		}
		if file.Name == "qisiTV.app/Contents/Resources/plugin-packages/alias.qisitv-plugin" {
			if got := string(readZipFile(t, file)); got != "plugin-bytes" {
				t.Fatalf("alias content %q", got)
			}
		}
	}
	if !sawExec {
		t.Fatal("executable zip entry missing")
	}
	if sawSymlink {
		t.Fatal("zip contained symlink entries")
	}
	if !strings.Contains(stdout.String(), "sha256=") || !strings.Contains(stdout.String(), "size=") {
		t.Fatalf("package should report sha256 and size, got %q", stdout.String())
	}
}

func TestPackageWindowsLayout(t *testing.T) {
	bin := writeFakeWindowsBin(t, t.TempDir())
	if err := os.WriteFile(filepath.Join(bin, ".env.local"), []byte("nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "extra.dll"), []byte("ignore"), 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "qisiTV-v1.6.0-windows-amd64.zip")
	if err := run([]string{"package", "--platform", "windows-amd64", "--input", bin, "--output", out}, ioDiscard{}, ioDiscard{}); err != nil {
		t.Fatal(err)
	}
	names := zipNames(t, out)
	if !names["qisiTV.exe"] || !names["plugin-packages/core.qisitv-plugin"] {
		t.Fatalf("windows zip layout %v", names)
	}
	if names[".env.local"] || names["extra.dll"] {
		t.Fatalf("windows zip included extra files: %v", names)
	}
}

func TestPackageRejectsInvalidInputs(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "out.zip")
	if err := run([]string{"package", "--platform", "linux-amd64", "--input", dir, "--output", out}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("expected unknown platform to fail")
	}
	if err := run([]string{"package", "--platform", "windows-amd64", "--input", dir, "--output", out}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("expected missing exe to fail")
	}
	dataDir := filepath.Join(dir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "open_ai_canvas.db"), []byte("db"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "qisiTV.exe"), []byte("exe"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "plugin-packages"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "plugin-packages", "core.qisitv-plugin"), []byte("p"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"package", "--platform", "windows-amd64", "--input", dataDir, "--output", out}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("expected user data directory to be rejected")
	}
}

func writeFakeDarwinApp(t *testing.T, app string) string {
	t.Helper()
	macOS := filepath.Join(app, "Contents", "MacOS")
	plugins := filepath.Join(app, "Contents", "Resources", "plugin-packages")
	if err := os.MkdirAll(macOS, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(plugins, 0o755); err != nil {
		t.Fatal(err)
	}
	execPath := filepath.Join(macOS, "qisiTV")
	if err := os.WriteFile(execPath, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(execPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, "Contents", "Info.plist"), []byte("<plist></plist>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plugins, "core.qisitv-plugin"), []byte("plugin"), 0o644); err != nil {
		t.Fatal(err)
	}
	return app
}

func writeFakeWindowsBin(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "plugin-packages"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "qisiTV.exe"), []byte("exe"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "plugin-packages", "core.qisitv-plugin"), []byte("plugin"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func zipNames(t *testing.T, path string) map[string]bool {
	t.Helper()
	reader, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	names := map[string]bool{}
	for _, file := range reader.File {
		names[file.Name] = true
	}
	return names
}

func readZipFile(t *testing.T, file *zip.File) []byte {
	t.Helper()
	opened, err := file.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(opened); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
