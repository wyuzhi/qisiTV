package plugins

import (
	"bytes"
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
	"sync"
	"time"

	"qisitv/backend/internal/outbound"
	"qisitv/backend/internal/protocol"
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
	var (
		remoteItems  []MarketPluginItem
		curatedItems []MarketPluginItem
		wg           sync.WaitGroup
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		remoteItems = fetchNpmMarketPluginsWithRegistry(ctx, query, selectedRegistry, installedByID)
	}()
	go func() {
		defer wg.Done()
		curatedItems = loadCuratedRegistryItemsWithCache(ctx, query, selectedRegistry, cachePath, installedByID)
	}()
	wg.Wait()
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

var (
	allowedMarketPublicHosts = map[string]bool{
		"cdn.jsdelivr.net":                     true,
		"raw.githubusercontent.com":            true,
		"github.com":                           true,
		"objects.githubusercontent.com":        true,
		"release-assets.githubusercontent.com": true,
		"codeload.github.com":                  true,
		"gh-proxy.com":                         true,
		"ghfast.top":                           true,
		"registry.npmmirror.com":               true,
		"cdn.npmmirror.com":                    true,
		"registry.npmjs.org":                   true,
	}
	allowLoopbackMarketURLsForTest bool
)

func validateMarketOutboundURL(ctx context.Context, rawURL string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Hostname() == "" || parsed.User != nil {
		return nil, fmt.Errorf("无效的市场资源地址")
	}
	host := strings.ToLower(parsed.Hostname())
	if allowLoopbackMarketURLsForTest && (host == "127.0.0.1" || host == "localhost") && (parsed.Scheme == "http" || parsed.Scheme == "https") {
		return parsed, nil
	}
	if parsed.Scheme != "https" {
		return nil, fmt.Errorf("市场远程地址必须使用 HTTPS")
	}
	if !allowedMarketPublicHosts[host] {
		return nil, fmt.Errorf("不允许访问未授权的市场域名 %q", host)
	}
	cleanURL := *parsed
	cleanURL.Fragment = ""
	if _, err := outbound.ValidatePublicHTTPSURLContext(ctx, cleanURL.String()); err != nil {
		return nil, err
	}
	return parsed, nil
}

func doMarketGetRequest(ctx context.Context, targetURL string, timeout time.Duration, accept string) (*http.Response, error) {
	if _, err := validateMarketOutboundURL(ctx, targetURL); err != nil {
		return nil, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, targetURL, nil)
	if err != nil {
		cancel()
		return nil, err
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	client := &http.Client{
		Timeout: timeout,
		CheckRedirect: func(redirectReq *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("重定向次数过多")
			}
			_, err := validateMarketOutboundURL(redirectReq.Context(), redirectReq.URL.String())
			return err
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		cancel()
		return nil, err
	}
	resp.Body = &contextClosingReadCloser{ReadCloser: resp.Body, cancel: cancel}
	return resp, nil
}

type contextClosingReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c *contextClosingReadCloser) Close() error {
	defer c.cancel()
	return c.ReadCloser.Close()
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
	for _, reg := range npmRegistryOrder(registry) {
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
	endpoint := base + "/-/v1/search?text=" + url.QueryEscape(searchTerm) + "&size=30"
	resp, err := doMarketGetRequest(ctx, endpoint, 3500*time.Millisecond, "application/json")
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
		for _, candidateID := range []string{trimmed, protocol.PackageIDFromName(trimmed)} {
			if candidateID == "" {
				continue
			}
			if targetPath, _, err := s.ResolvePackageFile(candidateID, "README.md"); err == nil {
				if data, readErr := os.ReadFile(targetPath); readErr == nil && len(bytes.TrimSpace(data)) > 0 {
					return string(data), nil
				}
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
	resp, err := doMarketGetRequest(ctx, targetURL, 2500*time.Millisecond, "text/markdown, text/plain;q=0.9")
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
	if trimmed == "" || strings.HasPrefix(strings.ToLower(trimmed), "<!doctype html") || strings.HasPrefix(strings.ToLower(trimmed), "<html") {
		return "", false
	}
	return string(data), true
}

func fetchNpmPackumentReadme(ctx context.Context, pkgName, registry string) (string, bool) {
	registries := npmRegistryOrder(registry)
	trimmed := strings.TrimSpace(pkgName)
	escapedSlash := strings.ReplaceAll(url.PathEscape(trimmed), "%40", "@")
	unencodedSlash := escapedSlash
	if strings.HasPrefix(trimmed, "@") {
		if parts := strings.SplitN(trimmed[1:], "/", 2); len(parts) == 2 {
			unencodedSlash = "@" + url.PathEscape(parts[0]) + "/" + url.PathEscape(parts[1])
		}
	}
	suffixes := []string{"/" + unencodedSlash + "/latest", "/" + unencodedSlash}
	if escapedSlash != unencodedSlash {
		suffixes = append(suffixes, "/"+escapedSlash)
	}
	for _, reg := range registries {
		base := strings.TrimRight(reg, "/")
		for _, suffix := range suffixes {
			if ctx != nil && ctx.Err() != nil {
				return "", false
			}
			resp, err := doMarketGetRequest(ctx, base+suffix, 2500*time.Millisecond, "application/json")
			if err != nil {
				continue
			}
			var doc struct {
				Readme string `json:"readme"`
			}
			decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&doc)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK && decodeErr == nil && strings.TrimSpace(doc.Readme) != "" && doc.Readme != "ERROR: No README data found!" {
				return doc.Readme, true
			}
		}
	}
	return "", false
}
