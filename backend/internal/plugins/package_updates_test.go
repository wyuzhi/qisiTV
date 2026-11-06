package plugins

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNewerVersionOnlyComparesPlainNumbers(t *testing.T) {
	for _, tc := range []struct {
		latest, current string
		want            bool
	}{
		{"1.0.10", "1.0.9", true},
		{"0.2.0", "0.1.9", true},
		{"1.0.0", "1.0.0", false},
		{"1.0.0", "1.0.1", false},
		{"v2.0.0", "1.9.9", true},
		{"1.1.0-beta.1", "1.0.0", true},
		{"latest", "1.0.0", false},
		{"", "1.0.0", false},
	} {
		if got := newerVersion(tc.latest, tc.current); got != tc.want {
			t.Errorf("newerVersion(%q, %q) = %v, want %v", tc.latest, tc.current, got, tc.want)
		}
	}
}

// npmFixture 用本地服务冒充 npm：/<包名>/latest 返回 latest 里登记的版本。
func npmFixture(t *testing.T, latest map[string]string) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/"), "/latest")
		version, ok := latest[name]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"name": name, "version": version, "description": name + " 的说明",
			"author": map[string]string{"name": "社区作者"}, "repository": map[string]string{"url": "git+https://github.com/example/" + name + ".git"},
			"beeftv": map[string]string{"name": "显示名 " + name},
		})
	}))
	prevLoopback, prevRegistries := allowLoopbackMarketURLsForTest, npmRegistriesForTest
	allowLoopbackMarketURLsForTest, npmRegistriesForTest = true, []string{server.URL}
	t.Cleanup(func() {
		server.Close()
		allowLoopbackMarketURLsForTest, npmRegistriesForTest = prevLoopback, prevRegistries
		npmSummaryCache.Lock()
		npmSummaryCache.items = map[string]npmSummaryEntry{}
		npmSummaryCache.Unlock()
		setCuratedRegistryForTest("")
	})
}

func setCuratedRegistryForTest(raw string) {
	curatedRegistryMemCache.Lock()
	defer curatedRegistryMemCache.Unlock()
	if raw == "" {
		curatedRegistryMemCache.raw, curatedRegistryMemCache.fetchedAt = nil, time.Time{}
		return
	}
	curatedRegistryMemCache.raw, curatedRegistryMemCache.fetchedAt = []byte(raw), time.Now()
}

// installNamedForTest 按 npm 包名安装，假安装器把包名对到本地目录。
func installNamedForTest(t *testing.T, svc *Service, dirs map[string]string, name, version string) {
	t.Helper()
	dir := t.TempDir()
	writePluginFolder(t, dir, map[string]string{
		"package.json":    `{"name":"` + name + `","version":"` + version + `","beeftv":{"client":"./client/index.js"}}`,
		"client/index.js": "export function activate() {}\n",
	})
	dirs[name] = dir
	if _, err := svc.InstallPackage(name, ""); err != nil {
		t.Fatalf("install %s: %v", name, err)
	}
}

func TestCheckUpdatesListsOnlyPluginsWithANewerVersion(t *testing.T) {
	npmFixture(t, map[string]string{"beeftv-plugin-behind": "0.2.0", "beeftv-plugin-current": "1.0.0"})
	rt, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(rt, nil)
	dirs := map[string]string{}
	svc.SetPackageFetcher(func(ctx context.Context, spec, registry, prefixDir string) (string, error) {
		if dir, ok := dirs[spec]; ok {
			spec = dir
		}
		return copyPackageFetcher(ctx, spec, registry, prefixDir)
	})
	installNamedForTest(t, svc, dirs, "beeftv-plugin-behind", "0.1.0")
	installNamedForTest(t, svc, dirs, "beeftv-plugin-current", "1.0.0")
	installNamedForTest(t, svc, dirs, "beeftv-plugin-pinned", "1.0.0")
	installNamedForTest(t, svc, dirs, "beeftv-plugin-unpublished", "0.1.0")
	folder := t.TempDir()
	writePluginFolder(t, folder, map[string]string{
		"package.json":    `{"name":"beeftv-plugin-folder","version":"0.0.1","beeftv":{"client":"./client/index.js"}}`,
		"client/index.js": "export function activate() {}\n",
	})
	if _, err := svc.InstallPackage(folder, ""); err != nil {
		t.Fatal(err)
	}
	setCuratedRegistryForTest(`{"plugins":[{"id":"beeftv-plugin-pinned","packageName":"beeftv-plugin-pinned","version":"1.1.0",
		"tarball":"https://github.com/example/releases/pinned-1.1.0.tgz","sha256":"` + strings.Repeat("a", 64) + `"}]}`)

	got := svc.CheckUpdates(context.Background(), "")
	want := []UpdateNotice{
		{ID: "beeftv-plugin-behind", Version: "0.1.0", Latest: "0.2.0"},
		{ID: "beeftv-plugin-pinned", Version: "1.0.0", Latest: "1.1.0", Official: true},
	}
	if len(got.Updates) != len(want) || got.Updates[0] != want[0] || got.Updates[1] != want[1] {
		t.Fatalf("updates = %+v", got.Updates)
	}
	// 文件夹装的和 npm 上查不到的插件没法比较，两份名单都不进，界面照旧给「更新」按钮。
	if strings.Join(got.UpToDate, ",") != "beeftv-plugin-current" {
		t.Fatalf("up to date = %v", got.UpToDate)
	}
}

func TestOneLineRegistryEntriesAreFilledFromNpm(t *testing.T) {
	npmFixture(t, map[string]string{"beeftv-plugin-community": "0.3.0"})
	setCuratedRegistryForTest(`{"plugins":[],"packages":["beeftv-plugin-community","beeftv-plugin-missing",""]}`)
	cachePath := filepath.Join(t.TempDir(), "cache.json")
	items := loadCuratedRegistryItemsWithCache(context.Background(), "", NpmMirrorRegistry, cachePath, map[string]View{})
	if len(items) != 1 {
		t.Fatalf("items = %+v", items)
	}
	item := items[0]
	if item.ID != "beeftv-plugin-community" || item.Name != "显示名 beeftv-plugin-community" || item.Version != "0.3.0" ||
		item.Author != "社区作者" || item.Repository != "https://github.com/example/beeftv-plugin-community" || !item.Recommended || item.SHA256 != "" {
		t.Fatalf("item = %+v", item)
	}
	if hits := loadCuratedRegistryItemsWithCache(context.Background(), "nothing-matches", NpmMirrorRegistry, cachePath, map[string]View{}); len(hits) != 0 {
		t.Fatalf("query hits = %+v", hits)
	}
}

func TestVersionedInstallUpdatesToLatestByHandOnly(t *testing.T) {
	npmFixture(t, map[string]string{"beeftv-plugin-held": "0.2.0"})
	rt, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(rt, nil)
	folder := func(version string) string {
		dir := t.TempDir()
		writePluginFolder(t, dir, map[string]string{
			"package.json":    `{"name":"beeftv-plugin-held","version":"` + version + `","beeftv":{"client":"./client/index.js"}}`,
			"client/index.js": "export function activate() {}\n",
		})
		return dir
	}
	dirs := map[string]string{"beeftv-plugin-held@0.1.0": folder("0.1.0"), "beeftv-plugin-held": folder("0.2.0")}
	svc.SetPackageFetcher(func(ctx context.Context, spec, registry, prefixDir string) (string, error) {
		return copyPackageFetcher(ctx, dirs[spec], registry, prefixDir)
	})
	if _, err := svc.InstallPackage("beeftv-plugin-held@0.1.0", ""); err != nil {
		t.Fatal(err)
	}

	// 精选列表有新版本时只提示，不算自动更新。
	setCuratedRegistryForTest(`{"plugins":[{"id":"beeftv-plugin-held","packageName":"beeftv-plugin-held","version":"0.2.0",
		"tarball":"https://github.com/example/releases/held-0.2.0.tgz","sha256":"` + strings.Repeat("a", 64) + `"}]}`)
	got := svc.CheckUpdates(context.Background(), "")
	if len(got.Updates) != 1 || got.Updates[0].Latest != "0.2.0" || got.Updates[0].Official {
		t.Fatalf("updates = %+v", got.Updates)
	}

	setCuratedRegistryForTest(`{"plugins":[]}`)
	updated, err := svc.UpdatePackage("beeftv-plugin-held", "")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Manifest.Version != "0.2.0" || updated.PackageSpec != "beeftv-plugin-held" {
		t.Fatalf("updated = %s from %q", updated.Manifest.Version, updated.PackageSpec)
	}
}
