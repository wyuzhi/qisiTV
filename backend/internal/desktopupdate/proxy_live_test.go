package desktopupdate

import (
	"context"
	"os"
	"testing"
	"time"
)

// Opt-in acceptance probe against the official signed feed. No private keys,
// installation changes, or credentials are needed.
func TestLiveSystemProxyUpdateDownload(t *testing.T) {
	key := os.Getenv("QISITV_TEST_UPDATER_PUBLIC_KEY")
	feed := os.Getenv("QISITV_TEST_UPDATER_FEED_URL")
	if key == "" || feed == "" {
		t.Skip("set QISITV_TEST_UPDATER_PUBLIC_KEY and QISITV_TEST_UPDATER_FEED_URL for an explicit signed-download test")
	}
	for _, name := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"} {
		old, present := os.LookupEnv(name)
		os.Unsetenv(name)
		t.Cleanup(func() {
			if present {
				os.Setenv(name, old)
			} else {
				os.Unsetenv(name)
			}
		})
	}
	engine := NewWithOptions(Options{CurrentVersion: "v1.5.3", FeedURL: feed, PublicKey: key, StagingRoot: t.TempDir()})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	state, err := engine.CheckForUpdate(ctx)
	if err != nil || state.Status != StatusAvailable {
		t.Fatalf("check status=%s: %v", state.Status, err)
	}
	state, err = engine.DownloadUpdate(ctx)
	if err != nil || state.Status != StatusReady {
		t.Fatalf("download status=%s: %v", state.Status, err)
	}
	t.Logf("signed system-proxy download ready: version=%s bytes=%d", state.LatestVersion, state.DownloadedBytes)
}
