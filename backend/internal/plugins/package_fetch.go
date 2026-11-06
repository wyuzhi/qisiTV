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
	maxTarEntries         = 2048
	maxTarSingleFileBytes = 16 << 20
	maxTarTotalBytes      = 64 << 20
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
	if err := protocol.CheckPackageManifestWriting(stagedRoot); err != nil {
		return View{}, packageError(http.StatusBadRequest, "plugin_package_invalid", err.Error())
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

	if isLocalPath {
		return fetch(ctx, spec, registry, stageDir)
	}
	if strings.HasPrefix(spec, "https://") || strings.HasPrefix(spec, "http://") {
		cleanURL, fragmentSHA := splitURLSHA256Fragment(spec)
		tgzPath, err := downloadMirroredTarball(ctx, cleanURL, "", fragmentSHA, registry, stageDir)
		if err != nil {
			return "", err
		}
		return fetch(ctx, tgzPath, registry, stageDir)
	}
	if strings.HasPrefix(spec, "github:") {
		extractedDir, err := downloadGitHubSourceDir(ctx, spec, registry, stageDir)
		if err != nil {
			return "", err
		}
		return fetch(ctx, extractedDir, registry, stageDir)
	}

	// Curated plugins that declare a SHA-256-pinned tarball in registry.json
	// MUST be installed from the digest-verified tarball first so an unclaimed
	// or squatted npm package name cannot bypass the curated SHA-256 pin.
	basePkgName, requestedVersion := splitNpmPackageSpec(spec)
	if entry, isCurated := lookupCuratedPluginEntry(ctx, basePkgName, registry, cachePath); isCurated &&
		(strings.TrimSpace(entry.MirrorTarball) != "" || strings.TrimSpace(entry.Tarball) != "") {
		if requestedVersion != "" && requestedVersion != "latest" && strings.TrimSpace(entry.Version) != "" && requestedVersion != strings.TrimSpace(entry.Version) {
			return "", packageError(http.StatusBadRequest, "plugin_source_invalid",
				fmt.Sprintf("精选插件 %q 仅支持安装已校验的官方版本 %s", basePkgName, strings.TrimSpace(entry.Version)))
		}
		if !validPackageSHA256(strings.ToLower(strings.TrimSpace(entry.SHA256))) {
			return "", packageError(http.StatusBadGateway, "plugin_download_failed",
				fmt.Sprintf("精选插件 %q 缺少有效的 SHA-256 校验值", basePkgName))
		}
		tgzPath, err := downloadMirroredTarball(ctx, entry.Tarball, entry.MirrorTarball, entry.SHA256, registry, stageDir)
		if err != nil {
			return "", err
		}
		return fetch(ctx, tgzPath, registry, stageDir)
	}

	return fetch(ctx, spec, registry, stageDir)
}

func splitNpmPackageSpec(spec string) (name string, version string) {
	trimmed := strings.TrimSpace(spec)
	if trimmed == "" {
		return "", ""
	}
	if strings.HasPrefix(trimmed, "@") {
		slashIdx := strings.IndexByte(trimmed, '/')
		if slashIdx < 0 {
			return trimmed, ""
		}
		if atIdx := strings.IndexByte(trimmed[slashIdx+1:], '@'); atIdx >= 0 {
			pos := slashIdx + 1 + atIdx
			return trimmed[:pos], strings.TrimSpace(trimmed[pos+1:])
		}
		return trimmed, ""
	}
	if atIdx := strings.IndexByte(trimmed, '@'); atIdx > 0 {
		return trimmed[:atIdx], strings.TrimSpace(trimmed[atIdx+1:])
	}
	return trimmed, ""
}

func redactMarketURL(rawURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" {
		return "<redacted-url>"
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

func splitURLSHA256Fragment(rawURL string) (string, string) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return rawURL, ""
	}
	frag := strings.TrimSpace(parsed.Fragment)
	parsed.Fragment = ""
	if strings.HasPrefix(strings.ToLower(frag), "sha256=") {
		sum := strings.ToLower(strings.TrimSpace(frag[len("sha256="):]))
		return parsed.String(), sum
	}
	return parsed.String(), ""
}

func expandTarballMirrorURLs(tarballURL, mirrorTarballURL, expectedSHA256, registry string) []string {
	isChina := strings.TrimSpace(registry) == "" || strings.Contains(registry, "npmmirror.com")
	hasVerifiedDigest := validPackageSHA256(strings.ToLower(strings.TrimSpace(expectedSHA256)))
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
		// Third-party GitHub proxies are ONLY included when the caller has a
		// pinned SHA-256 digest that will be verified before extraction.
		if hasVerifiedDigest && (strings.HasPrefix(tarballURL, "https://github.com/") || strings.HasPrefix(tarballURL, "https://raw.githubusercontent.com/")) {
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
	wantSHA := strings.ToLower(strings.TrimSpace(expectedSHA256))
	if wantSHA != "" && !validPackageSHA256(wantSHA) {
		return "", packageError(http.StatusBadRequest, "plugin_source_invalid", fmt.Sprintf("无效的插件包 SHA-256 校验值 %q", expectedSHA256))
	}
	candidates := expandTarballMirrorURLs(tarballURL, mirrorTarballURL, wantSHA, registry)
	if len(candidates) == 0 {
		return "", packageError(http.StatusBadGateway, "plugin_download_failed", "未配置可用的插件包下载地址")
	}
	var lastErr error
	for _, candidate := range candidates {
		if ctx.Err() != nil {
			break
		}
		resp, err := doMarketGetRequest(ctx, candidate, 30*time.Second, "application/octet-stream, application/gzip")
		if err != nil {
			lastErr = fmt.Errorf("request %s failed", redactMarketURL(candidate))
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			lastErr = fmt.Errorf("HTTP %d from %s", resp.StatusCode, redactMarketURL(candidate))
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, maxRemoteTarballBytes+1))
		resp.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if len(data) > maxRemoteTarballBytes {
			lastErr = fmt.Errorf("插件安装包超过大小限制（%d MB）", maxRemoteTarballBytes>>20)
			continue
		}
		if wantSHA != "" {
			sum := sha256.Sum256(data)
			got := hex.EncodeToString(sum[:])
			if got != wantSHA {
				lastErr = fmt.Errorf("插件包 SHA-256 校验失败（期望 %s，实际 %s）", wantSHA, got)
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

// downloadGitHubSourceDir downloads a github:<owner>/<repo>[@ref][#path:/subpath][#sha256=<hex>]
// repository archive and extracts the target directory with strict size bounds.
func downloadGitHubSourceDir(ctx context.Context, spec, registry, stageDir string) (string, error) {
	trimmed := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(spec), "github:"))
	expectedSHA := ""
	if shaIdx := strings.Index(trimmed, "#sha256="); shaIdx >= 0 {
		expectedSHA = strings.TrimSpace(trimmed[shaIdx+len("#sha256="):])
		trimmed = trimmed[:shaIdx]
	}
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
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || strings.ContainsAny(ref, `/\`) {
		return "", packageError(http.StatusBadRequest, "plugin_source_invalid", fmt.Sprintf("无效的 GitHub 插件来源 %q", spec))
	}
	archiveURL := fmt.Sprintf("https://github.com/%s/%s/archive/%s.tar.gz", parts[0], parts[1], url.PathEscape(ref))
	tgzPath, err := downloadMirroredTarball(ctx, archiveURL, "", expectedSHA, registry, stageDir)
	if err != nil {
		return "", err
	}
	unpackedRoot, err := unpackTarballToDir(tgzPath, stageDir)
	if err != nil {
		return "", packageError(http.StatusBadGateway, "plugin_download_failed", fmt.Sprintf("解压 GitHub 插件源码包失败：%v", err))
	}
	if subPath != "" {
		cleanSub := path.Clean(subPath)
		if cleanSub == "." || cleanSub == ".." || strings.HasPrefix(cleanSub, "../") || path.IsAbs(cleanSub) {
			return "", packageError(http.StatusBadRequest, "plugin_source_invalid", fmt.Sprintf("无效的插件子目录 %q", subPath))
		}
		candidate := filepath.Join(unpackedRoot, filepath.FromSlash(cleanSub))
		if relCheck, relErr := filepath.Rel(unpackedRoot, candidate); relErr != nil || strings.HasPrefix(relCheck, "..") {
			return "", packageError(http.StatusBadRequest, "plugin_source_invalid", fmt.Sprintf("插件子目录越界 %q", subPath))
		}
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
	var (
		entryCount int
		totalBytes int64
	)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		entryCount++
		if entryCount > maxTarEntries {
			return "", fmt.Errorf("压缩包条目数超过上限（%d）", maxTarEntries)
		}
		switch hdr.Typeflag {
		case tar.TypeDir, tar.TypeXHeader, tar.TypeXGlobalHeader:
			continue
		case tar.TypeReg, tar.TypeRegA:
		default:
			return "", fmt.Errorf("压缩包包含不支持的条目类型 %q (%s)", hdr.Typeflag, hdr.Name)
		}
		rawName := strings.TrimPrefix(strings.TrimSpace(hdr.Name), "./")
		if rawName == "" || strings.ContainsRune(rawName, '\\') || path.IsAbs(rawName) {
			return "", fmt.Errorf("压缩包包含非法路径 %q", hdr.Name)
		}
		cleanRel := path.Clean(rawName)
		if cleanRel == "." || cleanRel == ".." || strings.HasPrefix(cleanRel, "../") || strings.Contains(cleanRel, "..") {
			return "", fmt.Errorf("压缩包路径越界 %q", hdr.Name)
		}
		if hdr.Size < 0 || hdr.Size > maxTarSingleFileBytes {
			return "", fmt.Errorf("压缩包单文件 %q 超过大小上限（%d MB）", hdr.Name, maxTarSingleFileBytes>>20)
		}
		content, err := io.ReadAll(io.LimitReader(tr, maxTarSingleFileBytes+1))
		if err != nil {
			return "", err
		}
		if int64(len(content)) > maxTarSingleFileBytes {
			return "", fmt.Errorf("压缩包单文件 %q 超过大小上限（%d MB）", hdr.Name, maxTarSingleFileBytes>>20)
		}
		totalBytes += int64(len(content))
		if totalBytes > maxTarTotalBytes {
			return "", fmt.Errorf("压缩包解压总大小超过上限（%d MB）", maxTarTotalBytes>>20)
		}
		targetPath := filepath.Join(destDir, filepath.FromSlash(cleanRel))
		if relCheck, relErr := filepath.Rel(destDir, targetPath); relErr != nil || strings.HasPrefix(relCheck, "..") {
			return "", fmt.Errorf("压缩包路径越界 %q", hdr.Name)
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return "", err
		}
		fileMode := os.FileMode(0o644)
		if hdr.Mode&0o111 != 0 {
			fileMode = 0o755
		}
		if err := os.WriteFile(targetPath, content, fileMode); err != nil {
			return "", err
		}
	}
	// If package.json is at the archive root, return destDir directly; if all
	// files were nested under a single top-level directory (such as "package/"
	// or "<repo>-<ref>/"), unwrap that single directory.
	if info, err := os.Stat(filepath.Join(destDir, "package.json")); err == nil && info.Mode().IsRegular() {
		return destDir, nil
	}
	entries, err := os.ReadDir(destDir)
	if err == nil && len(entries) == 1 && entries[0].IsDir() {
		return filepath.Join(destDir, entries[0].Name()), nil
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
	if strings.HasPrefix(source, "https://") || strings.HasPrefix(source, "http://") {
		if strings.ContainsAny(source, " \t\r\n") {
			return "", "", false, packageError(http.StatusBadRequest, "plugin_source_invalid", fmt.Sprintf("无效的插件地址 %q", source))
		}
		parsed, err := url.Parse(source)
		if err != nil || parsed.Hostname() == "" || parsed.User != nil {
			return "", "", false, packageError(http.StatusBadRequest, "plugin_source_invalid", fmt.Sprintf("无效的插件地址 %q", source))
		}
		return source, source, false, nil
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
	// 用户点更新就是要最新版，所以不带安装时写的版本号。否则会重装旧版本，精选插件还会被拒绝。
	if name, ok := npmPackageName(record.PackageSpec); ok {
		return s.InstallPackage(name, registry)
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

// BundledBuiltinPluginNames is the single source of truth for default built-in
// plugin directories shipped inside the BeefTV desktop app (agent-host/bundled-plugins).
var BundledBuiltinPluginNames = []string{
	"beeftv-plugin-market",
	"beeftv-plugin-ll2",
}

var (
	runtimeExecutable = os.Executable
	runtimeGOOS       = goruntime.GOOS
)

func isBundledBuiltinPlugin(name string) bool {
	for _, builtin := range BundledBuiltinPluginNames {
		if name == builtin {
			return true
		}
	}
	return false
}

// BundledSampleDir resolves a built-in plugin package directory shipped with
// BeefTV (only beeftv-plugin-market and beeftv-plugin-ll2). Market plugins are
// never bundled inside the desktop app and are always installed online.
func BundledSampleDir(name string) (string, bool) {
	executable, _ := runtimeExecutable()
	return bundledPluginPackageDir(name, executable, runtimeGOOS)
}

func bundledPluginPackageDir(name, executable, goos string) (string, bool) {
	if name == "" || !isBundledBuiltinPlugin(name) || strings.ContainsAny(name, `/\.@`) {
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
