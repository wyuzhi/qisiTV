package handler

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestE2EGenerationRedirectKeepsAuthOnlyForExactOrigin(t *testing.T) {
	policy := e2eUpstreamRedirectPolicy("https://api.example.com/v1")
	cases := []struct {
		url      string
		wantAuth bool
	}{
		{"https://api.example.com/v1/videos/t/content", true},
		{"https://api.example.com:443/v1/videos/t/content", true},
		{"https://sub.api.example.com/v1/videos/t/content", false},
		{"https://cdn.example.com/v1/videos/t/content", false},
		{"http://api.example.com/v1/videos/t/content", false},
		{"https://api.example.com:8443/v1/videos/t/content", false},
	}
	for _, tc := range cases {
		request, err := http.NewRequest(http.MethodGet, tc.url, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer secret")
		if err := policy(request, nil); err != nil {
			t.Fatal(err)
		}
		got := request.Header.Get("Authorization")
		if tc.wantAuth && got != "Bearer secret" {
			t.Fatalf("%s 应保留 Authorization，实际 %q", tc.url, got)
		}
		if !tc.wantAuth && got != "" {
			t.Fatalf("%s 不应携带 Authorization，实际 %q", tc.url, got)
		}
	}
}

func TestE2EGenerationRedirectDropsAuthAndStillDownloads(t *testing.T) {
	var mu sync.Mutex
	var upstreamAuth, cdnAuth string
	cdn := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		cdnAuth = r.Header.Get("Authorization")
		mu.Unlock()
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, "cdn-ok")
	}))
	defer cdn.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		upstreamAuth = r.Header.Get("Authorization")
		mu.Unlock()
		http.Redirect(w, r, cdn.URL+"/signed/file", http.StatusFound)
	}))
	defer upstream.Close()

	proxy := newE2EGenerationUpstream(false, upstream.URL, "real-secret-key", nil, nil)
	server := httptest.NewServer(proxy)
	defer server.Close()
	response, err := http.Get(server.URL + "/v1/videos/t1/content")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	mu.Lock()
	first, redirected := upstreamAuth, cdnAuth
	mu.Unlock()
	if first != "Bearer real-secret-key" {
		t.Fatalf("上游基址没有收到真实密钥: %q", first)
	}
	if redirected != "" {
		t.Fatalf("跨域重定向仍携带 Authorization: %q", redirected)
	}
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "cdn-ok") {
		t.Fatalf("重定向后的下载未成功: %d %q", response.StatusCode, body)
	}
}
