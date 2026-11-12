package plugins

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"qisitv/backend/internal/protocol"
)

// 插件中心查新版本，并自动更新精选列表里由 BeefTV 维护的插件。只查从 npm 或精选列表
// 装的插件；从文件夹、压缩包、GitHub 或网址装的插件没有可比的版本来源。

// UpdateNotice 是一个已安装插件能更新到的版本。
type UpdateNotice struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Latest  string `json:"latest"`
	// Official 表示 BeefTV 会自动把它更新到精选列表登记的版本。用户安装时写明版本的不算。
	Official bool `json:"official,omitempty"`
}

// UpdateCheck 是一次查新版本的结果。不在两份名单里的插件没法比较版本（比如从 GitHub
// 或网址安装），界面照旧让用户自己点更新。
type UpdateCheck struct {
	Updates  []UpdateNotice `json:"updates"`
	UpToDate []string       `json:"upToDate"`
}

const (
	officialUpdateDelay    = time.Minute
	officialUpdateInterval = 6 * time.Hour
	npmSummaryTTL          = 10 * time.Minute
)

// CheckUpdates 查已安装插件有没有新版本。查不到最新版本的插件两份名单都不进。
func (s *Service) CheckUpdates(ctx context.Context, registry string) UpdateCheck {
	check := UpdateCheck{Updates: []UpdateNotice{}, UpToDate: []string{}}
	if s == nil {
		return check
	}
	registry = marketRegistry(registry)
	pinned := pinnedCuratedEntries(readCuratedRegistryWithCache(ctx, registry, s.marketCachePath()))
	var (
		mu sync.Mutex
		wg sync.WaitGroup
	)
	for _, item := range s.List() {
		if item.Source != OriginPackage {
			continue
		}
		name, ok := npmPackageName(item.PackageSpec)
		if !ok {
			continue
		}
		wg.Add(1)
		go func(item View, name string) {
			defer wg.Done()
			notice := UpdateNotice{ID: item.Manifest.ID, Version: item.Manifest.Version}
			if entry, found := pinned[name]; found {
				notice.Latest, notice.Official = strings.TrimSpace(entry.Version), !specNamesVersion(item.PackageSpec)
			} else if summary, found := fetchNpmPackageSummary(ctx, name, registry); found {
				notice.Latest = summary.Version
			}
			if _, ok := parseVersionCore(notice.Latest); !ok {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			if newerVersion(notice.Latest, notice.Version) {
				check.Updates = append(check.Updates, notice)
			} else {
				check.UpToDate = append(check.UpToDate, notice.ID)
			}
		}(item, name)
	}
	wg.Wait()
	sort.Slice(check.Updates, func(i, j int) bool { return check.Updates[i].ID < check.Updates[j].ID })
	sort.Strings(check.UpToDate)
	return check
}

// RunOfficialUpdates 启动一分钟后开始，每 6 小时把精选插件更新到精选列表登记的版本。
// 失败只记日志，下一轮再试；ctx 结束时停下。
func (s *Service) RunOfficialUpdates(ctx context.Context) {
	if s == nil {
		return
	}
	timer := time.NewTimer(officialUpdateDelay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		for _, notice := range s.CheckUpdates(ctx, "").Updates {
			if !notice.Official || ctx.Err() != nil {
				continue
			}
			if _, err := s.UpdatePackage(notice.ID, ""); err != nil {
				log.Printf("自动更新插件 %s 到 %s 失败：%v", notice.ID, notice.Latest, err)
				continue
			}
			log.Printf("插件 %s 已自动更新到 %s", notice.ID, notice.Latest)
		}
		timer.Reset(officialUpdateInterval)
	}
}

func (s *Service) marketCachePath() string {
	if s == nil || s.runtime == nil || strings.TrimSpace(s.runtime.dataDir) == "" {
		return ""
	}
	return filepath.Join(s.runtime.dataDir, "plugins", "market-registry-cache.json")
}

func marketRegistry(registry string) string {
	if normalized, err := NormalizeNpmRegistry(registry); err == nil && strings.TrimSpace(registry) != "" {
		return normalized
	}
	return NpmMirrorRegistry
}

// pinnedCuratedEntries 按包名列出精选列表里带下载地址和校验值的条目，安装和更新都走这个固定版本。
func pinnedCuratedEntries(raw []byte) map[string]curatedRegistryEntry {
	var payload curatedRegistryPayload
	if len(raw) == 0 || json.Unmarshal(raw, &payload) != nil {
		return nil
	}
	pinned := make(map[string]curatedRegistryEntry, len(payload.Plugins))
	for _, entry := range payload.Plugins {
		if strings.TrimSpace(entry.Tarball) == "" && strings.TrimSpace(entry.MirrorTarball) == "" {
			continue
		}
		if !validPackageSHA256(strings.ToLower(strings.TrimSpace(entry.SHA256))) {
			continue
		}
		for _, name := range []string{entry.PackageName, entry.Npm, entry.ID} {
			if name = strings.TrimSpace(name); name != "" {
				pinned[name] = entry
			}
		}
	}
	return pinned
}

// npmPackageName 从安装来源里取出 npm 包名；本地目录、网址、GitHub 和随应用附带的插件不算。
func npmPackageName(spec string) (string, bool) {
	spec = strings.TrimSpace(spec)
	if spec == "" || filepath.IsAbs(spec) || strings.HasPrefix(spec, ".") || strings.Contains(spec, ":") {
		return "", false
	}
	if _, bundled := BundledSampleDir(spec); bundled {
		return "", false
	}
	name, _ := splitNpmPackageSpec(spec)
	return name, name != ""
}

// specNamesVersion 判断用户安装时是否写明了版本。写明版本的插件不自动更新。
func specNamesVersion(spec string) bool {
	_, version := splitNpmPackageSpec(spec)
	return version != "" && version != "latest"
}

// newerVersion 只比较 x.y.z 三段数字；任何一边读不懂时不提示更新。
func newerVersion(latest, current string) bool {
	a, okA := parseVersionCore(latest)
	b, okB := parseVersionCore(current)
	if !okA || !okB {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

func parseVersionCore(raw string) ([3]int, bool) {
	var parts [3]int
	core := strings.TrimPrefix(strings.TrimSpace(raw), "v")
	if cut := strings.IndexAny(core, "-+"); cut >= 0 {
		core = core[:cut]
	}
	fields := strings.Split(core, ".")
	if len(fields) != 3 {
		return parts, false
	}
	for i, field := range fields {
		n, err := strconv.Atoi(field)
		if err != nil || n < 0 {
			return parts, false
		}
		parts[i] = n
	}
	return parts, true
}

// npmRegistriesForTest 让测试把 npm 源换成本地假服务。
var npmRegistriesForTest []string

// npmRegistryOrder 先查用户选的源，失败再查另一个。
func npmRegistryOrder(registry string) []string {
	if npmRegistriesForTest != nil {
		return npmRegistriesForTest
	}
	if strings.TrimRight(strings.TrimSpace(registry), "/") == NpmjsRegistry {
		return []string{NpmjsRegistry, NpmMirrorRegistry}
	}
	return []string{NpmMirrorRegistry, NpmjsRegistry}
}

func npmPackagePath(name string) string {
	trimmed := strings.TrimSpace(name)
	if strings.HasPrefix(trimmed, "@") {
		if parts := strings.SplitN(trimmed[1:], "/", 2); len(parts) == 2 {
			return "@" + url.PathEscape(parts[0]) + "/" + url.PathEscape(parts[1])
		}
	}
	return url.PathEscape(trimmed)
}

var npmSummaryCache = struct {
	sync.Mutex
	items map[string]npmSummaryEntry
}{items: map[string]npmSummaryEntry{}}

type npmSummaryEntry struct {
	item      MarketPluginItem
	fetchedAt time.Time
}

// fetchNpmPackageSummary 读 npm 上某个包最新版本的名称、说明和链接，结果缓存 10 分钟。
func fetchNpmPackageSummary(ctx context.Context, name, registry string) (MarketPluginItem, bool) {
	key := registry + "|" + name
	npmSummaryCache.Lock()
	if cached, ok := npmSummaryCache.items[key]; ok && time.Since(cached.fetchedAt) < npmSummaryTTL {
		npmSummaryCache.Unlock()
		return cached.item, true
	}
	npmSummaryCache.Unlock()
	for _, base := range npmRegistryOrder(registry) {
		if ctx != nil && ctx.Err() != nil {
			return MarketPluginItem{}, false
		}
		resp, err := doMarketGetRequest(ctx, strings.TrimRight(base, "/")+"/"+npmPackagePath(name)+"/latest", 2500*time.Millisecond, "application/json")
		if err != nil {
			continue
		}
		var doc struct {
			Name        string          `json:"name"`
			Version     string          `json:"version"`
			Description string          `json:"description"`
			Keywords    []string        `json:"keywords"`
			Author      any             `json:"author"`
			Homepage    string          `json:"homepage"`
			Repository  json.RawMessage `json:"repository"`
			BeefTV      struct {
				Name string `json:"name"`
			} `json:"beeftv"`
		}
		decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&doc)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || decodeErr != nil || strings.TrimSpace(doc.Version) == "" {
			continue
		}
		item := MarketPluginItem{
			ID:          protocol.PackageIDFromName(doc.Name),
			Name:        firstNonBlank(doc.BeefTV.Name, doc.Name),
			PackageName: doc.Name,
			Version:     strings.TrimSpace(doc.Version),
			Description: strings.TrimSpace(doc.Description),
			Author:      packageAuthorName(doc.Author),
			Keywords:    doc.Keywords,
			Tags:        doc.Keywords,
			Repository:  packageRepositoryURL(doc.Repository),
			Homepage:    strings.TrimSpace(doc.Homepage),
		}
		npmSummaryCache.Lock()
		npmSummaryCache.items[key] = npmSummaryEntry{item: item, fetchedAt: time.Now()}
		npmSummaryCache.Unlock()
		return item, true
	}
	return MarketPluginItem{}, false
}

func packageAuthorName(raw any) string {
	switch typed := raw.(type) {
	case string:
		return strings.TrimSpace(typed)
	case map[string]any:
		name, _ := typed["name"].(string)
		return strings.TrimSpace(name)
	}
	return ""
}

func packageRepositoryURL(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return strings.TrimSpace(text)
	}
	var object struct {
		URL string `json:"url"`
	}
	if json.Unmarshal(raw, &object) == nil {
		return strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(object.URL, "git+"), ".git"))
	}
	return ""
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
