package plugins

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/canvas/capability"
	"infinite-canvas/backend/internal/protocol"
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
	svc.SetPackageFetcher(copyPackageFetcher)
	syncedSkills := map[string]bool{}
	svc.SetSkillSyncHook(func(pluginID, pluginName, version string, skillDirs []string, enabled bool) {
		if enabled && len(skillDirs) > 0 {
			syncedSkills[pluginID] = true
		} else {
			delete(syncedSkills, pluginID)
		}
	})

	srcDir := writeSamplePluginDir(t, "1.0.0")
	view, err := svc.InstallPackage(srcDir, "")
	if err != nil {
		t.Fatalf("InstallPackage failed: %v", err)
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

// copyPackageFetcher stands in for npm: it lays the package out exactly where
// `npm install --prefix` would.
func copyPackageFetcher(_ context.Context, spec, _ string, prefixDir string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(spec, "package.json"))
	if err != nil {
		return "", err
	}
	var pkg struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		return "", err
	}
	root := filepath.Join(prefixDir, "node_modules", filepath.FromSlash(pkg.Name))
	if err := os.CopyFS(root, os.DirFS(spec)); err != nil {
		return "", err
	}
	return root, nil
}

func TestInstallPackageReplacesPreviousVersionAndKeepsItOnFailure(t *testing.T) {
	rt, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer capability.BuiltinRegistry().ResetPluginDescriptors()
	svc := New(rt, nil)
	svc.SetPackageFetcher(copyPackageFetcher)
	if _, err := svc.InstallPackage(writeSamplePluginDir(t, "1.0.0"), ""); err != nil {
		t.Fatal(err)
	}
	updated, err := svc.InstallPackage(writeSamplePluginDir(t, "1.1.0"), "")
	if err != nil || updated.Manifest.Version != "1.1.0" {
		t.Fatalf("update: %#v err=%v", updated.Manifest, err)
	}
	broken := writeSamplePluginDir(t, "1.2.0")
	if err := os.Remove(filepath.Join(broken, "dist", "client.js")); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.InstallPackage(broken, ""); err == nil {
		t.Fatal("expected a package with a missing client entry to be rejected")
	}
	var current EnabledPackageView
	for _, item := range svc.EnabledPackages() {
		if item.ID == "storyboard-grid-test" {
			current = item
		}
	}
	if current.Version != "1.1.0" {
		t.Fatalf("expected 1.1.0 to stay installed, got %#v", current)
	}
	if _, err := os.Stat(filepath.Join(current.PackageDir, "dist", "client.js")); err != nil {
		t.Fatalf("installed files of 1.1.0 must survive a failed update: %v", err)
	}
}

func TestPlainPiPackageListsEmptyPermissions(t *testing.T) {
	rt, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer capability.BuiltinRegistry().ResetPluginDescriptors()
	svc := New(rt, nil)
	svc.SetPackageFetcher(copyPackageFetcher)
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "extensions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "extensions", "index.js"), []byte("export default function () {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	pkg := `{"name":"plain-pi-tools","version":"1.0.0","pi":{"extensions":["./extensions/index.js"]}}`
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(pkg), 0o644); err != nil {
		t.Fatal(err)
	}
	view, err := svc.InstallPackage(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(view.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Permissions *[]string `json:"permissions"`
	}
	if err := json.Unmarshal(encoded, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Permissions == nil || len(*manifest.Permissions) != 0 {
		t.Fatalf("plain pi package must list permissions as [], got %s", encoded)
	}
}

func TestMarketKeepsInstalledRecommendedPluginRecommended(t *testing.T) {
	curated := []MarketPluginItem{{ID: "sticky", Version: "0.2.0", Recommended: true, Bundled: true, Installed: true, Enabled: true}}
	local := []MarketPluginItem{{ID: "sticky", Version: "0.1.0", Installed: true, Enabled: true}, {ID: "side-loaded", Installed: true}}
	merged := mergeMarketItems(curated, nil, local)
	if len(merged) != 2 {
		t.Fatalf("expected each plugin once, got %#v", merged)
	}
	if got := merged[0]; got.ID != "sticky" || !got.Recommended || !got.Bundled || !got.Installed || got.Version != "0.2.0" {
		t.Fatalf("installed recommended plugin lost its market entry: %#v", got)
	}
	if merged[1].ID != "side-loaded" || !merged[1].Installed {
		t.Fatalf("installed plugin missing from every source must still be listed: %#v", merged[1])
	}
}

func TestInstallPackageRejectsUnknownRegistry(t *testing.T) {
	rt, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(rt, nil)
	svc.SetPackageFetcher(copyPackageFetcher)
	if _, err := svc.InstallPackage(writeSamplePluginDir(t, "1.0.0"), "https://registry.example.com"); err == nil {
		t.Fatal("expected registries outside the market choices to be rejected")
	}
}

// TestNpmPackageFetcherInstallsLocalDirectory runs the real npm argument list.
func TestNpmPackageFetcherInstallsLocalDirectory(t *testing.T) {
	if _, err := exec.LookPath("npm"); err != nil {
		t.Skip("npm is not on PATH")
	}
	src := writeSamplePluginDir(t, "1.0.0")
	prefix := t.TempDir()
	root, err := NpmPackageFetcher(nil)(context.Background(), src, NpmjsRegistry, prefix)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(root)
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("expected a copied package directory, got %v err=%v", info, err)
	}
	if _, err := os.Stat(filepath.Join(root, "dist", "client.js")); err != nil {
		t.Fatalf("expected package files to be installed: %v", err)
	}
}

// startMovingRegistry serves one package whose latest version the test can move,
// in the packument and tarball shape npm reads from a real registry.
func startMovingRegistry(t *testing.T, name string) (string, func(version string)) {
	t.Helper()
	var mu sync.Mutex
	latest := "1.0.0"
	tarball := func(version string) []byte {
		body := []byte(fmt.Sprintf(`{"name":%q,"version":%q}`, name, version))
		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		tw := tar.NewWriter(gz)
		_ = tw.WriteHeader(&tar.Header{Name: "package/package.json", Mode: 0o644, Size: int64(len(body))})
		_, _ = tw.Write(body)
		_ = tw.Close()
		_ = gz.Close()
		return buf.Bytes()
	}
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if strings.HasSuffix(r.URL.Path, ".tgz") {
			_, _ = w.Write(tarball(strings.TrimSuffix(strings.TrimPrefix(path.Base(r.URL.Path), name+"-"), ".tgz")))
			return
		}
		versions := map[string]any{}
		for _, version := range []string{"1.0.0", latest} {
			sum := sha512.Sum512(tarball(version))
			versions[version] = map[string]any{"name": name, "version": version, "dist": map[string]any{
				"tarball":   fmt.Sprintf("%s/%s/-/%s-%s.tgz", server.URL, name, name, version),
				"integrity": "sha512-" + base64.StdEncoding.EncodeToString(sum[:]),
			}}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"name": name, "dist-tags": map[string]string{"latest": latest}, "versions": versions})
	}))
	t.Cleanup(server.Close)
	return server.URL, func(version string) { mu.Lock(); latest = version; mu.Unlock() }
}

// Update reinstalls the bare package name; a warm npm cache must not pin it to
// the version an earlier install saw.
func TestNpmPackageFetcherSeesNewVersionDespiteWarmCache(t *testing.T) {
	if _, err := exec.LookPath("npm"); err != nil {
		t.Skip("npm is not on PATH")
	}
	t.Setenv("npm_config_cache", t.TempDir())
	const name = "beeftv-plugin-moving"
	registry, publish := startMovingRegistry(t, name)
	installedVersion := func() string {
		t.Helper()
		root, err := NpmPackageFetcher(nil)(context.Background(), name, registry, t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(filepath.Join(root, "package.json"))
		if err != nil {
			t.Fatal(err)
		}
		var pkg struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal(raw, &pkg); err != nil {
			t.Fatal(err)
		}
		return pkg.Version
	}
	if got := installedVersion(); got != "1.0.0" {
		t.Fatalf("first install got %s, want 1.0.0", got)
	}
	publish("1.0.1")
	if got := installedVersion(); got != "1.0.1" {
		t.Fatalf("install after publishing 1.0.1 got %s; the npm cache pinned the old version", got)
	}
}

func TestBuiltinLL2PluginPreinstalledAndRegistersProviders(t *testing.T) {
	dataDir := t.TempDir()
	rt, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatalf("NewRuntime failed: %v", err)
	}
	defer capability.BuiltinRegistry().ResetPluginDescriptors()
	svc := New(rt, nil)

	view, ok := ByID(svc.List(), "beeftv-plugin-ll2")
	if !ok {
		t.Fatal("expected beeftv-plugin-ll2 to be pre-installed by default")
	}
	if view.Status != StatusEnabled || view.Source != OriginOfficial {
		t.Fatalf("unexpected beeftv-plugin-ll2 view: status=%q source=%q", view.Status, view.Source)
	}
	if view.Management.ConfigurationScope != ConfigurationUser || view.Management.ActivationScope != ScopeSystem {
		t.Fatalf("expected ScopeSystem/ConfigurationUser for beeftv-plugin-ll2, got activation=%q config=%q", view.Management.ActivationScope, view.Management.ConfigurationScope)
	}

	reg := svc.Registry()
	cases := []struct {
		providerID   string
		req          protocol.GenerationRequest
		wantPath     string
		wantPollPath string
		createJSON   string
		wantTaskID   string
		pollJSON     string
	}{
		{
			providerID:   "ll2-seedance-video",
			req:          protocol.GenerationRequest{Model: "doubao-seedance-2-0-fast", Prompt: "hello", Duration: 4, AspectRatio: "16:9", Resolution: "720p"},
			wantPath:     "/seedance/api/v3/contents/generations/tasks",
			wantPollPath: "/seedance/api/v3/contents/generations/tasks/cgt-1",
			createJSON:   `{"id":"cgt-1","status":"queued"}`,
			wantTaskID:   "cgt-1",
			pollJSON:     `{"id":"cgt-1","status":"succeeded","content":{"video_url":"https://cdn.example.com/a.mp4"}}`,
		},
		{
			providerID:   "ll2-vidu-video",
			req:          protocol.GenerationRequest{Model: "viduq3-turbo", Prompt: "hello", Duration: 5, AspectRatio: "16:9", Resolution: "720p"},
			wantPath:     "/vidu/ent/v2/text2video",
			wantPollPath: "/vidu/ent/v2/tasks/vidu-1/creations",
			createJSON:   `{"task_id":"vidu-1","state":"created"}`,
			wantTaskID:   "vidu-1",
			pollJSON:     `{"id":"vidu-1","state":"success","creations":[{"url":"https://cdn.example.com/b.mp4"}]}`,
		},
		{
			providerID:   "ll2-minimax-video",
			req:          protocol.GenerationRequest{Model: "MiniMax-H3", Prompt: "hello", Duration: 5, AspectRatio: "16:9", Resolution: "720P"},
			wantPath:     "/v2/video_generation",
			wantPollPath: "/v2/query/video_generation/mm-1",
			createJSON:   `{"task_id":"mm-1","base_resp":{"status_code":0,"status_msg":"success"}}`,
			wantTaskID:   "mm-1",
			pollJSON:     `{"task_id":"mm-1","status":"Success","video_url":"https://cdn.example.com/c.mp4"}`,
		},
		{
			providerID:   "ll2-super-vega-video",
			req:          protocol.GenerationRequest{Model: "1.0-pro-mini", Prompt: "hello", Duration: 4, AspectRatio: "16:9", Resolution: "720P"},
			wantPath:     "/super-vega/tasks",
			wantPollPath: "/super-vega/tasks/sv-1",
			createJSON:   `{"Response":{"TaskId":"sv-1","RequestId":"req-1"}}`,
			wantTaskID:   "sv-1",
			pollJSON:     `{"Response":{"Status":"FINISH","AigcVideoTask":{"TaskId":"sv-1","Output":{"FileInfos":[{"FileUrl":"https://cdn.example.com/d.mp4"}]}}}}`,
		},
		{
			providerID:   "ll2-auto-hd-video",
			req:          protocol.GenerationRequest{Model: "auto-hd", Videos: []protocol.MediaReference{{URL: "https://cdn.example.com/src.mp4"}}, Resolution: "1080p"},
			wantPath:     "/hd/tasks",
			wantPollPath: "/hd/tasks/hd-1",
			createJSON:   `{"task_id":"hd-1","status":"created"}`,
			wantTaskID:   "hd-1",
			pollJSON:     `{"task_id":"hd-1","status":"finished","url":"https://cdn.example.com/e.mp4"}`,
		},
	}
	for _, tc := range cases {
		adapter, resolved := reg.Resolve(tc.providerID)
		if !resolved {
			t.Fatalf("expected provider %q from beeftv-plugin-ll2 to be registered in protocol registry", tc.providerID)
		}
		reqCtx := protocol.RequestContext{
			BaseURL: "https://api.ll2.cn",
			Request: tc.req,
		}
		spec, err := adapter.BuildCreate(context.Background(), reqCtx)
		if err != nil {
			t.Fatalf("BuildCreate(%s) failed: %v", tc.providerID, err)
		}
		if spec.Path != tc.wantPath {
			t.Fatalf("BuildCreate(%s) path = %q, want %q", tc.providerID, spec.Path, tc.wantPath)
		}
		if spec.Body == nil {
			t.Fatalf("BuildCreate(%s) produced nil body", tc.providerID)
		}
		created, err := adapter.ParseCreate(context.Background(), []byte(tc.createJSON))
		if err != nil {
			t.Fatalf("ParseCreate(%s) failed: %v", tc.providerID, err)
		}
		if created.TaskID != tc.wantTaskID {
			t.Fatalf("ParseCreate(%s) TaskID = %q, want %q", tc.providerID, created.TaskID, tc.wantTaskID)
		}
		pollCtx := protocol.PollContext{
			BaseURL: "https://api.ll2.cn",
			Model:   tc.req.Model,
			Request: tc.req,
			TaskID:  created.TaskID,
		}
		pollSpec, err := adapter.BuildPoll(context.Background(), pollCtx)
		if err != nil {
			t.Fatalf("BuildPoll(%s) failed: %v", tc.providerID, err)
		}
		if pollSpec.Path != tc.wantPollPath {
			t.Fatalf("BuildPoll(%s) path = %q, want %q", tc.providerID, pollSpec.Path, tc.wantPollPath)
		}
		polled, err := adapter.ParsePoll(context.Background(), pollCtx, []byte(tc.pollJSON))
		if err != nil {
			t.Fatalf("ParsePoll(%s) failed: %v", tc.providerID, err)
		}
		if polled.TaskID != tc.wantTaskID {
			t.Fatalf("ParsePoll(%s) TaskID = %q, want %q", tc.providerID, polled.TaskID, tc.wantTaskID)
		}
		if polled.Status != protocol.StatusSucceeded || len(polled.Result.Videos) != 1 {
			t.Fatalf("ParsePoll(%s) unexpected result: status=%q videos=%v", tc.providerID, polled.Status, polled.Result.Videos)
		}
	}
}

