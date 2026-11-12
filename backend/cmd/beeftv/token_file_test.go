package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveClientTokenPrefersFileAndDoesNotFallBack(t *testing.T) {
	dir := t.TempDir()
	tokenFile := filepath.Join(dir, "claude.token")
	if err := os.WriteFile(tokenFile, []byte("  file-token \n"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("BEEFTV_CLIENT_TOKEN", "env-token")
	t.Setenv("BEEFTV_CLIENT_TOKEN_FILE", tokenFile)
	if got := resolveClientToken(); got != "file-token" {
		t.Fatalf("file token should win, got %q", got)
	}

	t.Setenv("BEEFTV_CLIENT_TOKEN_FILE", filepath.Join(dir, "missing.token"))
	if got := resolveClientToken(); got != "" {
		t.Fatalf("missing token file must not fall back to the env token, got %q", got)
	}

	emptyFile := filepath.Join(dir, "empty.token")
	if err := os.WriteFile(emptyFile, []byte(" \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BEEFTV_CLIENT_TOKEN_FILE", emptyFile)
	if got := resolveClientToken(); got != "" {
		t.Fatalf("empty token file must be unauthenticated, got %q", got)
	}

	t.Setenv("BEEFTV_CLIENT_TOKEN_FILE", "")
	if got := resolveClientToken(); got != "env-token" {
		t.Fatalf("manual env token should still work, got %q", got)
	}
}
