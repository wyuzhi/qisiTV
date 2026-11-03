package plugins

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/protocol"
)

func (s *Service) ResolvePackageFile(id string, filePath string) (string, string, error) {
	if s == nil || s.runtime == nil {
		return "", "", fmt.Errorf("插件运行时未初始化")
	}
	return s.runtime.ResolvePackageFile(id, filePath)
}

func (c *Runtime) ResolvePackageFile(id string, filePath string) (string, string, error) {
	if c == nil {
		return "", "", fmt.Errorf("插件运行时未初始化")
	}
	trimmedID := strings.TrimSpace(id)
	c.mu.RLock()
	record, ok := c.plugins[trimmedID]
	c.mu.RUnlock()
	pkgDir := strings.TrimSpace(record.PackageDir)
	if !ok || pkgDir == "" {
		if candidate, found := BundledSampleDir(trimmedID); found {
			pkgDir = candidate
			ok = true
		}
	}
	if !ok {
		return "", "", packageError(http.StatusNotFound, "plugin_not_found", fmt.Sprintf("插件 %q 不存在", id))
	}
	if pkgDir == "" {
		return "", "", packageError(http.StatusNotFound, "plugin_file_not_found", fmt.Sprintf("插件 %q 不包含静态文件目录", id))
	}
	trimmed := strings.TrimSpace(filePath)
	trimmed = strings.TrimPrefix(trimmed, "/")
	trimmed = strings.TrimPrefix(trimmed, "./")
	if trimmed == "" || strings.ContainsRune(trimmed, '\\') || path.IsAbs(trimmed) {
		return "", "", packageError(http.StatusBadRequest, "plugin_file_path_invalid", fmt.Sprintf("无效的插件文件路径 %q", filePath))
	}
	cleanRel := path.Clean(trimmed)
	if cleanRel == "." || cleanRel == ".." || strings.HasPrefix(cleanRel, "../") || strings.Contains(cleanRel, "..") {
		return "", "", packageError(http.StatusBadRequest, "plugin_file_path_invalid", fmt.Sprintf("插件文件路径越界 %q", filePath))
	}
	for _, seg := range strings.Split(cleanRel, "/") {
		if seg == "node_modules" || seg == ".git" {
			return "", "", packageError(http.StatusBadRequest, "plugin_file_path_invalid", fmt.Sprintf("禁止访问插件目录 %s", seg))
		}
	}
	ext := strings.ToLower(path.Ext(cleanRel))
	contentType := ""
	switch ext {
	case ".js", ".mjs":
		contentType = "application/javascript; charset=utf-8"
	case ".css":
		contentType = "text/css; charset=utf-8"
	case ".json", ".map":
		contentType = "application/json; charset=utf-8"
	case ".md":
		contentType = "text/markdown; charset=utf-8"
	case ".svg":
		contentType = "image/svg+xml"
	case ".png", ".jpg", ".jpeg", ".webp", ".woff", ".woff2":
		contentType = mime.TypeByExtension(ext)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
	default:
		return "", "", packageError(http.StatusBadRequest, "plugin_file_type_unsupported", fmt.Sprintf("不支持的插件静态资源类型 %q", ext))
	}
	absRoot, err := filepath.Abs(pkgDir)
	if err != nil {
		return "", "", err
	}
	absTarget := filepath.Join(absRoot, filepath.FromSlash(cleanRel))
	relCheck, err := filepath.Rel(absRoot, absTarget)
	if err != nil || strings.HasPrefix(relCheck, "..") || filepath.IsAbs(relCheck) {
		return "", "", packageError(http.StatusBadRequest, "plugin_file_path_invalid", fmt.Sprintf("插件文件路径越界 %q", filePath))
	}
	info, err := os.Stat(absTarget)
	if err != nil || !info.Mode().IsRegular() {
		return "", "", packageError(http.StatusNotFound, "plugin_file_not_found", fmt.Sprintf("插件文件 %q 不存在", cleanRel))
	}
	if realRoot, err := filepath.EvalSymlinks(absRoot); err == nil {
		if realTarget, err := filepath.EvalSymlinks(absTarget); err == nil {
			relReal, relErr := filepath.Rel(realRoot, realTarget)
			if relErr != nil || strings.HasPrefix(relReal, "..") || filepath.IsAbs(relReal) {
				return "", "", packageError(http.StatusBadRequest, "plugin_file_path_invalid", fmt.Sprintf("插件文件软链接越界 %q", filePath))
			}
		}
	}
	return absTarget, contentType, nil
}

func (s *Service) SearchMarket(ctx context.Context, query string, registry ...string) ([]MarketPluginItem, error) {
	selectedRegistry := NpmMirrorRegistry
	if len(registry) > 0 && strings.TrimSpace(registry[0]) != "" {
		if normalized, err := NormalizeNpmRegistry(registry[0]); err == nil {
			selectedRegistry = normalized
		}
	}
	installedByID := map[string]View{}
	var localItems []MarketPluginItem
	cachePath := ""
	if s != nil {
		if s.runtime != nil && strings.TrimSpace(s.runtime.dataDir) != "" {
			cachePath = filepath.Join(s.runtime.dataDir, "plugins", "market-registry-cache.json")
		}
		for _, item := range s.List() {
			installedByID[item.Manifest.ID] = item
			if item.PackageDir == "" && item.Source != OriginPackage {
				continue
			}
			if !matchesMarketQuery(item, query) {
				continue
			}
			pkgName := item.PackageSpec
			if pkgName == "" {
				pkgName = "@beeftv/plugin-" + item.Manifest.ID
			}
			localItems = append(localItems, MarketPluginItem{
				ID:          item.Manifest.ID,
				Name:        item.Manifest.Name,
				PackageName: pkgName,
				Version:     item.Manifest.Version,
				Description: item.Manifest.Description,
				Author:      item.Manifest.Author,
				Keywords:    []string{"beeftv-plugin", "pi-package"},
				Installed:   true,
				Enabled:     item.Status == StatusEnabled,
			})
		}
	}
	remoteItems := fetchNpmMarketPluginsWithRegistry(ctx, query, selectedRegistry, installedByID)
	curatedItems := loadCuratedRegistryItemsWithCache(ctx, query, selectedRegistry, cachePath, installedByID)
	return mergeMarketItems(curatedItems, remoteItems, localItems), nil
}

// mergeMarketItems lists each plugin once, keeping the first group that has it.
// The recommendation list and npm describe what can be installed (latest
// version, recommended flag) and already mark installed plugins, so installed
// plugins only fill in what neither source lists.
func mergeMarketItems(groups ...[]MarketPluginItem) []MarketPluginItem {
	seen := map[string]struct{}{}
	merged := []MarketPluginItem{}
	for _, group := range groups {
		for _, item := range group {
			if _, exists := seen[item.ID]; exists {
				continue
			}
			seen[item.ID] = struct{}{}
			merged = append(merged, item)
		}
	}
	return merged
}

// CuratedRegistryURL is the public recommendation list; authors add a line by
// pull request. China mirrors (jsDelivr CDN, gh-proxy, ghfast.top, and the
// beeftv-plugin-catalog npm package on npmmirror) are tried first when the
// China mirror registry is selected.
const (
	CuratedRegistryURL       = "https://raw.githubusercontent.com/Sunnyender-org/beeftv-plugins/main/registry.json"
	CuratedRegistryMirrorCDN = "https://cdn.jsdelivr.net/gh/Sunnyender-org/beeftv-plugins@main/registry.json"
	CuratedCatalogPackage    = "beeftv-plugin-catalog"
)

var (
	chinaGitHubProxies = []string{
		"https://gh-proxy.com",
		"https://ghfast.top",
	}
	curatedRegistryHTTPClient = &http.Client{Timeout: 3500 * time.Millisecond}
)

type curatedRegistryEntry struct {
	ID            string   `json:"id"`
	PackageName   string   `json:"packageName"`
	Npm           string   `json:"npm"`
	Name          string   `json:"name"`
	Version       string   `json:"version"`
	Description   string   `json:"description"`
	Author        string   `json:"author"`
	Category      string   `json:"category"`
	Recommended   bool     `json:"recommended"`
	Repo          string   `json:"repo"`
	Homepage      string   `json:"homepage"`
	Readme        string   `json:"readme"`
	Tarball       string   `json:"tarball"`
	MirrorTarball string   `json:"mirrorTarball"`
	SHA256        string   `json:"sha256"`
	Tags          []string `json:"tags"`
}

type curatedRegistryPayload struct {
	Plugins []curatedRegistryEntry `json:"plugins"`
}

func validCuratedRegistryPayload(raw []byte) bool {
	if len(raw) == 0 || !json.Valid(raw) {
		return false
	}
	var payload curatedRegistryPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return false
	}
	return payload.Plugins != nil
}

func curatedRegistryCandidateURLs(registry string) []string {
	isChina := strings.TrimSpace(registry) == "" || strings.Contains(registry, "npmmirror.com")
	if isChina {
		urls := []string{CuratedRegistryMirrorCDN}
		for _, proxy := range chinaGitHubProxies {
			urls = append(urls, strings.TrimRight(proxy, "/")+"/"+CuratedRegistryURL)
		}
		urls = append(urls, CuratedRegistryURL)
		return urls
	}
	return []string{
		CuratedRegistryURL,
		CuratedRegistryMirrorCDN,
	}
}

// fetchCatalogRegistryFromNpm reads registry.json from the beeftv-plugin-catalog
// npm package on the active npm registry (modeled on DSH catalog-npm.ts).
func fetchCatalogRegistryFromNpm(ctx context.Context, registry string) []byte {
	if err := ctx.Err(); err != nil {
		return nil
	}
	base := strings.TrimRight(strings.TrimSpace(registry), "/")
	if base == "" {
		base = NpmMirrorRegistry
	}
	reqCtx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	defer cancel()
	metaURL := base + "/" + CuratedCatalogPackage + "/latest"
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, metaURL, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Accept", "application/json")
	resp, err := curatedRegistryHTTPClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var meta struct {
		Dist struct {
			Tarball string `json:"tarball"`
		} `json:"dist"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 512<<10)).Decode(&meta); err != nil || strings.TrimSpace(meta.Dist.Tarball) == "" {
		return nil
	}
	tgzReq, err := http.NewRequestWithContext(reqCtx, http.MethodGet, meta.Dist.Tarball, nil)
	if err != nil {
		return nil
	}
	tgzResp, err := curatedRegistryHTTPClient.Do(tgzReq)
	if err != nil {
		return nil
	}
	defer tgzResp.Body.Close()
	if tgzResp.StatusCode != http.StatusOK {
		return nil
	}
	tgzBytes, err := io.ReadAll(io.LimitReader(tgzResp.Body, 2<<20))
	if err != nil {
		return nil
	}
	gz, err := gzip.NewReader(bytes.NewReader(tgzBytes))
	if err != nil {
		return nil
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err != nil {
			break
		}
		cleanName := path.Clean(strings.TrimPrefix(hdr.Name, "./"))
		if cleanName == "package/registry.json" || cleanName == "registry.json" {
			data, err := io.ReadAll(io.LimitReader(tr, 1<<20))
			if err == nil && validCuratedRegistryPayload(data) {
				return data
			}
		}
	}
	return nil
}

func readCuratedRegistry(ctx context.Context) []byte {
	return readCuratedRegistryWithCache(ctx, NpmMirrorRegistry, "")
}

func readCuratedRegistryWithCache(ctx context.Context, registry, cachePath string) []byte {
	if ctx != nil && ctx.Err() == nil {
		if raw := fetchCatalogRegistryFromNpm(ctx, registry); len(raw) > 0 {
			saveCuratedRegistryCache(cachePath, raw)
			return raw
		}
		for _, candidateURL := range curatedRegistryCandidateURLs(registry) {
			if ctx.Err() != nil {
				break
			}
			reqCtx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
			req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, candidateURL, nil)
			if err != nil {
				cancel()
				continue
			}
			resp, err := curatedRegistryHTTPClient.Do(req)
			if err != nil {
				cancel()
				continue
			}
			raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			cancel()
			if resp.StatusCode == http.StatusOK && readErr == nil && validCuratedRegistryPayload(raw) {
				saveCuratedRegistryCache(cachePath, raw)
				return raw
			}
		}
	}
	if strings.TrimSpace(cachePath) != "" {
		if cached, err := os.ReadFile(cachePath); err == nil && validCuratedRegistryPayload(cached) {
			return cached
		}
	}
	marketDir, ok := BundledSampleDir("beeftv-plugin-market")
	if !ok {
		return nil
	}
	raw, _ := os.ReadFile(filepath.Join(marketDir, "registry.json"))
	return raw
}

func saveCuratedRegistryCache(cachePath string, raw []byte) {
	if strings.TrimSpace(cachePath) == "" || len(raw) == 0 {
		return
	}
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		return
	}
	_ = os.WriteFile(cachePath, raw, 0o644)
}

func loadCuratedRegistryItems(ctx context.Context, query string, installed map[string]View) []MarketPluginItem {
	return loadCuratedRegistryItemsWithCache(ctx, query, NpmMirrorRegistry, "", installed)
}

func loadCuratedRegistryItemsWithCache(ctx context.Context, query, registry, cachePath string, installed map[string]View) []MarketPluginItem {
	raw := readCuratedRegistryWithCache(ctx, registry, cachePath)
	if len(raw) == 0 {
		return nil
	}
	var payload curatedRegistryPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil
	}
	q := strings.ToLower(strings.TrimSpace(query))
	out := make([]MarketPluginItem, 0, len(payload.Plugins))
	for _, item := range payload.Plugins {
		if q != "" &&
			!strings.Contains(strings.ToLower(item.ID), q) &&
			!strings.Contains(strings.ToLower(item.PackageName), q) &&
			!strings.Contains(strings.ToLower(item.Name), q) &&
			!strings.Contains(strings.ToLower(item.Description), q) {
			continue
		}
		inst, isInstalled := installed[item.ID]
		pkgName := strings.TrimSpace(item.PackageName)
		if pkgName == "" {
			pkgName = strings.TrimSpace(item.Npm)
		}
		if pkgName == "" {
			pkgName = item.ID
		}
		_, bundled := BundledSampleDir(pkgName)
		repo := strings.TrimSpace(item.Repo)
		homepage := strings.TrimSpace(item.Homepage)
		if homepage == "" {
			homepage = repo
		}
		out = append(out, MarketPluginItem{
			ID:            item.ID,
			Name:          item.Name,
			PackageName:   pkgName,
			Version:       item.Version,
			Description:   item.Description,
			Author:        item.Author,
			Keywords:      item.Tags,
			Tags:          item.Tags,
			Repository:    repo,
			Homepage:      homepage,
			ReadmeURL:     strings.TrimSpace(item.Readme),
			TarballURL:    strings.TrimSpace(item.Tarball),
			MirrorTarball: strings.TrimSpace(item.MirrorTarball),
			SHA256:        strings.TrimSpace(item.SHA256),
			Installed:     isInstalled,
			Enabled:       isInstalled && inst.Status == StatusEnabled,
			Recommended:   item.Recommended,
			Category:      item.Category,
			Bundled:       bundled,
		})
	}
	return out
}

func lookupCuratedPluginEntry(ctx context.Context, idOrSpec, registry, cachePath string) (curatedRegistryEntry, bool) {
	target := strings.TrimSpace(idOrSpec)
	if target == "" {
		return curatedRegistryEntry{}, false
	}
	raw := readCuratedRegistryWithCache(ctx, registry, cachePath)
	if len(raw) == 0 {
		return curatedRegistryEntry{}, false
	}
	var payload curatedRegistryPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return curatedRegistryEntry{}, false
	}
	for _, entry := range payload.Plugins {
		if entry.ID == target || entry.PackageName == target || entry.Npm == target {
			return entry, true
		}
	}
	return curatedRegistryEntry{}, false
}

func matchesMarketQuery(item View, query string) bool {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return true
	}
	return strings.Contains(strings.ToLower(item.Manifest.ID), q) ||
		strings.Contains(strings.ToLower(item.Manifest.Name), q) ||
		strings.Contains(strings.ToLower(item.Manifest.Description), q) ||
		strings.Contains(strings.ToLower(item.PackageSpec), q)
}

func fetchNpmMarketPlugins(ctx context.Context, query string, installed map[string]View) []MarketPluginItem {
	return fetchNpmMarketPluginsWithRegistry(ctx, query, NpmMirrorRegistry, installed)
}

func fetchNpmMarketPluginsWithRegistry(ctx context.Context, query, registry string, installed map[string]View) []MarketPluginItem {
	registries := []string{NpmMirrorRegistry, NpmjsRegistry}
	if strings.TrimRight(strings.TrimSpace(registry), "/") == NpmjsRegistry {
		registries = []string{NpmjsRegistry, NpmMirrorRegistry}
	}
	for _, reg := range registries {
		if ctx != nil && ctx.Err() != nil {
			return nil
		}
		items, ok := searchSingleNpmRegistry(ctx, reg, query, installed)
		if ok && len(items) > 0 {
			return items
		}
	}
	return nil
}

func searchSingleNpmRegistry(ctx context.Context, registry, query string, installed map[string]View) ([]MarketPluginItem, bool) {
	base := strings.TrimRight(strings.TrimSpace(registry), "/")
	trimmedQuery := strings.TrimSpace(query)
	// npmmirror's /-/v1/search returns 0 objects when given the "keywords:"
	// qualifier, so use plain text "beeftv-plugin" on npmmirror and filter in Go
	// (same strategy as Magpie internal/plugin/market.go searchNPM).
	searchTerm := "beeftv-plugin"
	if !strings.Contains(base, "npmmirror.com") {
		searchTerm = "keywords:beeftv-plugin"
	}
	if trimmedQuery != "" {
		searchTerm = trimmedQuery + " " + searchTerm
	}
	reqCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	endpoint := base + "/-/v1/search?text=" + url.QueryEscape(searchTerm) + "&size=30"
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, false
	}
	resp, err := curatedRegistryHTTPClient.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, false
	}
	var payload struct {
		Objects []struct {
			Package struct {
				Name        string   `json:"name"`
				Version     string   `json:"version"`
				Description string   `json:"description"`
				Keywords    []string `json:"keywords"`
				Links       struct {
					Homepage   string `json:"homepage"`
					Repository string `json:"repository"`
				} `json:"links"`
				Publisher struct {
					Username string `json:"username"`
				} `json:"publisher"`
			} `json:"package"`
		} `json:"objects"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		return nil, false
	}
	out := make([]MarketPluginItem, 0, len(payload.Objects))
	for _, obj := range payload.Objects {
		pkg := obj.Package
		if !isBeefTVMarketNpmPackage(pkg.Name, pkg.Keywords) {
			continue
		}
		if trimmedQuery != "" {
			q := strings.ToLower(trimmedQuery)
			if !strings.Contains(strings.ToLower(pkg.Name), q) &&
				!strings.Contains(strings.ToLower(pkg.Description), q) &&
				!keywordsContainQuery(pkg.Keywords, q) {
				continue
			}
		}
		id := protocol.PackageIDFromName(pkg.Name)
		inst, isInstalled := installed[id]
		out = append(out, MarketPluginItem{
			ID:          id,
			Name:        pkg.Name,
			PackageName: pkg.Name,
			Version:     pkg.Version,
			Description: pkg.Description,
			Author:      pkg.Publisher.Username,
			Keywords:    pkg.Keywords,
			Tags:        pkg.Keywords,
			Repository:  pkg.Links.Repository,
			Homepage:    pkg.Links.Homepage,
			Installed:   isInstalled,
			Enabled:     isInstalled && inst.Status == StatusEnabled,
		})
	}
	return out, true
}

func isBeefTVMarketNpmPackage(name string, keywords []string) bool {
	lowerName := strings.ToLower(strings.TrimSpace(name))
	if strings.Contains(lowerName, "beeftv-plugin") && lowerName != CuratedCatalogPackage {
		return true
	}
	for _, kw := range keywords {
		lowerKW := strings.ToLower(strings.TrimSpace(kw))
		if lowerKW == "beeftv-plugin" || lowerKW == "pi-package" {
			return true
		}
	}
	return false
}

func keywordsContainQuery(keywords []string, q string) bool {
	for _, kw := range keywords {
		if strings.Contains(strings.ToLower(kw), q) {
			return true
		}
	}
	return false
}

// FetchMarketReadme resolves README.md for a market plugin even before it is
// installed locally: it checks installed/bundled files first, then curated
// README URLs through the China mirror chain, and finally the npm packument.
func (s *Service) FetchMarketReadme(ctx context.Context, pluginID string, registry ...string) (string, error) {
	trimmed := strings.TrimSpace(pluginID)
	if trimmed == "" {
		return "", packageError(http.StatusBadRequest, "plugin_id_required", "插件 ID 不能为空")
	}
	if s != nil {
		if targetPath, _, err := s.ResolvePackageFile(trimmed, "README.md"); err == nil {
			if data, readErr := os.ReadFile(targetPath); readErr == nil && len(bytes.TrimSpace(data)) > 0 {
				return string(data), nil
			}
		}
	}
	selectedRegistry := NpmMirrorRegistry
	if len(registry) > 0 && strings.TrimSpace(registry[0]) != "" {
		if normalized, err := NormalizeNpmRegistry(registry[0]); err == nil {
			selectedRegistry = normalized
		}
	}
	cachePath := ""
	if s != nil && s.runtime != nil && strings.TrimSpace(s.runtime.dataDir) != "" {
		cachePath = filepath.Join(s.runtime.dataDir, "plugins", "market-registry-cache.json")
	}
	if entry, ok := lookupCuratedPluginEntry(ctx, trimmed, selectedRegistry, cachePath); ok {
		for _, candidate := range expandReadmeMirrorURLs(entry.Readme, entry.Repo, selectedRegistry) {
			if text, ok := fetchRemoteMarkdownText(ctx, candidate); ok {
				return text, nil
			}
		}
	}
	if text, ok := fetchNpmPackumentReadme(ctx, trimmed, selectedRegistry); ok {
		return text, nil
	}
	return "", packageError(http.StatusNotFound, "plugin_readme_not_found", fmt.Sprintf("未找到插件 %q 的说明文档", trimmed))
}

func expandReadmeMirrorURLs(readmeURL, repoURL, registry string) []string {
	rawURL := strings.TrimSpace(readmeURL)
	if rawURL == "" && strings.TrimSpace(repoURL) != "" {
		rawURL = githubTreeURLToRawReadme(repoURL)
	}
	if rawURL == "" {
		return nil
	}
	isChina := strings.TrimSpace(registry) == "" || strings.Contains(registry, "npmmirror.com")
	var out []string
	if jsd := githubRawToJsDelivrURL(rawURL); jsd != "" && isChina {
		out = append(out, jsd)
	}
	if isChina && strings.HasPrefix(rawURL, "https://raw.githubusercontent.com/") {
		for _, proxy := range chinaGitHubProxies {
			out = append(out, strings.TrimRight(proxy, "/")+"/"+rawURL)
		}
	}
	out = append(out, rawURL)
	if jsd := githubRawToJsDelivrURL(rawURL); jsd != "" && !isChina {
		out = append(out, jsd)
	}
	return out
}

func githubTreeURLToRawReadme(repoURL string) string {
	trimmed := strings.TrimSuffix(strings.TrimSpace(repoURL), ".git")
	const prefix = "https://github.com/"
	if !strings.HasPrefix(trimmed, prefix) {
		return ""
	}
	rest := strings.TrimPrefix(trimmed, prefix)
	parts := strings.Split(rest, "/")
	if len(parts) >= 4 && parts[2] == "tree" {
		owner, repo, branch := parts[0], parts[1], parts[3]
		subPath := strings.Join(parts[4:], "/")
		if subPath != "" {
			return fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s/%s/README.md", owner, repo, branch, subPath)
		}
		return fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s/README.md", owner, repo, branch)
	}
	if len(parts) >= 2 {
		return fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/main/README.md", parts[0], parts[1])
	}
	return ""
}

func githubRawToJsDelivrURL(rawURL string) string {
	const prefix = "https://raw.githubusercontent.com/"
	if !strings.HasPrefix(rawURL, prefix) {
		return ""
	}
	rest := strings.TrimPrefix(rawURL, prefix)
	parts := strings.Split(rest, "/")
	if len(parts) < 4 {
		return ""
	}
	owner, repo, branch := parts[0], parts[1], parts[2]
	filePath := strings.Join(parts[3:], "/")
	return fmt.Sprintf("https://cdn.jsdelivr.net/gh/%s/%s@%s/%s", owner, repo, branch, filePath)
}

func fetchRemoteMarkdownText(ctx context.Context, targetURL string) (string, bool) {
	if ctx != nil && ctx.Err() != nil {
		return "", false
	}
	reqCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, targetURL, nil)
	if err != nil {
		return "", false
	}
	resp, err := curatedRegistryHTTPClient.Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", false
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	if err != nil {
		return "", false
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || strings.HasPrefix(strings.ToLower(trimmed), "<!doctype html") {
		return "", false
	}
	return string(data), true
}

func fetchNpmPackumentReadme(ctx context.Context, pkgName, registry string) (string, bool) {
	registries := []string{NpmMirrorRegistry, NpmjsRegistry}
	if strings.TrimRight(strings.TrimSpace(registry), "/") == NpmjsRegistry {
		registries = []string{NpmjsRegistry, NpmMirrorRegistry}
	}
	escaped := strings.ReplaceAll(url.PathEscape(strings.TrimSpace(pkgName)), "%40", "@")
	for _, reg := range registries {
		if ctx != nil && ctx.Err() != nil {
			return "", false
		}
		reqCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, strings.TrimRight(reg, "/")+"/"+escaped, nil)
		if err != nil {
			cancel()
			continue
		}
		req.Header.Set("Accept", "application/json")
		resp, err := curatedRegistryHTTPClient.Do(req)
		if err != nil {
			cancel()
			continue
		}
		var doc struct {
			Readme string `json:"readme"`
		}
		decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&doc)
		resp.Body.Close()
		cancel()
		if resp.StatusCode == http.StatusOK && decodeErr == nil && strings.TrimSpace(doc.Readme) != "" && doc.Readme != "ERROR: No README data found!" {
			return doc.Readme, true
		}
	}
	return "", false
}
