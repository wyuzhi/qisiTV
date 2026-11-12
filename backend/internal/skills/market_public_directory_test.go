package skills

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func resetPublicMarketCachesForTest() {
	publicPopularCache.Lock()
	publicPopularCache.list = nil
	publicPopularCache.at = time.Time{}
	publicPopularCache.fallback = false
	publicPopularCache.Unlock()

	publicAboutCache.Lock()
	publicAboutCache.m = map[string]string{}
	publicAboutCache.loaded = false
	publicAboutCache.Unlock()
}

func TestMarketPublicSearchLiveAndAbout(t *testing.T) {
	s, _ := agentSkillFixture(t)
	resetPublicMarketCachesForTest()
	t.Cleanup(resetPublicMarketCachesForTest)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			list := `[{"source":"anthropics/skills","skillId":"frontend-design","name":"frontend-design","installs":920400,"isOfficial":true},{"source":"invalid repo","skillId":"bad","name":"bad"}]`
			js, _ := json.Marshal(`{"initialSkills":` + list + `}`)
			_, _ = w.Write([]byte(`<html><script>self.__next_f.push([1,` + string(js) + `])</script></html>`))
		case "/api/search":
			if r.URL.Query().Get("q") != "react" {
				t.Errorf("unexpected search query: %q", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"skills": []map[string]any{
					{"source": "vercel-labs/agent-skills", "skillId": "vercel-react-best-practices", "name": "vercel-react-best-practices", "installs": 742023, "isOfficial": true},
				},
			})
		case "/anthropics/skills/frontend-design":
			_, _ = w.Write([]byte(`<html><head><meta name="description" content="Distinctive &amp; intentional UI design"/></head></html>`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	prevURL := skillsShURL
	skillsShURL = srv.URL
	t.Cleanup(func() { skillsShURL = prevURL })

	res, err := s.MarketPublicSearch(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Fallback || res.Notice != "" || len(res.Items) != 1 || res.Items[0].Source != "anthropics/skills" || res.Items[0].Installs != 920400 {
		t.Fatalf("unexpected live popular result: %+v", res)
	}

	searched, err := s.MarketPublicSearch(context.Background(), "react")
	if err != nil {
		t.Fatal(err)
	}
	if searched.Fallback || len(searched.Items) != 1 || searched.Items[0].SkillID != "vercel-react-best-practices" {
		t.Fatalf("unexpected live search result: %+v", searched)
	}

	about := s.MarketPublicAbout(context.Background(), []string{"anthropics/skills/frontend-design", "invalid"})
	if about["anthropics/skills/frontend-design"] != "Distinctive & intentional UI design" {
		t.Fatalf("unexpected about map: %+v", about)
	}
}

func TestMarketPublicSearchOfflineFallbackNeverReturnsEmptyList(t *testing.T) {
	s, _ := agentSkillFixture(t)
	resetPublicMarketCachesForTest()
	t.Cleanup(resetPublicMarketCachesForTest)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	prevURL := skillsShURL
	skillsShURL = srv.URL
	t.Cleanup(func() { skillsShURL = prevURL })

	for _, query := range []string{"", "frontend", "nonexistent-offline-query-xyz"} {
		res, err := s.MarketPublicSearch(context.Background(), query)
		if err != nil {
			t.Fatalf("query %q returned error: %v", query, err)
		}
		if !res.Fallback || res.Notice == "" || len(res.Items) == 0 {
			t.Fatalf("query %q did not fall back to non-empty snapshot with notice: %+v", query, res)
		}
		if res.Items[0].Source == "" || res.Items[0].Installs <= 0 || !strings.HasPrefix(res.Items[0].SourceURL, "https://github.com/") {
			t.Fatalf("snapshot item missing attribution: %+v", res.Items[0])
		}
	}
}

func TestInstallPublicSkillViaGitHubRootAndSubdir(t *testing.T) {
	s, _ := agentSkillFixture(t)
	commitSHA := strings.Repeat("c", 40)
	buildRootSkillZip := func() []byte {
		var buf bytes.Buffer
		w := zip.NewWriter(&buf)
		_ = w.SetComment(commitSHA)
		entry, _ := w.Create("agent-browser-" + commitSHA + "/SKILL.md")
		_, _ = entry.Write([]byte("---\nname: agent-browser\ndescription: Browser automation skill\n---\n# 浏览器自动化\n\n步骤说明。\n"))
		_ = w.Close()
		return buf.Bytes()
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/vercel-labs/agent-browser":
			_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
		case "/repos/vercel-labs/agent-browser/commits/main":
			_ = json.NewEncoder(w).Encode(map[string]any{"sha": commitSHA})
		case "/vercel-labs/agent-browser/zip/" + commitSHA:
			_, _ = w.Write(buildRootSkillZip())
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	prevAPI, prevCodeload := githubAPIBaseURL, githubCodeloadBaseURL
	githubAPIBaseURL, githubCodeloadBaseURL = srv.URL, srv.URL
	t.Cleanup(func() {
		githubAPIBaseURL, githubCodeloadBaseURL = prevAPI, prevCodeload
	})

	installed, err := s.InstallGitHubSkill("owner", SkillGitHubInstallRequest{
		URL:        "https://github.com/vercel-labs/agent-browser",
		Subdir:     "agent-browser",
		Tag:        "others",
		IsPrivate:  true,
		AutoUpdate: true,
	})
	if err != nil {
		t.Fatalf("InstallGitHubSkill failed for public directory skill: %v", err)
	}
	if installed.SourceType != "github" || installed.SourceURL != "https://github.com/vercel-labs/agent-browser" || installed.SkillName != "浏览器自动化" {
		t.Fatalf("unexpected installed skill: %+v", installed)
	}
}
