package plugins

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"time"

	"infinite-canvas/backend/internal/assistantruntime"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

const (
	NpmMirrorRegistry = "https://registry.npmmirror.com"
	NpmjsRegistry     = "https://registry.npmjs.org"

	packageInstallTimeout = 3 * time.Minute
	maxRemoteTarballBytes = 64 << 20
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
// a curated market plugin ID, a remote .tgz URL, a github:owner/repo spec, a
// local package directory, or a local .tgz. The previous version stays live
// until the new one is downloaded, validated and committed.
func (c *Runtime) InstallPackage(source, registry string) (View, error) {
	if c == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	spec, recordedSpec, isLocalPath, err := resolvePackageSource(source)
	if err != nil {
		return View{}, err
	}
	registry, err = NormalizeNpmRegistry(registry)
	if err != nil {
		return View{}, err
	}
	c.mu.RLock()
	customFetcher := c.packageFetcher
	c.mu.RUnlock()

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
	cachePath := filepath.Join(pluginsRoot, "market-registry-cache.json")
	stagedRoot, err := fetchPackageWithMirrorFallback(ctx, spec, registry, stageDir, cachePath, isLocalPath, customFetcher)
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

func fetchPackageWithMirrorFallback(
	ctx context.Context,
	spec, registry, stageDir, cachePath string,
	isLocalPath bool,
	customFetcher PackageFetcher,
) (string, error) {
	fetch := customFetcher
	if fetch == nil {
		fetch = NpmPackageFetcher(nil)
	}
	runFetchOnArchiveOrDir := func(archivePath string) (string, error) {
		if customFetcher != nil {
			unpackedDir, unpackErr := unpackTarballToDir(archivePath, stageDir)
			if unpackErr == nil {
				return fetch(ctx, unpackedDir, registry, stageDir)
			}
		}
		return fetch(ctx, archivePath, registry, stageDir)
	}

	if isLocalPath {
		return fetch(ctx, spec, registry, stageDir)
	}
	if strings.HasPrefix(spec, "https://") || strings.HasPrefix(spec, "http://") {
		tgzPath, err := downloadMirroredTarball(ctx, spec, "", "", registry, stageDir)
		if err != nil {
			return "", err
		}
		return runFetchOnArchiveOrDir(tgzPath)
	}
	if strings.HasPrefix(spec, "github:") {
		extractedDir, err := downloadGitHubSourceDir(ctx, spec, registry, stageDir)
		if err != nil {
			return "", err
		}
		return fetch(ctx, extractedDir, registry, stageDir)
	}

	// If a custom test fetcher is set, let it handle the spec first; only fall
	// back to curated mirror tarballs if the custom fetcher fails.
	if customFetcher != nil {
		root, err := fetch(ctx, spec, registry, stageDir)
		if err == nil {
			return root, nil
		}
		if entry, ok := lookupCuratedPluginEntry(ctx, spec, registry, cachePath); ok && (entry.MirrorTarball != "" || entry.Tarball != "") {
			if tgzPath, dlErr := downloadMirroredTarball(ctx, entry.Tarball, entry.MirrorTarball, entry.SHA256, registry, stageDir); dlErr == nil {
				return runFetchOnArchiveOrDir(tgzPath)
			}
		}
		return "", err
	}

	entry, isCurated := lookupCuratedPluginEntry(ctx, spec, registry, cachePath)
	hasCuratedTarball := isCurated && (strings.TrimSpace(entry.MirrorTarball) != "" || strings.TrimSpace(entry.Tarball) != "")
	if hasCuratedTarball {
		if npmPackageExistsOnRegistry(ctx, spec, registry) {
			if root, err := fetch(ctx, spec, registry, stageDir); err == nil {
				return root, nil
			}
		}
		tgzPath, err := downloadMirroredTarball(ctx, entry.Tarball, entry.MirrorTarball, entry.SHA256, registry, stageDir)
		if err == nil {
			return fetch(ctx, tgzPath, registry, stageDir)
		}
	}
	return fetch(ctx, spec, registry, stageDir)
}

func npmPackageExistsOnRegistry(ctx context.Context, pkgSpec, registry string) bool {
	base := strings.TrimRight(strings.TrimSpace(registry), "/")
	if base == "" {
		base = NpmMirrorRegistry
	}
	pkgName := strings.TrimSpace(pkgSpec)
	if idx := strings.LastIndex(pkgName, "@"); idx > 0 {
		pkgName = pkgName[:idx]
	}
	escaped := strings.ReplaceAll(url.PathEscape(pkgName), "%40", "@")
	reqCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, base+"/"+escaped+"/latest", nil)
	if err != nil {
		return false
	}
	req.Header.Set("Accept", "application/json")
	resp, err := curatedRegistryHTTPClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func expandTarballMirrorURLs(tarballURL, mirrorTarballURL, registry string) []string {
	isChina := strings.TrimSpace(registry) == "" || strings.Contains(registry, "npmmirror.com")
	var urls []string
	addUnique := func(u string) {
		u = strings.TrimSpace(u)
		if u == "" {
			return
		}
		for _, existing := range urls {
			if existing == u {
				return
			}
		}
		urls = append(urls, u)
	}
	if isChina {
		addUnique(mirrorTarballURL)
		if strings.HasPrefix(tarballURL, "https://github.com/") || strings.HasPrefix(tarballURL, "https://raw.githubusercontent.com/") {
			for _, proxy := range chinaGitHubProxies {
				addUnique(strings.TrimRight(proxy, "/") + "/" + strings.TrimSpace(tarballURL))
			}
		}
		addUnique(tarballURL)
		return urls
	}
	addUnique(tarballURL)
	addUnique(mirrorTarballURL)
	return urls
}

func downloadMirroredTarball(ctx context.Context, tarballURL, mirrorTarballURL, expectedSHA256, registry, stageDir string) (string, error) {
	candidates := expandTarballMirrorURLs(tarballURL, mirrorTarballURL, registry)
	if len(candidates) == 0 {
		return "", packageError(http.StatusBadGateway, "plugin_download_failed", "未配置可用的插件包下载地址")
	}
	var lastErr error
	for _, candidate := range candidates {
		if ctx.Err() != nil {
			break
		}
		reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, candidate, nil)
		if err != nil {
			cancel()
			lastErr = err
			continue
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			cancel()
			lastErr = err
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			cancel()
			lastErr = fmt.Errorf("HTTP %d from %s", resp.StatusCode, candidate)
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, maxRemoteTarballBytes+1))
		resp.Body.Close()
		cancel()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if len(data) > maxRemoteTarballBytes {
			lastErr = fmt.Errorf("插件安装包超过大小限制（%d MB）", maxRemoteTarballBytes>>20)
			continue
		}
		if want := strings.ToLower(strings.TrimSpace(expectedSHA256)); want != "" {
			sum := sha256.Sum256(data)
			got := hex.EncodeToString(sum[:])
			if got != want {
				lastErr = fmt.Errorf("插件包 SHA-256 校验失败（期望 %s，实际 %s）", want, got)
				continue
			}
		}
		targetFile := filepath.Join(stageDir, ".downloaded-plugin.tgz")
		if err := os.WriteFile(targetFile, data, 0o644); err != nil {
			return "", fmt.Errorf("保存下载的插件包失败：%w", err)
		}
		return targetFile, nil
	}
	return "", packageError(http.StatusBadGateway, "plugin_download_failed",
		fmt.Sprintf("从镜像源下载插件包失败：%v", lastErr))
}

// downloadGitHubSourceDir downloads a github:<owner>/<repo>[@ref][#path:/subpath]
// repository archive through the China mirror chain and extracts the target directory.
func downloadGitHubSourceDir(ctx context.Context, spec, registry, stageDir string) (string, error) {
	trimmed := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(spec), "github:"))
	subPath := ""
	if hashIdx := strings.Index(trimmed, "#path:"); hashIdx >= 0 {
		subPath = strings.Trim(strings.TrimSpace(trimmed[hashIdx+len("#path:"):]), "/")
		trimmed = trimmed[:hashIdx]
	}
	ref := "main"
	if atIdx := strings.Index(trimmed, "@"); atIdx > 0 {
		ref = strings.TrimSpace(trimmed[atIdx+1:])
		trimmed = trimmed[:atIdx]
	}
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", packageError(http.StatusBadRequest, "plugin_source_invalid", fmt.Sprintf("无效的 GitHub 插件来源 %q", spec))
	}
	archiveURL := fmt.Sprintf("https://github.com/%s/%s/archive/%s.tar.gz", parts[0], parts[1], ref)
	tgzPath, err := downloadMirroredTarball(ctx, archiveURL, "", "", registry, stageDir)
	if err != nil {
		return "", err
	}
	unpackedRoot, err := unpackTarballToDir(tgzPath, stageDir)
	if err != nil {
		return "", packageError(http.StatusBadGateway, "plugin_download_failed", fmt.Sprintf("解压 GitHub 插件源码包失败：%v", err))
	}
	if subPath != "" {
		cleanSub := path.Clean(subPath)
		if strings.HasPrefix(cleanSub, "..") || path.IsAbs(cleanSub) {
			return "", packageError(http.StatusBadRequest, "plugin_source_invalid", fmt.Sprintf("无效的插件子目录 %q", subPath))
		}
		candidate := filepath.Join(unpackedRoot, filepath.FromSlash(cleanSub))
		if info, statErr := os.Stat(filepath.Join(candidate, "package.json")); statErr == nil && info.Mode().IsRegular() {
			return candidate, nil
		}
		return "", packageError(http.StatusBadRequest, "plugin_package_invalid", fmt.Sprintf("GitHub 仓库子目录 %q 下未找到 package.json", subPath))
	}
	return unpackedRoot, nil
}

func unpackTarballToDir(tgzPath, stageDir string) (string, error) {
	data, err := os.ReadFile(tgzPath)
	if err != nil {
		return "", err
	}
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	defer gz.Close()
	destDir, err := os.MkdirTemp(stageDir, ".unpacked-*")
	if err != nil {
		return "", err
	}
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		if hdr.Typeflag != tar.TypeReg && hdr.Typeflag != tar.TypeRegA {
			continue
		}
		cleanRel := path.Clean(strings.TrimPrefix(hdr.Name, "./"))
		if idx := strings.IndexByte(cleanRel, '/'); idx > 0 {
			cleanRel = cleanRel[idx+1:]
		}
		if cleanRel == "." || cleanRel == ".." || strings.HasPrefix(cleanRel, "../") || path.IsAbs(cleanRel) {
			continue
		}
		targetPath := filepath.Join(destDir, filepath.FromSlash(cleanRel))
		if relCheck, relErr := filepath.Rel(destDir, targetPath); relErr != nil || strings.HasPrefix(relCheck, "..") {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return "", err
		}
		content, err := io.ReadAll(io.LimitReader(tr, 16<<20))
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(targetPath, content, 0o644); err != nil {
			return "", err
		}
	}
	return destDir, nil
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

// resolvePackageSource returns the spec handed to the fetcher, the spec
// recorded for later updates, and whether the source is an explicit local path.
func resolvePackageSource(source string) (string, string, bool, error) {
	source = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(source), "npm:"))
	if source == "" {
		return "", "", false, packageError(http.StatusBadRequest, "plugin_source_required", "插件来源不能为空")
	}
	if info, err := os.Stat(source); err == nil {
		abs, absErr := filepath.Abs(source)
		if absErr != nil {
			return "", "", false, absErr
		}
		if info.IsDir() {
			return abs, abs, true, nil
		}
		return abs, "", true, nil
	}
	if dir, ok := BundledSampleDir(source); ok {
		return dir, source, true, nil
	}
	if strings.HasPrefix(source, "-") || strings.ContainsAny(source, " \t\r\n;|&$`<>") {
		return "", "", false, packageError(http.StatusBadRequest, "plugin_source_invalid", fmt.Sprintf("无效的插件来源 %q", source))
	}
	return source, source, false, nil
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

const bundledPluginsSubdir = "bundled-plugins"

var (
	runtimeExecutable = os.Executable
	runtimeGOOS       = goruntime.GOOS

	bundledBuiltinPlugins = map[string]bool{
		"beeftv-plugin-market": true,
		"beeftv-plugin-ll2":    true,
	}
)

// BundledSampleDir resolves a built-in plugin package directory shipped with
// BeefTV (only beeftv-plugin-market and beeftv-plugin-ll2). Market plugins are
// never bundled inside the desktop app and are always installed online.
func BundledSampleDir(name string) (string, bool) {
	executable, _ := runtimeExecutable()
	return bundledPluginPackageDir(name, executable, runtimeGOOS)
}

func bundledPluginPackageDir(name, executable, goos string) (string, bool) {
	if name == "" || !bundledBuiltinPlugins[name] || strings.ContainsAny(name, `/\.@`) {
		return "", false
	}
	for _, root := range bundledPluginSearchRoots(executable, goos) {
		dir := filepath.Join(root, name)
		if info, err := os.Stat(filepath.Join(dir, "package.json")); err == nil && info.Mode().IsRegular() {
			return dir, true
		}
	}
	return "", false
}

func bundledPluginSearchRoots(executable, goos string) []string {
	var roots []string
	if cfg := assistantruntime.BundledConfig(executable, goos); len(cfg.HostArgs) > 0 {
		roots = append(roots, filepath.Join(filepath.Dir(cfg.HostArgs[0]), bundledPluginsSubdir))
	}
	if officialDir, err := officialPluginPackageDir(); err == nil && officialDir != "" {
		roots = append(roots, officialDir)
	}
	return roots
}
