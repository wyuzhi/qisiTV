package app

import (
	"testing"

	"infinite-canvas/backend/internal/assets"
)

func TestResourceIDFromFileURL(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"/api/resources/abc_123/file", "abc_123"},
		{"https://host.example/api/resources/abc_123/file?proxy=1", "abc_123"},
		{"/api/projects/abc_123", ""},
		{"", ""},
	}
	for _, item := range cases {
		if got := assets.IDFromFileURL(item.in); got != item.want {
			t.Fatalf("IDFromFileURL(%q) = %q, want %q", item.in, got, item.want)
		}
	}
}
