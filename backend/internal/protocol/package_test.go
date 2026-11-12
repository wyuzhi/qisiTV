package protocol

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestParsePluginPackageRejectsBareManifest(t *testing.T) {
	if _, err := ParsePluginPackage([]byte(`{"apiVersion":"qisitv.plugin/v1"}`)); err == nil {
		t.Fatal("bare JSON manifest was accepted as a plugin package")
	}
}

func TestParsePluginPackageRejectsFilesOutsidePackageRoots(t *testing.T) {
	manifest := []byte(`{
		"apiVersion":"qisitv.plugin/v1",
        "id":"ui-extension",
        "name":"UI Extension",
        "version":"1.0.0",
        "contributes":{"canvasNodes":[{"id":"note","type":"note","label":"Note"}]}
    }`)
	if _, err := ParsePluginPackage(zipPluginPackage(t, map[string][]byte{"manifest.json": manifest, "docs/interface.md": []byte("# Note")})); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"web/entry.js", "backend/engine", "server/entry.js"} {
		if _, err := ParsePluginPackage(zipPluginPackage(t, map[string][]byte{"manifest.json": manifest, name: []byte("code")})); err == nil {
			t.Fatalf("package file %s was accepted", name)
		}
	}
}

func TestPluginPackageUsesqisiTVFormat(t *testing.T) {
	if PluginPackageFormat != "qisitv.plugin/package-v1" {
		t.Fatalf("package format = %q", PluginPackageFormat)
	}
}

func TestPluginPackageUsesqisiTVFileExtension(t *testing.T) {
	if PluginPackageExtension != ".qisitv-plugin" {
		t.Fatalf("package extension = %q", PluginPackageExtension)
	}
}

func TestValidateManifestRejectsLegacyNamespace(t *testing.T) {
	manifest := Manifest{}
	manifest.APIVersion = "legacy.plugin/v2"
	manifest.Metadata.ID = "legacy"
	manifest.Metadata.Name = "Legacy"
	manifest.Metadata.Version = "1.0.0"
	if err := ValidateManifest(manifest); err == nil {
		t.Fatal("legacy namespace was accepted")
	}
}

func TestPreRenamePluginPackagesRemainReadable(t *testing.T) {
	manifest := []byte(`{"apiVersion":"beeftv.plugin/v1","id":"legacy-ui","name":"Existing Plugin","version":"1.0.0","contributes":{"canvasNodes":[{"id":"note","type":"note","label":"Note"}]}}`)
	if _, err := ParsePluginPackage(zipPluginPackage(t, map[string][]byte{"manifest.json": manifest})); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"existing.beeftv-plugin", "current.qisitv-plugin"} {
		if !IsPluginPackageName(name) {
			t.Fatalf("existing package ignored: %s", name)
		}
	}
	if IsPluginPackageName("manifest.json") {
		t.Fatal("accepted a bare manifest")
	}
}

func zipPluginPackage(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, data := range files {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestParsePluginPackageDirValidatesPiPackageAndClientCanvasNode(t *testing.T) {
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
	if err := os.WriteFile(filepath.Join(dir, "dist", "client.js"), []byte("export function activate() {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "skills", "storyboard-grid", "SKILL.md"), []byte("# Storyboard Grid\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "extensions", "index.ts"), []byte("export default function() {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# 分镜九宫格插件"), 0o644); err != nil {
		t.Fatal(err)
	}
	packageJSON := []byte(`{
		"name": "@beeftv/plugin-storyboard-grid",
		"version": "1.2.0",
		"description": "分镜九宫格拆解与合成插件",
		"author": {"name": "BeefTV"},
		"pi": {
			"extensions": ["./extensions/index.ts"],
			"skills": ["./skills"]
		},
		"beeftv": {
			"id": "storyboard-grid",
			"displayName": "分镜九宫格",
			"client": "./dist/client.js",
			"contributes": {
				"canvasNodes": [
					{
						"type": "storyboard-grid",
						"title": "分镜九宫格",
						"defaultWidth": 520,
						"defaultHeight": 420,
						"renderer": "client"
					}
				]
			}
		}
	}`)
	if err := os.WriteFile(filepath.Join(dir, "package.json"), packageJSON, 0o644); err != nil {
		t.Fatal(err)
	}

	pkg, err := ParsePluginPackageDir(dir)
	if err != nil {
		t.Fatalf("ParsePluginPackageDir failed: %v", err)
	}
	if pkg.Manifest.Metadata.ID != "storyboard-grid" || pkg.Manifest.Metadata.Name != "分镜九宫格" || pkg.Manifest.Metadata.Version != "1.2.0" {
		t.Fatalf("unexpected manifest metadata: %#v", pkg.Manifest.Metadata)
	}
	if pkg.Manifest.Metadata.Vendor != "BeefTV" || pkg.Manifest.Metadata.Documentation != "# 分镜九宫格插件" {
		t.Fatalf("unexpected vendor/docs: %#v", pkg.Manifest.Metadata)
	}
	if pkg.Manifest.Client != "./dist/client.js" {
		t.Fatalf("client = %q", pkg.Manifest.Client)
	}
	if len(pkg.SkillDirs) != 1 || len(pkg.ExtensionPaths) != 1 || pkg.SHA256 == "" {
		t.Fatalf("unexpected package paths/hash: skills=%v extensions=%v sha256=%q", pkg.SkillDirs, pkg.ExtensionPaths, pkg.SHA256)
	}
	node := pkg.Manifest.Contributes.CanvasNodes[0]
	w, h := node.NodeDimensions()
	if node.NodeType() != "storyboard-grid" || node.NodeLabel() != "分镜九宫格" || w != 520 || h != 420 || node.Renderer != "client" {
		t.Fatalf("unexpected canvas node: %#v", node)
	}
}

func TestValidateManifestClientAndCanvasNodeConstraints(t *testing.T) {
	base := Manifest{
		APIVersion: "beeftv.plugin/v1",
		Metadata:   Metadata{ID: "demo", Name: "Demo", Version: "1.0.0"},
		Contributes: ManifestContributions{
			CanvasNodes: []ManifestCanvasNode{{ID: "demo-node", Label: "Demo", DefaultTitle: "Demo", Renderer: "client"}},
		},
	}
	if err := ValidateManifest(base); err == nil {
		t.Fatal("expected client renderer without manifest.client to fail")
	}

	for _, badClient := range []string{"/abs/client.js", "../escape.js", "node_modules/pkg/index.js", "dist/client.ts"} {
		candidate := base
		candidate.Client = badClient
		if err := ValidateManifest(candidate); err == nil {
			t.Fatalf("expected invalid client path %q to fail", badClient)
		}
	}

	valid := base
	valid.Client = "dist/client.mjs"
	if err := ValidateManifest(valid); err != nil {
		t.Fatalf("expected valid client manifest to pass: %v", err)
	}
}

func TestParsePluginPackageDirAcceptsPlainPiPackage(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "extensions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "extensions", "index.ts"), []byte("export default function() {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	pkgJSON := `{"name":"@someone/pi-web-tools","version":"2.0.0","keywords":["pi-package"],"pi":{"extensions":["./extensions/index.ts"]}}`
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(pkgJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	pkg, err := ParsePluginPackageDir(dir)
	if err != nil {
		t.Fatalf("a pi package without a beeftv field must install: %v", err)
	}
	if pkg.Manifest.Metadata.ID != "someone-pi-web-tools" || pkg.Manifest.Metadata.Version != "2.0.0" || len(pkg.ExtensionPaths) != 1 {
		t.Fatalf("unexpected parse: %#v", pkg.Manifest.Metadata)
	}

	empty := t.TempDir()
	if err := os.WriteFile(filepath.Join(empty, "package.json"), []byte(`{"name":"left-pad","version":"1.0.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ParsePluginPackageDir(empty); err == nil {
		t.Fatal("a package with neither beeftv nor pi resources is not a plugin")
	}
}
