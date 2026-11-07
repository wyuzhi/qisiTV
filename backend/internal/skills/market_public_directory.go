package skills

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

//go:embed market_skills.json
var publicSkillsSnapshot []byte

var (
	skillsShURL       = "https://www.skills.sh"
	skillsShHTTP      = &http.Client{Timeout: 8 * time.Second}
	publicRepoPattern = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)
	metaDescPattern   = regexp.MustCompile(`<meta\s+name="description"\s+content="([^"]*)"`)

	publicPopularCache = struct {
		sync.Mutex
		list     []skillsShEntry
		at       time.Time
		fallback bool
	}{}

	publicAboutCache = struct {
		sync.Mutex
		m      map[string]string
		loaded bool
	}{m: map[string]string{}}
)

type skillsShEntry struct {
	Source   string `json:"source"`
	SkillID  string `json:"skillId"`
	Name     string `json:"name"`
	Installs int    `json:"installs"`
	Official bool   `json:"isOfficial,omitempty"`
}

type PublicMarketSkill struct {
	ID          string `json:"id"`
	Source      string `json:"source"`
	SkillID     string `json:"skillId"`
	Name        string `json:"name"`
	Installs    int    `json:"installs"`
	Official    bool   `json:"isOfficial,omitempty"`
	Description string `json:"description,omitempty"`
	SourceURL   string `json:"sourceUrl"`
}

type PublicMarketSearchResult struct {
	Items    []PublicMarketSkill `json:"items"`
	Total    int                 `json:"total"`
	Fallback bool                `json:"fallback,omitempty"`
	Notice   string              `json:"notice,omitempty"`
}

func (s *Service) publicMarketCachePath(name string) string {
	if s == nil || strings.TrimSpace(s.dataDir) == "" {
		return ""
	}
	return filepath.Join(s.dataDir, "skill-market", name)
}

func snapshotSkillsShEntries() []skillsShEntry {
	var list []skillsShEntry
	_ = json.Unmarshal(publicSkillsSnapshot, &list)
	return slices.DeleteFunc(list, func(e skillsShEntry) bool {
		return !publicRepoPattern.MatchString(e.Source) || strings.TrimSpace(e.SkillID) == ""
	})
}

func (s *Service) popularPublicSkills(ctx context.Context) ([]skillsShEntry, bool) {
	publicPopularCache.Lock()
	defer publicPopularCache.Unlock()
	if len(publicPopularCache.list) > 0 && time.Since(publicPopularCache.at) < 6*time.Hour {
		return slices.Clone(publicPopularCache.list), publicPopularCache.fallback
	}
	cacheFile := s.publicMarketCachePath("skills-sh-popular.json")
	if list, err := fetchSkillsShPopular(ctx); err == nil && len(list) > 0 {
		publicPopularCache.list = list
		publicPopularCache.at = time.Now()
		publicPopularCache.fallback = false
		if raw, err := json.Marshal(list); err == nil && cacheFile != "" {
			_ = os.MkdirAll(filepath.Dir(cacheFile), 0o700)
			_ = os.WriteFile(cacheFile, raw, 0o600)
		}
		return slices.Clone(list), false
	}
	var list []skillsShEntry
	if cacheFile != "" {
		if raw, err := os.ReadFile(cacheFile); err == nil {
			_ = json.Unmarshal(raw, &list)
		}
	}
	if len(list) == 0 {
		list = snapshotSkillsShEntries()
	}
	publicPopularCache.list = list
	// Retry in 5 minutes after falling back to offline snapshot.
	publicPopularCache.at = time.Now().Add(-6*time.Hour + 5*time.Minute)
	publicPopularCache.fallback = true
	return slices.Clone(list), true
}

func fetchSkillsShPopular(ctx context.Context) ([]skillsShEntry, error) {
	body, err := getSkillsShBytes(ctx, strings.TrimRight(skillsShURL, "/")+"/", "text/html", 8<<20)
	if err != nil {
		return nil, err
	}
	const key = `initialSkills\":`
	idx := strings.Index(string(body), key)
	if idx < 0 {
		return nil, errors.New("skills.sh page has no initialSkills list")
	}
	unescaped := strings.NewReplacer(`\\`, `\`, `\"`, `"`).Replace(string(body[idx+len(key):]))
	var list []skillsShEntry
	if err := json.NewDecoder(strings.NewReader(unescaped)).Decode(&list); err != nil {
		return nil, fmt.Errorf("decode skills.sh popular list: %w", err)
	}
	return slices.DeleteFunc(list, func(e skillsShEntry) bool {
		return !publicRepoPattern.MatchString(e.Source) || strings.TrimSpace(e.SkillID) == ""
	}), nil
}

func searchSkillsSh(ctx context.Context, query string) ([]skillsShEntry, error) {
	endpoint := strings.TrimRight(skillsShURL, "/") + "/api/search?" + url.Values{"q": {query}, "limit": {"40"}}.Encode()
	body, err := getSkillsShBytes(ctx, endpoint, "application/json", 2<<20)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Skills []skillsShEntry `json:"skills"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	return slices.DeleteFunc(payload.Skills, func(e skillsShEntry) bool {
		return !publicRepoPattern.MatchString(e.Source) || strings.TrimSpace(e.SkillID) == ""
	}), nil
}

func getSkillsShBytes(ctx context.Context, targetURL, accept string, limit int64) ([]byte, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, err
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	req.Header.Set("User-Agent", outbound.DefaultOutboundUserAgent)
	resp, err := skillsShHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("skills.sh HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

func (s *Service) MarketPublicSearch(ctx context.Context, query string) (*PublicMarketSearchResult, error) {
	q := strings.ToLower(strings.TrimSpace(query))
	popular, popularFallback := s.popularPublicSkills(ctx)
	var list []skillsShEntry
	for _, entry := range popular {
		if q == "" || strings.Contains(strings.ToLower(entry.Name+" "+entry.Source+" "+entry.SkillID), q) {
			list = append(list, entry)
		}
	}
	if q == "" {
		perRepo := map[string]int{}
		list = slices.DeleteFunc(list, func(e skillsShEntry) bool {
			perRepo[e.Source]++
			return perRepo[e.Source] > 4
		})
	}
	searchFailed := false
	if len([]rune(q)) >= 2 {
		found, err := searchSkillsSh(ctx, q)
		if err != nil {
			searchFailed = true
		} else {
			for _, f := range found {
				if !slices.ContainsFunc(list, func(e skillsShEntry) bool {
					return e.Source == f.Source && e.SkillID == f.SkillID
				}) {
					list = append(list, f)
				}
			}
		}
	}
	usedFallback := popularFallback || searchFailed
	if len(list) == 0 && usedFallback {
		// Network failure must never return an empty list; fall back to the top
		// snapshot skills and surface a clear notice.
		fallbackList := snapshotSkillsShEntries()
		perRepo := map[string]int{}
		for _, entry := range fallbackList {
			perRepo[entry.Source]++
			if perRepo[entry.Source] <= 4 {
				list = append(list, entry)
			}
		}
	}
	if len(list) > 60 {
		list = list[:60]
	}
	about := s.cachedPublicAbout()
	items := make([]PublicMarketSkill, 0, len(list))
	for _, e := range list {
		id := e.Source + "/" + e.SkillID
		name := strings.TrimSpace(e.Name)
		if name == "" {
			name = e.SkillID
		}
		items = append(items, PublicMarketSkill{
			ID:          id,
			Source:      e.Source,
			SkillID:     e.SkillID,
			Name:        name,
			Installs:    e.Installs,
			Official:    e.Official,
			Description: about[id],
			SourceURL:   "https://github.com/" + e.Source,
		})
	}
	notice := ""
	if usedFallback {
		notice = "无法连接公共技能目录，当前展示内置热门技能快照。"
	}
	return &PublicMarketSearchResult{
		Items:    items,
		Total:    len(items),
		Fallback: usedFallback,
		Notice:   notice,
	}, nil
}

func (s *Service) cachedPublicAbout() map[string]string {
	publicAboutCache.Lock()
	defer publicAboutCache.Unlock()
	if !publicAboutCache.loaded {
		publicAboutCache.loaded = true
		if cacheFile := s.publicMarketCachePath("skills-sh-about.json"); cacheFile != "" {
			if raw, err := os.ReadFile(cacheFile); err == nil {
				_ = json.Unmarshal(raw, &publicAboutCache.m)
			}
		}
	}
	return maps.Clone(publicAboutCache.m)
}

func (s *Service) MarketPublicAbout(ctx context.Context, ids []string) map[string]string {
	have := s.cachedPublicAbout()
	out := map[string]string{}
	var wg sync.WaitGroup
	var mu sync.Mutex
	sem := make(chan struct{}, 6)
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if desc, ok := have[id]; ok {
			out[id] = desc
			continue
		}
		lastSlash := strings.LastIndex(id, "/")
		if strings.Count(id, "/") != 2 || lastSlash <= 0 || !publicRepoPattern.MatchString(id[:lastSlash]) {
			continue
		}
		wg.Add(1)
		go func(id string, lastSlash int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			pageURL := strings.TrimRight(skillsShURL, "/") + "/" + id[:lastSlash+1] + url.PathEscape(id[lastSlash+1:])
			body, err := getSkillsShBytes(ctx, pageURL, "text/html", 4<<20)
			if err != nil {
				return
			}
			if desc := extractMetaDescription(body); desc != "" {
				mu.Lock()
				out[id] = desc
				mu.Unlock()
			}
		}(id, lastSlash)
	}
	wg.Wait()
	publicAboutCache.Lock()
	changed := false
	for id, desc := range out {
		if _, ok := publicAboutCache.m[id]; !ok {
			publicAboutCache.m[id] = desc
			changed = true
		}
	}
	if changed {
		if cacheFile := s.publicMarketCachePath("skills-sh-about.json"); cacheFile != "" {
			if raw, err := json.Marshal(publicAboutCache.m); err == nil {
				_ = os.MkdirAll(filepath.Dir(cacheFile), 0o700)
				_ = os.WriteFile(cacheFile, raw, 0o600)
			}
		}
	}
	publicAboutCache.Unlock()
	return out
}

func extractMetaDescription(page []byte) string {
	match := metaDescPattern.FindSubmatch(page)
	if match == nil {
		return ""
	}
	return strings.TrimSpace(html.UnescapeString(string(match[1])))
}
