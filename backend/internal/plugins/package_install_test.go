package plugins

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/canvas/capability"
)

func writeSamplePluginDir(t *testing.T, version string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "skills", "storyboard-grid"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "extensions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "dist", "client.js"), []byte("export function activate(ctx) {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "skills", "storyboard-grid", "SKILL.md"), []byte("---\nname: 分镜九宫格\ndescription: 拆解九宫格\n---\n# 分镜九宫格\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "extensions", "index.ts"), []byte("export default function() {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	pkgJSON := `{
		"name": "@beeftv/plugin-storyboard-grid-test",
		"version": "` + version + `",
		"description": "测试分镜九宫格插件",
		"author": "BeefTV",
		"pi": {
			"extensions": ["./extensions/index.ts"],
			"skills": ["./skills"]
		},
		"beeftv": {
			"id": "storyboard-grid-test",
			"displayName": "分镜九宫格测试",
			"client": "./dist/client.js",
			"contributes": {
				"canvasNodes": [
					{
						"type": "storyboard-grid-test",
						"title": "分镜九宫格测试",
						"defaultWidth": 520,
						"defaultHeight": 420,
						"renderer": "client"
					}
				]
			}
		}
	}`
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(pkgJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestPackageInstallLifecycleCanvasSyncAndSkillHook(t *testing.T) {
	dataDir := t.TempDir()
	rt, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatalf("NewRuntime failed: %v", err)
	}
	defer capability.BuiltinRegistry().ResetPluginDescriptors()

	svc := New(rt, nil)
	syncedSkills := map[string]bool{}
	svc.SetSkillSyncHook(func(pluginID, pluginName, version string, skillDirs []string, enabled bool) {
		if enabled && len(skillDirs) > 0 {
			syncedSkills[pluginID] = true
		} else {
			delete(syncedSkills, pluginID)
		}
	})

	srcDir := writeSamplePluginDir(t, "1.0.0")
	view, err := svc.InstallPackageFromDir(srcDir, srcDir)
	if err != nil {
		t.Fatalf("InstallPackageFromDir failed: %v", err)
	}
	if view.Manifest.ID != "storyboard-grid-test" || view.Status != StatusEnabled || view.Source != OriginPackage {
		t.Fatalf("unexpected installed view: %#v", view)
	}
	if !syncedSkills["storyboard-grid-test"] {
		t.Fatal("expected skill sync hook to be called with enabled=true")
	}
	if _, ok := capability.BuiltinRegistry().Resolve("storyboard-grid-test"); !ok {
		t.Fatal("expected storyboard-grid-test canvas node descriptor to be registered")
	}
	enabledPkgs := svc.EnabledPackages()
	foundEnabled := false
	for _, p := range enabledPkgs {
		if p.ID == "storyboard-grid-test" && p.Client == "./dist/client.js" {
			foundEnabled = true
		}
	}
	if !foundEnabled {
		t.Fatalf("expected storyboard-grid-test in EnabledPackages, got %#v", enabledPkgs)
	}

	resolvedPath, mimeType, err := svc.ResolvePackageFile("storyboard-grid-test", "dist/client.js")
	if err != nil || resolvedPath == "" || mimeType != "application/javascript; charset=utf-8" {
		t.Fatalf("ResolvePackageFile failed: path=%q mime=%q err=%v", resolvedPath, mimeType, err)
	}
	if _, _, err := svc.ResolvePackageFile("storyboard-grid-test", "../escape.js"); err == nil {
		t.Fatal("expected path traversal to be rejected")
	}
	if _, _, err := svc.ResolvePackageFile("storyboard-grid-test", "extensions/index.ts"); err == nil {
		t.Fatal("expected non-web file extension .ts to be rejected")
	}

	disabledView, err := svc.SetEnabled("storyboard-grid-test", false)
	if err != nil || disabledView.Status != StatusDisabled {
		t.Fatalf("SetEnabled(false) failed: %#v, err=%v", disabledView, err)
	}
	if _, ok := capability.BuiltinRegistry().Resolve("storyboard-grid-test"); ok {
		t.Fatal("expected canvas node descriptor to be removed when plugin is disabled")
	}
	if syncedSkills["storyboard-grid-test"] {
		t.Fatal("expected skill hook to remove skills when plugin is disabled")
	}

	if _, err := svc.SetEnabled("storyboard-grid-test", true); err != nil {
		t.Fatalf("SetEnabled(true) failed: %v", err)
	}
	invalidView, err := svc.SetLoadError("storyboard-grid-test", "Extension syntax error")
	if err != nil || invalidView.Status != StatusInvalid || invalidView.Error != "Extension syntax error" {
		t.Fatalf("SetLoadError failed: %#v, err=%v", invalidView, err)
	}
	if _, ok := capability.BuiltinRegistry().Resolve("storyboard-grid-test"); ok {
		t.Fatal("expected canvas node descriptor to be removed when plugin enters StatusInvalid")
	}

	if err := svc.Uninstall("storyboard-grid-test"); err != nil {
		t.Fatalf("Uninstall failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "plugins", "storyboard-grid-test")); !os.IsNotExist(err) {
		t.Fatalf("expected installed package dir to be removed on uninstall, err=%v", err)
	}
}

func TestInstallPackageFromTarGzArchive(t *testing.T) {
	dataDir := t.TempDir()
	rt, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer capability.BuiltinRegistry().ResetPluginDescriptors()
	svc := New(rt, nil)

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	files := map[string]string{
		"package/package.json": `{
			"name": "@beeftv/plugin-archive-demo",
			"version": "1.0.0",
			"description": "Archive demo",
			"beeftv": {
				"id": "archive-demo",
				"name": "Archive Demo",
				"client": "./dist/client.js"
			}
		}`,
		"package/dist/client.js": "export function activate() {}",
	}
	for name, content := range files {
		hdr := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(content))}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	_ = tw.Close()
	_ = gz.Close()

	view, err := svc.InstallPackageFromArchive(buf.Bytes(), "archive-demo-1.0.0.tgz")
	if err != nil {
		t.Fatalf("InstallPackageFromArchive failed: %v", err)
	}
	if view.Manifest.ID != "archive-demo" || view.Status != StatusEnabled {
		t.Fatalf("unexpected view: %#v", view)
	}
}
