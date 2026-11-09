//go:build darwin || linux

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHarnessAttachOnlyDoesNotCreateWorkspace(t *testing.T) {
	dataDir := filepath.Join("/tmp", fmt.Sprintf("beeftv-harness-attach-only-%d-%d", os.Getpid(), time.Now().UnixNano()))
	handled, err := handleHarnessCommand([]string{"--harness-runtime", "--harness-attach-only", "--data-dir", dataDir})
	if !handled || err == nil || !strings.Contains(err.Error(), "尚未就绪") {
		t.Fatalf("attach-only did not report the missing desktop runtime: handled=%v err=%v", handled, err)
	}
	if _, err := os.Lstat(dataDir); !os.IsNotExist(err) {
		t.Fatalf("attach-only opened or created a workspace: %v", err)
	}
	if err := validateDesktopArgs([]string{"--harness-attach-only"}); err == nil {
		t.Fatal("attach-only was accepted without the harness entry point")
	}
}

func TestHarnessPrivateControlAttachesWithoutOpeningWorkspace(t *testing.T) {
	// Only a socket file is created. This protocol test never opens a database.
	dataDir := filepath.Join("/tmp", fmt.Sprintf("beeftv-harness-protocol-%d-%d", os.Getpid(), time.Now().UnixNano()))
	want := harnessRuntimeConfig{DesktopRuntimeConfig: DesktopRuntimeConfig{
		BaseURL: "http://127.0.0.1:12345/api", LaunchToken: "desktop-test-token", UIBootstrapToken: "bootstrap-test-token",
	}, BridgeURL: "http://127.0.0.1:12346", BridgeToken: "bridge-test-token", Owned: true}
	listener, err := listenHarnessControl(dataDir, want)
	if err != nil {
		t.Fatal(err)
	}
	socketPath, err := harnessSocketPath(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := validateHarnessSocket(socketPath); err != nil {
		t.Fatal(err)
	}
	got, err := attachDesktopHarness(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if got.BaseURL != want.BaseURL || got.BridgeToken != want.BridgeToken || got.LaunchToken != want.LaunchToken || got.Owned || !got.Attached {
		t.Fatalf("attach contract changed: %#v", got)
	}
	if _, err := os.Stat(dataDir); !os.IsNotExist(err) {
		t.Fatalf("attach created a workspace directory: %v", err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(socketPath); !os.IsNotExist(err) {
		t.Fatalf("control socket remained after shutdown: %v", err)
	}
}
