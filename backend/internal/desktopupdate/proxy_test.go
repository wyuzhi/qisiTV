package desktopupdate

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"

	"golang.org/x/net/http/httpproxy"
)

func TestSystemProxySelection(t *testing.T) {
	windows := parseWindowsProxy("http=127.0.0.1:8080;https=127.0.0.1:7890", "*.internal;<local>")
	mac := parseMacProxy(`<dictionary> {
  ExceptionsList : <array> {
    0 : *.internal
    1 : 10.0.0.0/8
  }
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 8080
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7890
  ExcludeSimpleHostnames : 1
}`)
	for _, system := range []systemProxySettings{windows, mac} {
		for _, tc := range []struct{ target, noProxy, want string }{
			{"https://github.com/a", "", "http://127.0.0.1:7890"},
			{"https://release-assets.githubusercontent.com/a", "", "http://127.0.0.1:7890"},
			{"http://example.com", "", "http://127.0.0.1:8080"},
			{"https://github.com/a", "github.com", ""},
			{"https://host.internal", "", ""},
			{"https://intranet", "", ""},
			{"https://127.0.0.1", "", ""},
		} {
			target, _ := url.Parse(tc.target)
			got, err := proxyWithSystem(target, httpproxy.Config{NoProxy: tc.noProxy}, system)
			actual := ""
			if got != nil {
				actual = got.String()
			}
			if err != nil || actual != tc.want {
				t.Errorf("%s: proxy %q error %v, want %q", tc.target, actual, err, tc.want)
			}
		}
	}
	for _, system := range []systemProxySettings{parseWindowsProxy("", ""), parseMacProxy("HTTPSEnable : 0\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890"), parseMacProxy("HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 99999")} {
		target, _ := url.Parse("https://github.com")
		got, err := proxyWithSystem(target, httpproxy.Config{}, system)
		if err != nil || got != nil {
			t.Fatalf("disabled or invalid system proxy: %v %v", got, err)
		}
	}
	if parseWindowsProxy("127.0.0.1:7890", "").config.HTTPSProxy != "127.0.0.1:7890" {
		t.Fatal("single Windows proxy was lost")
	}
}

func TestExplicitProxyAndBypassTakePriority(t *testing.T) {
	t.Setenv("HTTP_PROXY", "")
	t.Setenv("http_proxy", "")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:5555")
	t.Setenv("https_proxy", "")
	t.Setenv("NO_PROXY", "github.com")
	t.Setenv("no_proxy", "")
	for _, tc := range []struct{ target, want string }{{"https://example.com", "http://127.0.0.1:5555"}, {"https://github.com", ""}} {
		req, _ := http.NewRequest(http.MethodGet, tc.target, nil)
		got, err := desktopProxy(req)
		actual := ""
		if got != nil {
			actual = got.String()
		}
		if err != nil || actual != tc.want {
			t.Fatalf("explicit proxy %q, %v", actual, err)
		}
	}
}

// Opt-in acceptance probe against the official signed feed. No private keys,
// installation changes, or credentials are needed.
func TestLiveSystemProxyUpdateDownload(t *testing.T) {
	key := os.Getenv("QISITV_TEST_UPDATER_PUBLIC_KEY")
	feed := os.Getenv("QISITV_TEST_UPDATER_FEED_URL")
	if key == "" || feed == "" {
		t.Skip("set QISITV_TEST_UPDATER_PUBLIC_KEY and QISITV_TEST_UPDATER_FEED_URL for a live signed download")
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
