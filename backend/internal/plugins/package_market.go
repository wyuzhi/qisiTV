package plugins

import (
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
		if officialDir, err := officialPluginPackageDir(); err == nil && trimmedID != "" && !strings.ContainsAny(trimmedID, `/\..`) {
			candidate := filepath.Join(officialDir, trimmedID)
			if info, statErr := os.Stat(filepath.Join(candidate, "package.json")); statErr == nil && !info.IsDir() {
				pkgDir = candidate
				ok = true
			}
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

func (s *Service) SearchMarket(ctx context.Context, query string) ([]MarketPluginItem, error) {
	installedByID := map[string]View{}
	var localItems []MarketPluginItem
	if s != nil {
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
	remoteItems := fetchNpmMarketPlugins(ctx, query, installedByID)
	curatedItems := loadCuratedRegistryItems(ctx, query, installedByID)
	seen := make(map[string]struct{}, len(localItems)+len(curatedItems)+len(remoteItems))
	merged := make([]MarketPluginItem, 0, len(localItems)+len(curatedItems)+len(remoteItems))
	for _, item := range localItems {
		seen[item.ID] = struct{}{}
		merged = append(merged, item)
	}
	for _, item := range curatedItems {
		if _, exists := seen[item.ID]; exists {
			continue
		}
		seen[item.ID] = struct{}{}
		merged = append(merged, item)
	}
	for _, item := range remoteItems {
		if _, exists := seen[item.ID]; exists {
			continue
		}
		seen[item.ID] = struct{}{}
		merged = append(merged, item)
	}
	return merged, nil
}

// CuratedRegistryURL is the public recommendation list; authors add a line by
// pull request. The copy shipped with the market plugin covers offline use.
const CuratedRegistryURL = "https://raw.githubusercontent.com/Sunnyender-org/beeftv-plugins/main/registry.json"

func readCuratedRegistry(ctx context.Context) []byte {
	reqCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, CuratedRegistryURL, nil); err == nil {
		if resp, err := http.DefaultClient.Do(req); err == nil {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				if raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)); err == nil && json.Valid(raw) {
					return raw
				}
			}
		}
	}
	officialDir, err := officialPluginPackageDir()
	if err != nil {
		return nil
	}
	raw, _ := os.ReadFile(filepath.Join(officialDir, "beeftv-plugin-market", "registry.json"))
	return raw
}

func loadCuratedRegistryItems(ctx context.Context, query string, installed map[string]View) []MarketPluginItem {
	raw := readCuratedRegistry(ctx)
	if len(raw) == 0 {
		return nil
	}
	var payload struct {
		Plugins []struct {
			ID          string   `json:"id"`
			PackageName string   `json:"packageName"`
			Name        string   `json:"name"`
			Version     string   `json:"version"`
			Description string   `json:"description"`
			Author      string   `json:"author"`
			Category    string   `json:"category"`
			Recommended bool     `json:"recommended"`
			Tags        []string `json:"tags"`
		} `json:"plugins"`
	}
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
		pkgName := item.PackageName
		if pkgName == "" {
			pkgName = item.ID
		}
		_, bundled := BundledSampleDir(pkgName)
		out = append(out, MarketPluginItem{
			ID:          item.ID,
			Name:        item.Name,
			PackageName: pkgName,
			Version:     item.Version,
			Description: item.Description,
			Author:      item.Author,
			Keywords:    item.Tags,
			Installed:   isInstalled,
			Enabled:     isInstalled && inst.Status == StatusEnabled,
			Recommended: item.Recommended,
			Category:    item.Category,
			Bundled:     bundled,
		})
	}
	return out
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
	searchTerm := "keywords:beeftv-plugin"
	if trimmed := strings.TrimSpace(query); trimmed != "" {
		searchTerm = trimmed + " keywords:beeftv-plugin"
	}
	reqCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	endpoint := "https://registry.npmjs.org/-/v1/search?text=" + url.QueryEscape(searchTerm) + "&size=20"
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var payload struct {
		Objects []struct {
			Package struct {
				Name        string   `json:"name"`
				Version     string   `json:"version"`
				Description string   `json:"description"`
				Keywords    []string `json:"keywords"`
				Publisher   struct {
					Username string `json:"username"`
				} `json:"publisher"`
			} `json:"package"`
		} `json:"objects"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		return nil
	}
	out := make([]MarketPluginItem, 0, len(payload.Objects))
	for _, obj := range payload.Objects {
		pkg := obj.Package
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
			Installed:   isInstalled,
			Enabled:     isInstalled && inst.Status == StatusEnabled,
		})
	}
	return out
}
