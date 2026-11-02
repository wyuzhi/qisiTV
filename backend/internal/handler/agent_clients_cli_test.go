package handler

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBundledCLIMustBeDifferentExecutable(t *testing.T) {
	dir := t.TempDir()
	executable := filepath.Join(dir, "qisiTV-engine")
	if err := os.WriteFile(executable, []byte("engine"), 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(dir, "qisitv")
	if err := os.Link(executable, alias); err != nil {
		t.Fatal(err)
	}
	if path, found := bundledCLIPathForExecutable(executable, "qisitv"); found {
		t.Fatalf("engine alias advertised as MCP CLI: %s", path)
	}
	if err := os.Mkdir(filepath.Join(dir, "cli"), 0700); err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(dir, "cli", "qisitv")
	if err := os.WriteFile(cli, []byte("separate CLI"), 0700); err != nil {
		t.Fatal(err)
	}
	resolvedCLI, err := filepath.EvalSymlinks(cli)
	if err != nil {
		t.Fatal(err)
	}
	if path, found := bundledCLIPathForExecutable(executable, "qisitv"); !found || path != resolvedCLI {
		t.Fatalf("valid bundled CLI unavailable: %s %v", path, found)
	}
}
