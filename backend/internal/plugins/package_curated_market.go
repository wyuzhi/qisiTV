package plugins

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// CuratedRegistryURL and CuratedRegistryMirrorCDN are the authenticated public
// recommendation list endpoints for Sunnyender-org/beeftv-plugins. Only these
// two official repository origins are trusted for registry.json so the SHA-256
// pins inside registry.json cannot be tampered with by third-party proxies.
const (
	CuratedRegistryURL       = "https://raw.githubusercontent.com/Sunnyender-org/beeftv-plugins/main/registry.json"
	CuratedRegistryMirrorCDN = "https://cdn.jsdelivr.net/gh/Sunnyender-org/beeftv-plugins@main/registry.json"
	CuratedCatalogPackage    = "beeftv-plugin-catalog"

	curatedRegistryMemTTL = 2 * time.Minute
)

var (
	curatedRegistryMemCache = struct {
		sync.Mutex
		raw       []byte
		fetchedAt time.Time
	}{}
	curatedRegistryFileMu sync.Mutex
)

// CuratedMarket serves local recommendations immediately when cached is set.
// The client refreshes the catalog separately, without waiting for npm search.
func (s *Service) CuratedMarket(ctx context.Context, registry string, cached bool) []MarketPluginItem {
	if normalized, err := NormalizeNpmRegistry(registry); err == nil {
		registry = normalized
	} else {
		registry = NpmMirrorRegistry
	}
	installed := map[string]View{}
	cachePath := ""
	if s != nil {
		if s.runtime != nil && strings.TrimSpace(s.runtime.dataDir) != "" {
			cachePath = filepath.Join(s.runtime.dataDir, "plugins", "market-registry-cache.json")
		}
		for _, item := range s.List() {
			installed[item.Manifest.ID] = item
		}
	}
	if !cached {
		return loadCuratedRegistryItemsWithCache(ctx, "", registry, cachePath, installed)
	}
	curatedRegistryMemCache.Lock()
	raw := append([]byte(nil), curatedRegistryMemCache.raw...)
	curatedRegistryMemCache.Unlock()
	if len(raw) == 0 {
		raw = readCuratedRegistryWithCache(nil, registry, cachePath)
	}
	return curatedRegistryItems(nil, raw, "", registry, installed)
}

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
	// Packages 只写 npm 包名，名称、说明和版本从 npm 读，上架只需加一行。
	// 已发布的旧版 BeefTV 不认这个键，会直接忽略，不会出现缺信息的卡片。
	Packages []string `json:"packages"`
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
		return []string{
			CuratedRegistryMirrorCDN,
			CuratedRegistryURL,
		}
	}
	return []string{
		CuratedRegistryURL,
		CuratedRegistryMirrorCDN,
	}
}

func readCuratedRegistry(ctx context.Context) []byte {
	return readCuratedRegistryWithCache(ctx, NpmMirrorRegistry, "")
}

func readCuratedRegistryWithCache(ctx context.Context, registry, cachePath string) []byte {
	if ctx != nil && ctx.Err() == nil {
		curatedRegistryMemCache.Lock()
		if len(curatedRegistryMemCache.raw) > 0 && time.Since(curatedRegistryMemCache.fetchedAt) < curatedRegistryMemTTL {
			cached := append([]byte(nil), curatedRegistryMemCache.raw...)
			curatedRegistryMemCache.Unlock()
			return cached
		}
		curatedRegistryMemCache.Unlock()

		for _, candidateURL := range curatedRegistryCandidateURLs(registry) {
			if ctx.Err() != nil {
				break
			}
			resp, err := doMarketGetRequest(ctx, candidateURL, 2500*time.Millisecond, "application/json")
			if err != nil {
				continue
			}
			raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK && readErr == nil && validCuratedRegistryPayload(raw) {
				curatedRegistryMemCache.Lock()
				curatedRegistryMemCache.raw = append([]byte(nil), raw...)
				curatedRegistryMemCache.fetchedAt = time.Now()
				curatedRegistryMemCache.Unlock()
				saveCuratedRegistryCache(cachePath, raw)
				return raw
			}
		}
	}
	if strings.TrimSpace(cachePath) != "" {
		curatedRegistryFileMu.Lock()
		cached, err := os.ReadFile(cachePath)
		curatedRegistryFileMu.Unlock()
		if err == nil && validCuratedRegistryPayload(cached) {
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
	if strings.TrimSpace(cachePath) == "" || !validCuratedRegistryPayload(raw) {
		return
	}
	curatedRegistryFileMu.Lock()
	defer curatedRegistryFileMu.Unlock()
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		return
	}
	_ = writePluginFile(cachePath, raw)
}

func loadCuratedRegistryItems(ctx context.Context, query string, installed map[string]View) []MarketPluginItem {
	return loadCuratedRegistryItemsWithCache(ctx, query, NpmMirrorRegistry, "", installed)
}

func loadCuratedRegistryItemsWithCache(ctx context.Context, query, registry, cachePath string, installed map[string]View) []MarketPluginItem {
	raw := readCuratedRegistryWithCache(ctx, registry, cachePath)
	return curatedRegistryItems(ctx, raw, query, registry, installed)
}

func curatedRegistryItems(ctx context.Context, raw []byte, query, registry string, installed map[string]View) []MarketPluginItem {
	if len(raw) == 0 {
		return nil
	}
	var payload curatedRegistryPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil
	}
	q := strings.ToLower(strings.TrimSpace(query))
	out := make([]MarketPluginItem, 0, len(payload.Plugins)+len(payload.Packages))
	listed := map[string]bool{}
	for _, item := range payload.Plugins {
		listed[strings.TrimSpace(item.PackageName)], listed[strings.TrimSpace(item.Npm)], listed[strings.TrimSpace(item.ID)] = true, true, true
	}
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
	if ctx == nil {
		return out
	}
	return append(out, listedPackageItems(ctx, payload.Packages, listed, q, registry, installed)...)
}

// listedPackageItems 把精选列表里只写包名的条目补全成市场卡片，查不到 npm 的跳过。
func listedPackageItems(ctx context.Context, names []string, listed map[string]bool, query, registry string, installed map[string]View) []MarketPluginItem {
	items := make([]MarketPluginItem, len(names))
	found := make([]bool, len(names))
	var wg sync.WaitGroup
	for index, name := range names {
		name = strings.TrimSpace(name)
		if name == "" || listed[name] {
			continue
		}
		listed[name] = true
		wg.Add(1)
		go func(index int, name string) {
			defer wg.Done()
			items[index], found[index] = fetchNpmPackageSummary(ctx, name, registry)
		}(index, name)
	}
	wg.Wait()
	out := make([]MarketPluginItem, 0, len(names))
	for index, item := range items {
		if !found[index] {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(item.PackageName), query) && !strings.Contains(strings.ToLower(item.Name), query) && !strings.Contains(strings.ToLower(item.Description), query) {
			continue
		}
		inst, isInstalled := installed[item.ID]
		item.Installed, item.Enabled, item.Recommended = isInstalled, isInstalled && inst.Status == StatusEnabled, true
		out = append(out, item)
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
