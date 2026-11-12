package desktopupdate

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSwapInstallRollbackWhenStagedMissing(t *testing.T) {
	root := t.TempDir()
	oldDir := filepath.Join(root, "old")
	staged := filepath.Join(root, "staged")
	if err := WriteDarwinLayout(oldDir, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteDarwinLayout(staged, "NEW"); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(oldDir, appBundleName)
	if err := os.RemoveAll(filepath.Join(staged, appBundleName)); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{
		Schema:     1,
		ParentPID:  unusedPID(t),
		Platform:   "darwin-arm64",
		TargetPath: target,
		StagedPath: staged,
		BackupPath: filepath.Join(root, "backup", appBundleName),
	}
	if err := SwapInstall(req); err == nil {
		t.Fatal("expected swap failure")
	}
	got, err := os.ReadFile(filepath.Join(target, "Contents", "MacOS", "qisiTV"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "OLD") {
		t.Fatalf("rolled back content = %q", got)
	}
}

func TestLaunchFailureRestoresPreviousInstall(t *testing.T) {
	root := t.TempDir()
	oldDir := filepath.Join(root, "old")
	staged := filepath.Join(root, "staged")
	if err := WriteDarwinLayout(oldDir, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteDarwinLayout(staged, "NEW"); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{
		Schema:       1,
		ParentPID:    unusedPID(t),
		Platform:     "darwin-arm64",
		TargetPath:   filepath.Join(oldDir, appBundleName),
		StagedPath:   staged,
		BackupPath:   filepath.Join(root, "backup", appBundleName),
		PreparedPath: filepath.Join(root, "prepared"),
		ResultPath:   filepath.Join(root, "result.json"),
	}
	relaunchInstall = func(HelperRequest) error { return errors.New("launch failed") }
	t.Cleanup(func() { relaunchInstall = relaunchTarget })
	if err := RunHelperRequest(req); err == nil {
		t.Fatal("expected launch failure")
	}
	got, err := os.ReadFile(filepath.Join(req.TargetPath, "Contents", "MacOS", "qisiTV"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "OLD") {
		t.Fatalf("restored = %q", got)
	}
	result, err := os.ReadFile(req.ResultPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(result), `"restored":true`) || !strings.Contains(string(result), "rolled_back") {
		t.Fatalf("recovery = %s", result)
	}
}

func TestWindowsSwapPreservesNeighborFilesAndUserPlugins(t *testing.T) {
	root := t.TempDir()
	targetDir := filepath.Join(root, "qisiTV 安装 测试")
	staged := filepath.Join(root, "staged")
	if err := WriteWindowsLayout(targetDir, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteWindowsLayout(staged, "NEW"); err != nil {
		t.Fatal(err)
	}
	neighbor := filepath.Join(targetDir, "notes.txt")
	if err := os.WriteFile(neighbor, []byte("keep-me"), 0o644); err != nil {
		t.Fatal(err)
	}
	userData := filepath.Join(root, "AppData", "qisiTV", "plugin-packages")
	if err := os.MkdirAll(userData, 0o700); err != nil {
		t.Fatal(err)
	}
	custom := filepath.Join(userData, "custom.qisitv-plugin")
	if err := os.WriteFile(custom, []byte("uploaded"), 0o600); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{
		Platform:   "windows-amd64",
		TargetPath: filepath.Join(targetDir, windowsExeName),
		StagedPath: staged,
		BackupPath: filepath.Join(root, "backup"),
	}
	if err := SwapInstall(req); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(targetDir, windowsExeName))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "NEW") {
		t.Fatalf("exe = %q", got)
	}
	plugin, err := os.ReadFile(filepath.Join(targetDir, pluginDirName, "official.qisitv-plugin"))
	if err != nil || !strings.Contains(string(plugin), "NEW") {
		t.Fatalf("plugin = %q err=%v", plugin, err)
	}
	kept, err := os.ReadFile(neighbor)
	if err != nil || string(kept) != "keep-me" {
		t.Fatalf("neighbor = %q err=%v", kept, err)
	}
	uploaded, err := os.ReadFile(custom)
	if err != nil || string(uploaded) != "uploaded" {
		t.Fatalf("user plugin = %q err=%v", uploaded, err)
	}
}

func TestWindowsAgentHostSwapAndRollback(t *testing.T) {
	for _, oldHasHost := range []bool{false, true} {
		t.Run(fmt.Sprint(oldHasHost), func(t *testing.T) {
			root := t.TempDir()
			target, staged := filepath.Join(root, "old with spaces"), filepath.Join(root, "staged")
			if err := WriteWindowsLayout(target, "OLD"); err != nil {
				t.Fatal(err)
			}
			if !oldHasHost {
				if err := os.RemoveAll(filepath.Join(target, "agent-host")); err != nil {
					t.Fatal(err)
				}
			}
			if err := WriteWindowsLayout(staged, "NEW"); err != nil {
				t.Fatal(err)
			}
			req := HelperRequest{Platform: "windows-amd64", TargetPath: filepath.Join(target, windowsExeName), StagedPath: staged, BackupPath: filepath.Join(root, "backup")}
			if err := SwapInstall(req); err != nil {
				t.Fatal(err)
			}
			node := filepath.Join(target, "agent-host", "runtime", "node.exe")
			if got, err := os.ReadFile(node); err != nil || string(got) != "NEW" {
				t.Fatalf("host not replaced: %q %v", got, err)
			}
			if err := RestoreBackup(req); err != nil {
				t.Fatal(err)
			}
			if err := RestoreBackup(req); err != nil {
				t.Fatal(err)
			}
			if oldHasHost {
				if got, err := os.ReadFile(node); err != nil || string(got) != "OLD" {
					t.Fatalf("host not restored: %q %v", got, err)
				}
			} else if pathExists(filepath.Join(target, "agent-host")) {
				t.Fatal("new host survived rollback to pre-agent install")
			}
		})
	}
}

func TestWindowsMissingAgentRuntimeDoesNotTouchInstall(t *testing.T) {
	root := t.TempDir()
	target, staged := filepath.Join(root, "old"), filepath.Join(root, "new")
	if err := WriteWindowsLayout(target, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteWindowsLayout(staged, "NEW"); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(staged, "agent-host", "runtime", "node.exe")); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{Platform: "windows-amd64", TargetPath: filepath.Join(target, windowsExeName), StagedPath: staged, BackupPath: filepath.Join(root, "backup")}
	if err := SwapInstall(req); err == nil {
		t.Fatal("missing host accepted")
	}
	if got, err := os.ReadFile(req.TargetPath); err != nil || string(got) != "MZ-OLD" {
		t.Fatalf("old exe changed: %q %v", got, err)
	}
}

func TestWindowsRestoreRetriesPluginsAfterExecutableWasRestored(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "installed")
	backup := filepath.Join(root, "backup")
	if err := WriteWindowsLayout(target, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteWindowsLayout(backup, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(backup, windowsExeName)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, pluginDirName, "official.qisitv-plugin"), []byte("NEW"), 0o644); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{Platform: "windows-amd64", TargetPath: filepath.Join(target, windowsExeName), BackupPath: backup}
	if err := RestoreBackup(req); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(target, pluginDirName, "official.qisitv-plugin"))
	if err != nil || string(got) != "official-OLD" {
		t.Fatalf("plugin not restored: %q, %v", got, err)
	}
}

func TestUnicodeAndSpacesPathsRoundTrip(t *testing.T) {
	root := filepath.Join(t.TempDir(), "qisiTV 更新 测试")
	oldDir := filepath.Join(root, "current")
	staged := filepath.Join(root, "staged")
	if err := WriteDarwinLayout(oldDir, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteDarwinLayout(staged, "NEW"); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{
		Platform:   "darwin-arm64",
		TargetPath: filepath.Join(oldDir, appBundleName),
		StagedPath: staged,
		BackupPath: filepath.Join(root, "backup", appBundleName),
	}
	if err := SwapInstall(req); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(req.TargetPath, "Contents", "MacOS", "qisiTV"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "NEW") {
		t.Fatalf("installed = %q", got)
	}
}

func readBundledPluginManifestDirs(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "bundled-plugin-dirs.txt"))
	if err != nil {
		t.Fatalf("read bundled-plugin-dirs.txt: %v", err)
	}
	var names []string
	for _, line := range strings.Split(string(raw), "\n") {
		if idx := strings.IndexByte(line, '#'); idx >= 0 {
			line = line[:idx]
		}
		line = strings.TrimSpace(line)
		if line != "" {
			names = append(names, line)
		}
	}
	if len(names) == 0 {
		t.Fatal("bundled-plugin-dirs.txt is empty")
	}
	return names
}

func writeBundledPluginFixtures(t *testing.T, bundledRoot string, names []string) {
	t.Helper()
	for _, name := range names {
		pkgDir := filepath.Join(bundledRoot, name)
		if err := os.MkdirAll(filepath.Join(pkgDir, "client"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(`{"name":"`+name+`"}`), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(pkgDir, "client", "index.js"), []byte("export default {};\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestExtractedLayoutAcceptsBundledPluginsUnderAgentHostOnAllPlatforms(t *testing.T) {
	names := readBundledPluginManifestDirs(t)

	winOld := filepath.Join(t.TempDir(), "win-old")
	winStaged := filepath.Join(t.TempDir(), "win-staged")
	if err := WriteWindowsLayout(winOld, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteWindowsLayout(winStaged, "NEW"); err != nil {
		t.Fatal(err)
	}
	writeBundledPluginFixtures(t, filepath.Join(winStaged, "agent-host", "bundled-plugins"), names)
	if err := validateExtractedLayout(winStaged, "windows-amd64"); err != nil {
		t.Fatalf("validateExtractedLayout windows-amd64 failed: %v", err)
	}
	req := HelperRequest{
		Platform:   "windows-amd64",
		TargetPath: filepath.Join(winOld, windowsExeName),
		StagedPath: winStaged,
		BackupPath: filepath.Join(t.TempDir(), "win-backup"),
	}
	if err := SwapInstall(req); err != nil {
		t.Fatalf("Windows SwapInstall with bundled-plugins failed: %v", err)
	}
	for _, name := range names {
		installedPkg := filepath.Join(winOld, "agent-host", "bundled-plugins", name, "package.json")
		if !pathExists(installedPkg) {
			t.Fatalf("missing %s after Windows SwapInstall", installedPkg)
		}
	}
	if err := RestoreBackup(req); err != nil {
		t.Fatalf("Windows RestoreBackup failed: %v", err)
	}

	linuxStaged := filepath.Join(t.TempDir(), "linux-staged")
	linuxFixture(t, linuxStaged, "NEW")
	writeBundledPluginFixtures(t, filepath.Join(linuxStaged, linuxBundleName, "agent-host", "bundled-plugins"), names)
	if err := validateExtractedLayout(linuxStaged, "linux-amd64"); err != nil {
		t.Fatalf("validateExtractedLayout linux-amd64 failed: %v", err)
	}

	darwinStaged := filepath.Join(t.TempDir(), "darwin-staged")
	if err := WriteDarwinLayout(darwinStaged, "NEW"); err != nil {
		t.Fatal(err)
	}
	writeBundledPluginFixtures(t, filepath.Join(darwinStaged, appBundleName, "Contents", "Resources", "agent-host", "bundled-plugins"), names)
	if err := validateExtractedLayout(darwinStaged, "darwin-arm64"); err != nil {
		t.Fatalf("validateExtractedLayout darwin-arm64 failed: %v", err)
	}
}

func TestWindowsLayoutRejectsSubdirectoriesInsidePluginPackages(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "installed")
	staged := filepath.Join(root, "staged")
	if err := WriteWindowsLayout(target, "OLD"); err != nil {
		t.Fatal(err)
	}
	if err := WriteWindowsLayout(staged, "NEW"); err != nil {
		t.Fatal(err)
	}
	badDir := filepath.Join(staged, pluginDirName, "beeftv-plugin-market")
	if err := os.MkdirAll(badDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(badDir, "package.json"), []byte(`{"name":"beeftv-plugin-market"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	err := validateExtractedLayout(staged, "windows-amd64")
	if err == nil || !strings.Contains(err.Error(), "官方插件目录布局无效") {
		t.Fatalf("expected validateExtractedLayout to reject subdirectory inside Windows plugin-packages, got %v", err)
	}
	req := HelperRequest{
		Platform:   "windows-amd64",
		TargetPath: filepath.Join(target, windowsExeName),
		StagedPath: staged,
		BackupPath: filepath.Join(root, "backup"),
	}
	if err := SwapInstall(req); err == nil || !strings.Contains(err.Error(), "官方插件目录布局无效") {
		t.Fatalf("expected SwapInstall to reject subdirectory inside Windows plugin-packages, got %v", err)
	}
	if got, err := os.ReadFile(req.TargetPath); err != nil || string(got) != "MZ-OLD" {
		t.Fatalf("existing install was modified after rejected layout: %q %v", got, err)
	}
}

func TestWindowsRestoreExecutablePreservesTargetWithoutDeletingFirst(t *testing.T) {
	root := t.TempDir()
	targetDir := filepath.Join(root, "installed")
	backupDir := filepath.Join(root, "backup")
	if err := WriteWindowsLayout(targetDir, "NEW"); err != nil {
		t.Fatal(err)
	}
	if err := WriteWindowsLayout(backupDir, "OLD"); err != nil {
		t.Fatal(err)
	}
	targetExe := filepath.Join(targetDir, windowsExeName)
	backupExe := filepath.Join(backupDir, windowsExeName)
	if err := os.Remove(backupExe); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(backupExe, "corrupt"), 0o755); err != nil {
		t.Fatal(err)
	}
	req := HelperRequest{
		Platform:   "windows-amd64",
		TargetPath: targetExe,
		BackupPath: backupDir,
	}
	if err := RestoreBackup(req); err == nil {
		t.Fatal("expected RestoreBackup to fail when backup executable is a directory")
	}
	got, err := os.ReadFile(targetExe)
	if err != nil || string(got) != "MZ-NEW" {
		t.Fatalf("failed restore lost existing executable: got=%q err=%v", got, err)
	}

	if err := os.RemoveAll(backupExe); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backupExe, []byte("MZ-OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := RestoreBackup(req); err != nil {
		t.Fatalf("RestoreBackup failed: %v", err)
	}
	got, err = os.ReadFile(targetExe)
	if err != nil || string(got) != "MZ-OLD" {
		t.Fatalf("restored exe = %q, err = %v", got, err)
	}
	if pathExists(targetExe + ".beeftv-failed") {
		t.Fatal("stale .beeftv-failed file was not cleaned up")
	}
}
