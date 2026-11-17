package assistantruntime

import (
	"runtime"
	"strings"
	"testing"
)

// envValue 按系统规则读环境变量。Windows 的变量名不分大小写，启动子进程时
// NO_PROXY 和 no_proxy 会合成一条，只留后写的那个写法；按名字精确匹配会读不到。
// 同名多条时取最后一条，和系统一致。
func envValue(env []string, key string) string {
	got := ""
	for _, entry := range env {
		if name, value, ok := strings.Cut(entry, "="); ok && sameEnvName(name, key) {
			got = value
		}
	}
	return got
}

func envHasKey(env []string, key string) bool {
	for _, entry := range env {
		if name, _, ok := strings.Cut(entry, "="); ok && sameEnvName(name, key) {
			return true
		}
	}
	return false
}

func sameEnvName(name, key string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(name, key)
	}
	return name == key
}

func TestHostEnvGeminiProtocolMapping(t *testing.T) {
	if got := hostAPI("gemini-generate-content"); got != "google-generative-ai" {
		t.Fatalf("hostAPI(gemini-generate-content) = %q, want google-generative-ai", got)
	}
	if got := hostAPI("google-gemini-generate-content"); got != "google-generative-ai" {
		t.Fatalf("hostAPI(google-gemini-generate-content) = %q, want google-generative-ai", got)
	}
	cases := []struct {
		raw  string
		want string
	}{
		{"https://generativelanguage.googleapis.com", "https://generativelanguage.googleapis.com/v1beta"},
		{"https://generativelanguage.googleapis.com/v1beta", "https://generativelanguage.googleapis.com/v1beta"},
		{"https://gateway.example.com/v1", "https://gateway.example.com/v1beta"},
		{"https://gateway.example.com#", "https://gateway.example.com"},
	}
	for _, tc := range cases {
		for _, proto := range []string{"gemini-generate-content", "google-gemini-generate-content"} {
			if got := hostBaseURL(tc.raw, proto); got != tc.want {
				t.Fatalf("hostBaseURL(%q, %q) = %q, want %q", tc.raw, proto, got, tc.want)
			}
		}
	}
}
