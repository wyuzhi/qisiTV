//go:build darwin || linux

package main

import (
	"context"
	"os"
	"testing"
)

// The DSH bridge is optional. If its control socket path is taken by something
// that is not our socket, the desktop must still open; only DSH attach is lost.
func TestDesktopStartsWhenTheHarnessSocketPathIsTaken(t *testing.T) {
	root := t.TempDir()
	socketPath, err := harnessSocketPath(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(socketPath, []byte("not a socket"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(socketPath) })
	app := newDesktopApp(root)
	app.storageRoot = root
	if err := app.start(context.Background()); err != nil {
		t.Fatalf("desktop did not start with a foreign harness socket path: %v", err)
	}
	defer app.stop(context.Background())
	if app.runtime() == nil || app.runtime().BaseURL() == "" {
		t.Fatal("desktop runtime is not serving")
	}
	if _, ok := desktopHarnesses.Load(app.runtime()); ok {
		t.Fatal("harness bridge reported as running despite the taken socket path")
	}
}
