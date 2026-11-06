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
	"time"

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
		"name": "storyboard-grid-test",
		"version": "` + version + `",
		"description": "测试分镜九宫格插件",
		"author": "BeefTV",
		"pi": {
			"extensions": ["./extensions/index.ts"],
			"skills": ["./skills"]
		},
		"beeftv": {
			"name": "分镜九宫格测试",
			"client": "./dist/client.js",
			"contributes": {
				"canvasNodes": [
					{
						"id": "storyboard-grid-test",
						"label": "分镜九宫格测试",
						"defaultTitle": "分镜九宫格测试",
						"defaultSize": { "width": 520, "height": 420 },
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
// `npm install --prefix` would, supporting both directories and .tgz archives.
func copyPackageFetcher(_ context.Context, spec, _ string, prefixDir string) (string, error) {
	srcDir := spec
	if strings.HasSuffix(strings.ToLower(spec), ".tgz") || strings.HasSuffix(strings.ToLower(spec), ".tar.gz") {
		unpacked, err := unpackTarballToDir(spec, prefixDir)
		if err != nil {
			return "", err
		}
		srcDir = unpacked
	}
	raw, err := os.ReadFile(filepath.Join(srcDir, "package.json"))
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
	if err := os.CopyFS(root, os.DirFS(srcDir)); err != nil {
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

func readBundledPluginManifestForTest(t *testing.T, repoPluginPackages string) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(repoPluginPackages, "bundled-plugin-dirs.txt"))
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
	return names
}

func copyTreeForTest(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.WalkDir(src, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
	if err != nil {
		t.Fatalf("copy %s -> %s: %v", src, dst, err)
	}
}

func TestBundledPluginDirsManifestAndDesktopAgentHostResolution(t *testing.T) {
	repoPluginPackages, err := filepath.Abs(filepath.Join("..", "..", "..", "plugin-packages"))
	if err != nil {
		t.Fatal(err)
	}
	names := readBundledPluginManifestForTest(t, repoPluginPackages)
	wantNames := map[string]bool{
		"beeftv-plugin-market": false,
		"beeftv-plugin-ll2":    false,
	}
	for _, name := range names {
		if !wantNames[name] && name != "beeftv-plugin-market" && name != "beeftv-plugin-ll2" {
			t.Fatalf("bundled-plugin-dirs.txt must only contain built-in default plugins, got unexpected %q", name)
		}
		wantNames[name] = true
		if _, err := protocol.ParsePluginPackageDir(filepath.Join(repoPluginPackages, name)); err != nil {
			t.Fatalf("bundled plugin %s invalid: %v", name, err)
		}
	}
	for name, seen := range wantNames {
		if !seen {
			t.Fatalf("bundled-plugin-dirs.txt missing required directory %s (got %v)", name, names)
		}
	}

	for _, tc := range []struct {
		gp        string
		execRel   string
		agentHost string
		nodeRel   string
	}{
		{gp: "windows", execRel: "BeefTV.exe", agentHost: "agent-host", nodeRel: filepath.Join("runtime", "node.exe")},
		{gp: "linux", execRel: "BeefTV", agentHost: "agent-host", nodeRel: filepath.Join("runtime", "bin", "node")},
		{gp: "darwin", execRel: filepath.Join("BeefTV.app", "Contents", "MacOS", "BeefTV"), agentHost: filepath.Join("BeefTV.app", "Contents", "Resources", "agent-host"), nodeRel: filepath.Join("runtime", "bin", "node")},
	} {
		t.Run(tc.gp, func(t *testing.T) {
			bundleRoot := t.TempDir()
			execPath := filepath.Join(bundleRoot, tc.execRel)
			if err := os.MkdirAll(filepath.Dir(execPath), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(execPath, []byte("exe"), 0o755); err != nil {
				t.Fatal(err)
			}
			agentHostDir := filepath.Join(bundleRoot, tc.agentHost)
			for _, hostFile := range []string{"server.mjs", tc.nodeRel} {
				full := filepath.Join(agentHostDir, hostFile)
				if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(full, []byte("fixture"), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			bundledPluginsRoot := filepath.Join(agentHostDir, "bundled-plugins")
			for _, name := range names {
				copyTreeForTest(t, filepath.Join(repoPluginPackages, name), filepath.Join(bundledPluginsRoot, name))
			}

			// Simulate a desktop install where plugin-packages contains only flat *.beeftv-plugin files.
			flatOfficialDir := t.TempDir()
			entries, err := os.ReadDir(repoPluginPackages)
			if err != nil {
				t.Fatal(err)
			}
			copiedArchive := false
			for _, entry := range entries {
				if !entry.IsDir() && strings.HasSuffix(entry.Name(), protocol.PluginPackageExtension) {
					data, err := os.ReadFile(filepath.Join(repoPluginPackages, entry.Name()))
					if err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(filepath.Join(flatOfficialDir, entry.Name()), data, 0o644); err != nil {
						t.Fatal(err)
					}
					copiedArchive = true
					break
				}
			}
			if !copiedArchive {
				t.Fatal("no *.beeftv-plugin archive found in plugin-packages")
			}
			t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", flatOfficialDir)

			prevExec, prevGOOS := runtimeExecutable, runtimeGOOS
			runtimeExecutable = func() (string, error) { return execPath, nil }
			runtimeGOOS = tc.gp
			t.Cleanup(func() {
				runtimeExecutable = prevExec
				runtimeGOOS = prevGOOS
			})

			for _, nonBundled := range []string{
				"beeftv-plugin-slot-test",
				"beeftv-plugin-character-replacement",
				"beeftv-plugin-sticky-note",
				"beeftv-plugin-ecommerce-hero",
			} {
				if _, ok := BundledSampleDir(nonBundled); ok {
					t.Fatalf("%s must not resolve as a bundled desktop plugin", nonBundled)
				}
			}

			dataDir := t.TempDir()
			rt, err := NewRuntime(dataDir)
			if err != nil {
				t.Fatalf("NewRuntime: %v", err)
			}
			defer capability.BuiltinRegistry().ResetPluginDescriptors()
			svc := New(rt, nil)
			svc.SetPackageFetcher(copyPackageFetcher)

			for _, builtinID := range []string{"beeftv-plugin-market", "beeftv-plugin-ll2"} {
				builtinView, found := ByID(svc.List(), builtinID)
				if !found {
					t.Fatalf("%s was not loaded from agent-host/bundled-plugins", builtinID)
				}
				if builtinView.Status != StatusEnabled || builtinView.Source != OriginOfficial {
					t.Fatalf("unexpected %s view: %+v", builtinID, builtinView)
				}
				clientFile, contentType, err := svc.ResolvePackageFile(builtinID, "client/index.js")
				if err != nil {
					t.Fatalf("ResolvePackageFile for %s failed: %v", builtinID, err)
				}
				if !strings.HasPrefix(clientFile, bundledPluginsRoot) || !strings.Contains(contentType, "javascript") {
					t.Fatalf("unexpected resolved %s file %s (%s)", builtinID, clientFile, contentType)
				}
			}

			// Cancel context so readCuratedRegistry immediately uses the bundled offline registry.json.
			offlineCtx, cancel := context.WithCancel(context.Background())
			cancel()
			curated := loadCuratedRegistryItems(offlineCtx, "", map[string]View{})
			if len(curated) != 1 || curated[0].ID != "beeftv-plugin-character-replacement" {
				t.Fatalf("expected curated registry to list only beeftv-plugin-character-replacement, got %+v", curated)
			}
			if curated[0].Bundled {
				t.Fatalf("market plugin %s must not be marked Bundled=true", curated[0].ID)
			}
		})
	}
}

func packDirectoryToTarGzForTest(t *testing.T, srcDir string) ([]byte, string) {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	err := filepath.WalkDir(srcDir, func(fullPath string, d os.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return walkErr
		}
		rel, err := filepath.Rel(srcDir, fullPath)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(fullPath)
		if err != nil {
			return err
		}
		hdr := &tar.Header{
			Name: "package/" + filepath.ToSlash(rel),
			Mode: 0o644,
			Size: int64(len(data)),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		_, err = tw.Write(data)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	sum := pluginHash(raw)
	return raw, sum
}

func TestMarketChinaMirrorSearchReadmeAndOnlineTarballInstall(t *testing.T) {
	prevAllowLoopback := allowLoopbackMarketURLsForTest
	allowLoopbackMarketURLsForTest = true
	t.Cleanup(func() {
		allowLoopbackMarketURLsForTest = prevAllowLoopback
		curatedRegistryMemCache.Lock()
		curatedRegistryMemCache.raw = nil
		curatedRegistryMemCache.fetchedAt = time.Time{}
		curatedRegistryMemCache.Unlock()
	})

	// Verify SSRF / outbound host allowlist blocks unauthorized hosts and metadata IPs.
	if _, err := validateMarketOutboundURL(context.Background(), "http://169.254.169.254/latest/meta-data/"); err == nil {
		t.Fatal("expected metadata IP to be rejected by validateMarketOutboundURL")
	}
	if _, err := validateMarketOutboundURL(context.Background(), "https://evil.example.com/plugin.tgz"); err == nil {
		t.Fatal("expected non-allowlisted host to be rejected by validateMarketOutboundURL")
	}

	// Verify tar-slip and symlink entries are rejected by unpackTarballToDir.
	for _, badTarCase := range []struct {
		name string
		hdr  *tar.Header
	}{
		{name: "tar-slip", hdr: &tar.Header{Name: "../escape.js", Typeflag: tar.TypeReg, Mode: 0o644, Size: 2}},
		{name: "symlink", hdr: &tar.Header{Name: "package/link.js", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}},
	} {
		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		tw := tar.NewWriter(gz)
		if err := tw.WriteHeader(badTarCase.hdr); err != nil {
			t.Fatal(err)
		}
		if badTarCase.hdr.Size > 0 {
			_, _ = tw.Write([]byte("hi"))
		}
		_ = tw.Close()
		_ = gz.Close()
		badTgz := filepath.Join(t.TempDir(), "bad.tgz")
		if err := os.WriteFile(badTgz, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := unpackTarballToDir(badTgz, t.TempDir()); err == nil {
			t.Fatalf("expected unpackTarballToDir to reject %s archive", badTarCase.name)
		}
	}

	repoPluginPackages, err := filepath.Abs(filepath.Join("..", "..", "..", "plugin-packages"))
	if err != nil {
		t.Fatal(err)
	}
	charPluginDir := filepath.Join(repoPluginPackages, "beeftv-plugin-character-replacement")
	tgzBytes, tgzSHA256 := packDirectoryToTarGzForTest(t, charPluginDir)

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/-/v1/search"):
			text := r.URL.Query().Get("text")
			if strings.Contains(text, "keywords:") {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"objects":[],"total":0}`))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"objects": [
					{
						"package": {
							"name": "beeftv-plugin-character-replacement",
							"version": "0.1.0",
							"description": "AI 角色替换工作室",
							"keywords": ["beeftv-plugin", "pi-package", "character-replacement"],
							"links": {"repository": "https://github.com/Sunnyender-org/beeftv-plugins"},
							"publisher": {"username": "beeftv"}
						}
					},
					{
						"package": {
							"name": "unrelated-package",
							"version": "1.0.0",
							"description": "not a plugin",
							"keywords": ["other"]
						}
					}
				]
			}`))
		case r.URL.Path == "/packages/beeftv-plugin-character-replacement-0.1.0.tgz":
			w.Header().Set("Content-Type", "application/gzip")
			_, _ = w.Write(tgzBytes)
		case r.URL.Path == "/readme/README.md":
			w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
			_, _ = w.Write([]byte("# AI 角色替换工作室（远程镜像 README）\n\n支持双阶段角色替换与时间轴回插。"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	dataDir := t.TempDir()
	rt, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatalf("NewRuntime: %v", err)
	}
	defer capability.BuiltinRegistry().ResetPluginDescriptors()
	svc := New(rt, nil)
	svc.SetPackageFetcher(copyPackageFetcher)

	cachePath := filepath.Join(dataDir, "plugins", "market-registry-cache.json")
	writeRegistryCacheWithSHA := func(sha string) {
		raw := fmt.Sprintf(`{
			"schemaVersion": 1,
			"plugins": [
				{
					"id": "beeftv-plugin-character-replacement",
					"packageName": "beeftv-plugin-character-replacement",
					"name": "AI 角色替换工作室",
					"version": "0.1.0",
					"description": "二阶段角色替换",
					"author": "BeefTV",
					"category": "短剧与视频创作",
					"recommended": true,
					"repo": "https://github.com/Sunnyender-org/beeftv-plugins/tree/main/plugins/beeftv-plugin-character-replacement",
					"readme": %q,
					"mirrorTarball": %q,
					"sha256": %q,
					"tags": ["角色替换"]
				}
			]
		}`, server.URL+"/readme/README.md", server.URL+"/packages/beeftv-plugin-character-replacement-0.1.0.tgz", sha)
		saveCuratedRegistryCache(cachePath, []byte(raw))
		curatedRegistryMemCache.Lock()
		curatedRegistryMemCache.raw = []byte(raw)
		curatedRegistryMemCache.fetchedAt = time.Now()
		curatedRegistryMemCache.Unlock()
	}

	// 1. Test npmmirror plain-text search & Go-side keyword filtering
	npmHits, ok := searchSingleNpmRegistry(context.Background(), server.URL+"/npmmirror.com", "角色", map[string]View{})
	if !ok || len(npmHits) != 1 || npmHits[0].ID != "beeftv-plugin-character-replacement" {
		t.Fatalf("expected npmmirror search to return beeftv-plugin-character-replacement and filter out unrelated-package, got ok=%v hits=%+v", ok, npmHits)
	}

	// 2. Test remote README fetching via FetchMarketReadme before plugin is installed
	writeRegistryCacheWithSHA(tgzSHA256)
	readmeText, err := svc.FetchMarketReadme(context.Background(), "beeftv-plugin-character-replacement", NpmMirrorRegistry)
	if err != nil || !strings.Contains(readmeText, "远程镜像 README") {
		t.Fatalf("expected FetchMarketReadme to return remote README text, got err=%v text=%q", err, readmeText)
	}

	// 3. Test curated-ID install rejects mismatched SHA-256
	writeRegistryCacheWithSHA("0000000000000000000000000000000000000000000000000000000000000000")
	if _, err := svc.InstallPackage("beeftv-plugin-character-replacement", NpmMirrorRegistry); err == nil {
		t.Fatal("expected curated install with mismatched SHA-256 to fail")
	}

	// 4. Test curated-ID install succeeds when SHA-256 matches
	writeRegistryCacheWithSHA(tgzSHA256)
	installedView, err := svc.InstallPackage("beeftv-plugin-character-replacement", NpmMirrorRegistry)
	if err != nil {
		t.Fatalf("curated online install by ID failed: %v", err)
	}
	if installedView.Manifest.ID != "beeftv-plugin-character-replacement" || installedView.Status != StatusEnabled {
		t.Fatalf("unexpected installed plugin view: %+v", installedView)
	}

	// 5. Test direct URL with query parameters (&) and #sha256= fragment
	presignedURL := server.URL + "/packages/beeftv-plugin-character-replacement-0.1.0.tgz?X-Amz-Credential=abc&X-Amz-Signature=def#sha256=" + tgzSHA256
	reinstalledView, err := svc.InstallPackage(presignedURL, NpmMirrorRegistry)
	if err != nil || reinstalledView.Manifest.ID != "beeftv-plugin-character-replacement" {
		t.Fatalf("presigned URL with '&' and #sha256= failed: %v", err)
	}

	// 6. Test versioned curated spec cannot bypass SHA-256 or install unapproved version
	if _, err := svc.InstallPackage("beeftv-plugin-character-replacement@9.9.9", NpmMirrorRegistry); err == nil {
		t.Fatal("expected unapproved versioned curated spec to be rejected")
	}
	if _, err := svc.InstallPackage("beeftv-plugin-character-replacement@0.1.0", NpmMirrorRegistry); err != nil {
		t.Fatalf("expected matching versioned curated spec to succeed: %v", err)
	}

	// 7. Test failing presigned download redacts query credentials from error
	failingPresigned := server.URL + "/not-found.tgz?X-Amz-Credential=secret123&X-Amz-Signature=sig456"
	if _, err := svc.InstallPackage(failingPresigned, NpmMirrorRegistry); err == nil || strings.Contains(err.Error(), "secret123") || strings.Contains(err.Error(), "sig456") {
		t.Fatalf("expected failing presigned URL error to redact query parameters, got err=%v", err)
	}
}

