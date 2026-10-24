package assistantruntime

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEngineSidecarHostOnEveryDesktopLayout(t *testing.T) {
	for _, platform := range []string{"darwin", "linux", "windows"} {
		t.Run(platform, func(t *testing.T) {
			root := t.TempDir()
			binary := filepath.Join(root, "qisitv-engine")
			entry := filepath.Join(root, "agent-host", "server.mjs")
			node := filepath.Join(root, "agent-host", "runtime", "bin", "node")
			if platform == "windows" {
				node = filepath.Join(root, "agent-host", "runtime", "node.exe")
			}
			if err := os.MkdirAll(filepath.Dir(node), 0o700); err != nil {
				t.Fatal(err)
			}
			for _, file := range []string{node, entry} {
				if err := os.WriteFile(file, []byte("fixture"), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			config := BundledConfig(binary, platform)
			if config.HostCommand != node || len(config.HostArgs) != 1 || config.HostArgs[0] != entry {
				t.Fatalf("sidecar not discovered: %+v", config)
			}
			if err := os.Remove(entry); err != nil {
				t.Fatal(err)
			}
			if config := BundledConfig(binary, platform); config.HostCommand != "" {
				t.Fatalf("incomplete sidecar accepted: %+v", config)
			}
		})
	}
}
