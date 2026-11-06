package plugins

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writePluginFolder(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		target := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestInstallTellsHowToFixEveryOldManifestField(t *testing.T) {
	rt, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(rt, nil)
	svc.SetPackageFetcher(copyPackageFetcher)
	src := t.TempDir()
	writePluginFolder(t, src, map[string]string{
		"client/index.js": "export function activate() {}\n",
		"package.json": `{"name":"beeftv-plugin-old-style","version":"0.1.0","beeftv":{
			"id":"beeftv-plugin-old-style","apiVersion":"beeftv.plugin/v2","client":"./client/index.js",
			"canvasNodes":[{"id":"note"}],
			"contributes":{"skills":["./skills"],"canvasNodes":[{"type":"note","label":"便签","defaultTitle":"便签","defaultWidth":240,"defaultSize":{"width":240,"height":180}}]}}}`,
	})
	_, err = svc.InstallPackage(src, "")
	if err == nil {
		t.Fatal("old manifest writing was installed")
	}
	for _, want := range []string{
		"beeftv.id：插件 ID 取自 package.json 的 name",
		"beeftv.apiVersion：不用写",
		"beeftv.canvasNodes：写在 beeftv.contributes.canvasNodes",
		"beeftv.contributes.skills：技能写在 package.json 的 pi.skills",
		"beeftv.contributes.canvasNodes[0].type：节点类型就是 id",
		"beeftv.contributes.canvasNodes[0].defaultWidth：用 defaultSize",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error does not say %q:\n%s", want, err)
		}
	}
	if _, installed := rt.plugins["beeftv-plugin-old-style"]; installed {
		t.Fatal("rejected package was registered")
	}
}

func TestReinstallFromFolderLoadsChangedCode(t *testing.T) {
	rt, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(rt, nil)
	svc.SetPackageFetcher(copyPackageFetcher)
	src := t.TempDir()
	writePluginFolder(t, src, map[string]string{
		"package.json":    `{"name":"beeftv-plugin-dev-loop","version":"0.1.0","beeftv":{"name":"开发中","client":"./client/index.js"}}`,
		"client/index.js": "export function activate() { return 1 }\n",
	})
	first, err := svc.InstallPackage(src, "")
	if err != nil {
		t.Fatal(err)
	}
	writePluginFolder(t, src, map[string]string{"client/index.js": "export function activate() { return 2 }\n"})
	second, err := svc.UpdatePackage(first.Manifest.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if first.Manifest.Revision == "" || second.Manifest.Revision == first.Manifest.Revision {
		t.Fatalf("revision did not change after reinstalling changed code: %q -> %q", first.Manifest.Revision, second.Manifest.Revision)
	}
	served, err := os.ReadFile(filepath.Join(second.PackageDir, "client", "index.js"))
	if err != nil || !strings.Contains(string(served), "return 2") {
		t.Fatalf("installed client = %q, %v", served, err)
	}

	writePluginFolder(t, src, map[string]string{
		"package.json":    `{"name":"beeftv-plugin-dev-loop","version":"0.1.0","beeftv":{"id":"beeftv-plugin-dev-loop","client":"./client/index.js"}}`,
		"client/index.js": "export function activate() { return 3 }\n",
	})
	if _, err := svc.UpdatePackage(first.Manifest.ID, ""); err == nil {
		t.Fatal("reload with an old manifest key succeeded")
	}
	var kept View
	for _, view := range svc.List() {
		if view.Manifest.ID == first.Manifest.ID {
			kept = view
		}
	}
	if kept.Manifest.Revision != second.Manifest.Revision {
		t.Fatalf("failed reload replaced the installed plugin: %+v", kept.Manifest)
	}
	served, err = os.ReadFile(filepath.Join(kept.PackageDir, "client", "index.js"))
	if err != nil || !strings.Contains(string(served), "return 2") {
		t.Fatalf("installed client after failed reload = %q, %v", served, err)
	}
}
