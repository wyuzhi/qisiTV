package plugins

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

const (
	NpmMirrorRegistry = "https://registry.npmmirror.com"
	NpmjsRegistry     = "https://registry.npmjs.org"

	packageInstallTimeout = 3 * time.Minute
)

// PackageFetcher installs one npm package (registry spec, local directory or
// .tgz path) together with its dependencies under prefixDir and returns the
// installed package root. Plugin packages are full npm packages, so the
// dependencies must land next to them for the agent host to import them.
type PackageFetcher func(ctx context.Context, spec, registry, prefixDir string) (string, error)

// NpmPackageFetcher runs `npm install --prefix` with the given npm invocation.
// Desktop builds pass the bundled node + npm-cli.js; an empty command falls
// back to the npm on PATH, which only developer machines are expected to have.
// Install scripts never run, and peer dependencies (the pi SDK every plugin
// declares) come from the host instead of being installed per plugin.
// Package metadata is always revalidated so an update never reinstalls the
// version cached by an earlier install; tarballs still come from the cache.
func NpmPackageFetcher(command []string) PackageFetcher {
	return func(ctx context.Context, spec, registry, prefixDir string) (string, error) {
		invocation := append([]string{}, command...)
		if len(invocation) == 0 {
			invocation = []string{"npm"}
			if goruntime.GOOS == "windows" {
				invocation = []string{"npm.cmd"}
			}
		}
		if err := os.WriteFile(filepath.Join(prefixDir, "package.json"), []byte(`{"private":true}`), 0o644); err != nil {
			return "", fmt.Errorf("准备插件暂存目录失败：%w", err)
		}
		args := append(invocation[1:], "install", "--prefix", prefixDir, "--install-links", "--ignore-scripts",
			"--legacy-peer-deps", "--prefer-online", "--no-audit", "--no-fund", "--omit=dev", "--registry", registry, spec)
		output, err := exec.CommandContext(ctx, invocation[0], args...).CombinedOutput()
		if err != nil {
			return "", packageError(http.StatusBadGateway, "plugin_download_failed",
				fmt.Sprintf("下载插件 %q 失败：%s", spec, lastLines(string(output), 6)))
		}
		var installed struct {
			Dependencies map[string]string `json:"dependencies"`
		}
		raw, err := os.ReadFile(filepath.Join(prefixDir, "package.json"))
		if err == nil && json.Unmarshal(raw, &installed) == nil && len(installed.Dependencies) == 1 {
			for name := range installed.Dependencies {
				return filepath.Join(prefixDir, "node_modules", filepath.FromSlash(name)), nil
			}
		}
		return "", packageError(http.StatusBadGateway, "plugin_download_failed", fmt.Sprintf("npm 没有装出插件 %q", spec))
	}
}

func lastLines(text string, count int) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) > count {
		lines = lines[len(lines)-count:]
	}
	return strings.Join(lines, "\n")
}

// NormalizeNpmRegistry keeps installs on the two registries the market offers.
func NormalizeNpmRegistry(raw string) (string, error) {
	switch strings.TrimRight(strings.TrimSpace(raw), "/") {
	case "", NpmMirrorRegistry:
		return NpmMirrorRegistry, nil
	case NpmjsRegistry:
		return NpmjsRegistry, nil
	}
	return "", packageError(http.StatusBadRequest, "plugin_registry_unsupported", "只支持 npmmirror 与 npmjs 两个下载源")
}

func (s *Service) SetPackageFetcher(fetch PackageFetcher) {
	if s != nil && s.runtime != nil {
		s.runtime.SetPackageFetcher(fetch)
	}
}

func (c *Runtime) SetPackageFetcher(fetch PackageFetcher) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.packageFetcher = fetch
	c.mu.Unlock()
}

func (s *Service) InstallPackage(source, registry string) (View, error) {
	if s == nil || s.runtime == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	view, err := s.runtime.InstallPackage(source, registry)
	if err != nil {
		return View{}, err
	}
	view.Management = ManagementFromView(view)
	return view, nil
}

// InstallPackageArchive installs an uploaded npm tarball through the same npm
// path as registry packages, so its dependencies are installed too.
func (s *Service) InstallPackageArchive(data []byte, registry string) (View, error) {
	file, err := os.CreateTemp("", "beeftv-plugin-*.tgz")
	if err != nil {
		return View{}, err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(data); err != nil {
		file.Close()
		return View{}, err
	}
	if err := file.Close(); err != nil {
		return View{}, err
	}
	return s.InstallPackage(file.Name(), registry)
}

// InstallPackage installs or replaces a plugin package. source is an npm spec,
// a local package directory, a local .tgz, or the name of a sample package
// shipped in plugin-packages. The previous version stays live until the new
// one is downloaded, validated and committed.
func (c *Runtime) InstallPackage(source, registry string) (View, error) {
	if c == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	spec, recordedSpec, err := resolvePackageSource(source)
	if err != nil {
		return View{}, err
	}
	registry, err = NormalizeNpmRegistry(registry)
	if err != nil {
		return View{}, err
	}
	c.mu.RLock()
	fetch := c.packageFetcher
	c.mu.RUnlock()
	if fetch == nil {
		fetch = NpmPackageFetcher(nil)
	}

	pluginsRoot := filepath.Join(c.dataDir, "plugins")
	if err := os.MkdirAll(pluginsRoot, 0o755); err != nil {
		return View{}, fmt.Errorf("创建插件目录失败：%w", err)
	}
	stageDir, err := os.MkdirTemp(pluginsRoot, ".stage-*")
	if err != nil {
		return View{}, fmt.Errorf("创建插件暂存目录失败：%w", err)
	}
	defer os.RemoveAll(stageDir)
	ctx, cancel := context.WithTimeout(context.Background(), packageInstallTimeout)
	defer cancel()
	stagedRoot, err := fetch(ctx, spec, registry, stageDir)
	if err != nil {
		return View{}, err
	}
	staged, err := protocol.ParsePluginPackageDir(stagedRoot)
	if err != nil {
		return View{}, packageError(http.StatusBadRequest, "plugin_package_invalid", err.Error())
	}
	// Downloading can take minutes; only the swap and the registry commit
	// hold the mutation lock, so enabling or removing plugins is not blocked.
	c.beginMutation()
	defer c.endMutation()
	id := staged.Manifest.Metadata.ID
	if IsReservedApplication(id) {
		return View{}, packageError(http.StatusConflict, "plugin_id_reserved", fmt.Sprintf("插件 ID %q 由官方应用保留", id))
	}
	c.mu.RLock()
	existing, exists := c.plugins[id]
	c.mu.RUnlock()
	if exists && IsBuiltInSource(existing.Source) {
		return View{}, packageError(http.StatusConflict, "plugin_id_reserved", fmt.Sprintf("内置插件 %q 不能通过安装包覆盖", id))
	}
	relRoot, err := filepath.Rel(stageDir, staged.RootDir)
	if err != nil {
		return View{}, err
	}

	installRoot := filepath.Join(pluginsRoot, id)
	backupDir := ""
	if _, err := os.Stat(installRoot); err == nil {
		backupDir = installRoot + ".bak-" + fmt.Sprint(time.Now().UnixNano())
		if err := os.Rename(installRoot, backupDir); err != nil {
			return View{}, fmt.Errorf("备份旧插件目录失败：%w", err)
		}
	}
	restore := func() {
		_ = os.RemoveAll(installRoot)
		if backupDir != "" {
			_ = os.Rename(backupDir, installRoot)
		}
	}
	if err := os.Rename(stageDir, installRoot); err != nil {
		restore()
		return View{}, fmt.Errorf("启用新插件目录失败：%w", err)
	}
	installed, err := protocol.ParsePluginPackageDir(filepath.Join(installRoot, relRoot))
	if err != nil {
		restore()
		return View{}, packageError(http.StatusBadRequest, "plugin_package_invalid", err.Error())
	}
	view, err := c.commitPackageRecord(installed, recordedSpec, existing, exists)
	if err != nil {
		restore()
		return View{}, err
	}
	if backupDir != "" {
		_ = os.RemoveAll(backupDir)
	}
	return view, nil
}

func (c *Runtime) commitPackageRecord(pkg protocol.PluginPackage, spec string, existing Record, exists bool) (View, error) {
	id := pkg.Manifest.Metadata.ID
	manifest := pkg.Manifest
	manifest.Metadata.Enabled = !exists || existing.Metadata.Enabled
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		return View{}, err
	}
	stored, err := c.currentRecords()
	if err != nil {
		return View{}, err
	}
	now := time.Now().UTC()
	record := RegistryRecord{
		ID:            id,
		Raw:           manifestData,
		Source:        OriginPackage,
		PackageDir:    pkg.RootDir,
		PackageSpec:   spec,
		PackageSHA256: pkg.SHA256,
		SkillDirs:     pkg.SkillDirs,
		InstalledAt:   now,
		UpdatedAt:     now,
	}
	replaced := false
	for index := range stored {
		if stored[index].ID == id {
			record.InstalledAt = stored[index].InstalledAt
			stored[index] = record
			replaced = true
			break
		}
	}
	if !replaced {
		stored = append(stored, record)
	}
	pluginsMap, registry, err := c.build(stored)
	if err != nil {
		return View{}, err
	}
	view, err := viewFromPlugins(pluginsMap, id)
	if err != nil {
		return View{}, err
	}
	stage := stagedMutation{
		previousLive: c.captureLive(),
		nextDisk:     stored,
		nextPlugins:  pluginsMap,
		nextRegistry: registry,
		view:         view,
	}
	extras := persistExtras{}
	if c.store != nil {
		extras.platform = &model.PluginPlatformState{PluginID: id, Available: view.Status == StatusEnabled, CreatedAt: now, UpdatedAt: now}
	}
	if err := c.commitAndPublish(&stage, extras); err != nil {
		c.abortUncommitted(&stage)
		return View{}, err
	}
	return stage.view, nil
}

// resolvePackageSource returns the spec handed to npm and the spec recorded for
// later updates. Uploaded archives live in a temp file, so they record nothing.
func resolvePackageSource(source string) (string, string, error) {
	source = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(source), "npm:"))
	if source == "" {
		return "", "", packageError(http.StatusBadRequest, "plugin_source_required", "插件来源不能为空")
	}
	if info, err := os.Stat(source); err == nil {
		abs, absErr := filepath.Abs(source)
		if absErr != nil {
			return "", "", absErr
		}
		if info.IsDir() {
			return abs, abs, nil
		}
		return abs, "", nil
	}
	if dir, ok := BundledSampleDir(source); ok {
		return dir, source, nil
	}
	if strings.HasPrefix(source, "-") || strings.ContainsAny(source, " \t\r\n;|&$`<>") {
		return "", "", packageError(http.StatusBadRequest, "plugin_source_invalid", fmt.Sprintf("无效的插件来源 %q", source))
	}
	return source, source, nil
}

func (s *Service) UpdatePackage(id, registry string) (View, error) {
	if s == nil || s.runtime == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	s.runtime.mu.RLock()
	record, ok := s.runtime.plugins[strings.TrimSpace(id)]
	s.runtime.mu.RUnlock()
	if !ok {
		return View{}, packageError(http.StatusNotFound, "plugin_not_found", fmt.Sprintf("插件 %q 不存在", id))
	}
	if record.Source != OriginPackage || strings.TrimSpace(record.PackageSpec) == "" {
		return View{}, packageError(http.StatusConflict, "plugin_update_unsupported", fmt.Sprintf("插件 %q 不能在线更新", id))
	}
	return s.InstallPackage(record.PackageSpec, registry)
}

// cleanupUninstalledPackageDir removes the install root of package plugins
// that left the registry. Only directories under <dataDir>/plugins are touched.
func (c *Runtime) cleanupUninstalledPackageDir(previous map[string]Record, next map[string]Record) {
	if c == nil || strings.TrimSpace(c.dataDir) == "" {
		return
	}
	pluginsRoot, err := filepath.Abs(filepath.Join(c.dataDir, "plugins"))
	if err != nil {
		return
	}
	for id, prev := range previous {
		if _, stillInstalled := next[id]; stillInstalled || prev.Source != OriginPackage {
			continue
		}
		installRoot := filepath.Join(pluginsRoot, id)
		if rel, err := filepath.Rel(pluginsRoot, installRoot); err != nil || rel != id {
			continue
		}
		_ = os.RemoveAll(installRoot)
	}
}

// BundledSampleDir resolves the name of a sample package shipped in
// plugin-packages. It is the only place that decides what counts as bundled.
func BundledSampleDir(name string) (string, bool) {
	if name == "" || strings.ContainsAny(name, `/\.@`) {
		return "", false
	}
	officialDir, err := officialPluginPackageDir()
	if err != nil {
		return "", false
	}
	dir := filepath.Join(officialDir, name)
	if _, err := os.Stat(filepath.Join(dir, "package.json")); err != nil {
		return "", false
	}
	return dir, true
}
