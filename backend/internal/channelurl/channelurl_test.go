package channelurl

import "testing"

func TestRawBaseMarkersAndNormalization(t *testing.T) {
	if !IsRawBase("http://127.0.0.1#") || !IsRawBase("  http://127.0.0.1:8000/custom/# ") {
		t.Fatal("expected trailing single # to be recognized as raw base")
	}
	for _, invalid := range []string{"http://127.0.0.1", "http://127.0.0.1#frag", "http://127.0.0.1##", "http://127.0.0.1/#/", "http://127.0.0.1/#//"} {
		if IsRawBase(invalid) {
			t.Fatalf("IsRawBase(%q) = true, want false", invalid)
		}
		first := NormalizeBase(invalid)
		second := NormalizeBase(first)
		if first != second {
			t.Fatalf("NormalizeBase(%q) non-idempotent: %q -> %q", invalid, first, second)
		}
		if IsRawBase(first) {
			t.Fatalf("NormalizeBase(%q) = %q turned invalid fragment into raw base", invalid, first)
		}
	}
	if got := CleanBase(" http://127.0.0.1:8000/custom/# "); got != "http://127.0.0.1:8000/custom" {
		t.Fatalf("CleanBase = %q", got)
	}
	if got := NormalizeBase(" http://127.0.0.1:8000/custom/# "); got != "http://127.0.0.1:8000/custom#" {
		t.Fatalf("NormalizeBase = %q", got)
	}
	if got := NormalizeBase(" # "); got != "" {
		t.Fatalf("NormalizeBase(#) = %q, want empty", got)
	}
}

func TestJoinRawAndVersionedParity(t *testing.T) {
	cases := []struct {
		base, path, want string
	}{
		{"http://127.0.0.1#", "/models", "http://127.0.0.1/models"},
		{"http://127.0.0.1#", "/chat/completions", "http://127.0.0.1/chat/completions"},
		{"http://127.0.0.1#", "/v1/videos", "http://127.0.0.1/videos"},
		{"http://127.0.0.1/#", "/v1/video/generations", "http://127.0.0.1/video/generations"},
		{"http://127.0.0.1:8000/custom#", "/v1/images/generations", "http://127.0.0.1:8000/custom/images/generations"},
		{"http://127.0.0.1/v2#", "/v1/videos", "http://127.0.0.1/v2/videos"},
		{"http://127.0.0.1/videos#", "/v1/videos", "http://127.0.0.1/videos"},
		{"https://gateway.example.com#", "/v1beta/models/gemini:generateContent", "https://gateway.example.com/models/gemini:generateContent"},
		{"https://host", "/v1/chat/completions", "https://host/v1/chat/completions"},
		{"https://host/api/v1", "/v1/chat/completions", "https://host/v1/chat/completions"},
	}
	for _, tc := range cases {
		if got := Join(tc.base, tc.path, "/v1"); got != tc.want {
			t.Fatalf("Join(%q, %q) = %q, want %q", tc.base, tc.path, got, tc.want)
		}
	}
}
