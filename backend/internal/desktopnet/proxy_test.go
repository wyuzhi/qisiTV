package desktopnet

import (
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/net/http/httpproxy"
)

func TestHTTPSChildProxyPreservesRedirectBypassAndExplicitDirect(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:7890")
	t.Setenv("https_proxy", "http://127.0.0.1:9999")
	t.Setenv("NO_PROXY", "*.internal,cdn.example.com,10.0.0.0/8")
	t.Setenv("no_proxy", "")
	env := strings.Join(HTTPSProxyEnvironment(), "\n")
	if !strings.Contains(env, "https_proxy=http://127.0.0.1:7890") || !strings.Contains(env, "no_proxy=.internal,cdn.example.com,10.0.0.0/8") {
		t.Fatal("child downloader lost desktop proxy precedence or redirect exclusions")
	}
	t.Setenv("HTTPS_PROXY", "")
	t.Setenv("https_proxy", "")
	t.Setenv("ALL_PROXY", "http://127.0.0.1:8888")
	t.Setenv("NO_PROXY", "*")
	env = strings.Join(HTTPSProxyEnvironment(), "\n")
	if !strings.Contains(env, "no_proxy=*\n") || !strings.HasSuffix(env, "ALL_PROXY=\nall_proxy=") {
		t.Fatal("explicit direct configuration fell back to a different proxy")
	}
	t.Setenv("NO_PROXY", "*")
	if !strings.Contains(strings.Join(HTTPSProxyEnvironment(), "\n"), "no_proxy=*\n") {
		t.Fatal("universal proxy bypass was lost")
	}
}

func TestEmptyDesktopProxyEnvironmentUsesSystemSettings(t *testing.T) {
	for _, name := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"} {
		t.Setenv(name, "")
	}
	if ExplicitProxyConfigured() {
		t.Fatal("empty launcher variables disabled OS proxy settings")
	}
	u, _ := url.Parse("https://example.com/image.png")
	system := parseWindowsProxy("127.0.0.1:7890", "")
	got, err := proxyWithSystem(u, *httpproxy.FromEnvironment(), system)
	if err != nil || got == nil || got.Host != "127.0.0.1:7890" {
		t.Fatalf("system fallback: %v %v", got, err)
	}
	t.Setenv("NO_PROXY", "*")
	req, _ := http.NewRequest("GET", u.String(), nil)
	got, err = Proxy(req)
	if err != nil || got != nil {
		t.Fatalf("explicit bypass lost: %v %v", got, err)
	}
}

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
	if runtime.GOOS != "windows" {
		t.Setenv("HTTP_PROXY", "http://127.0.0.1:5554")
		t.Setenv("http_proxy", "http://127.0.0.1:9998")
		t.Setenv("HTTPS_PROXY", "http://127.0.0.1:5555")
		t.Setenv("https_proxy", "http://127.0.0.1:9999")
		t.Setenv("NO_PROXY", "github.com")
		t.Setenv("no_proxy", "example.com")
		cfg := environmentProxyConfig()
		if cfg.HTTPProxy != "http://127.0.0.1:5554" || cfg.HTTPSProxy != "http://127.0.0.1:5555" || cfg.NoProxy != "github.com" {
			t.Fatalf("uppercase precedence lost: %+v", cfg)
		}
		req, _ := http.NewRequest(http.MethodGet, "https://example.com", nil)
		if got, err := Proxy(req); err != nil || got == nil || got.String() != "http://127.0.0.1:5555" {
			t.Fatalf("Proxy uppercase precedence lost: %v %v", got, err)
		}
		if !ConfiguredProxyAddress("127.0.0.1:5554") || ConfiguredProxyAddress("127.0.0.1:9998") {
			t.Fatal("ConfiguredProxyAddress uppercase precedence lost")
		}
		t.Setenv("HTTP_PROXY", "")
		t.Setenv("HTTPS_PROXY", "")
		t.Setenv("NO_PROXY", "")
		cfg = environmentProxyConfig()
		if cfg.HTTPProxy != "http://127.0.0.1:9998" || cfg.HTTPSProxy != "http://127.0.0.1:9999" || cfg.NoProxy != "example.com" {
			t.Fatalf("lowercase fallback lost: %+v", cfg)
		}
		t.Setenv("http_proxy", "")
		t.Setenv("https_proxy", "")
		t.Setenv("no_proxy", "")
	}
	t.Setenv("HTTP_PROXY", "")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:5555")
	t.Setenv("NO_PROXY", "github.com")
	for _, tc := range []struct{ target, want string }{{"https://example.com", "http://127.0.0.1:5555"}, {"https://github.com", ""}} {
		req, _ := http.NewRequest(http.MethodGet, tc.target, nil)
		got, err := Proxy(req)
		actual := ""
		if got != nil {
			actual = got.String()
		}
		if err != nil || actual != tc.want {
			t.Fatalf("explicit proxy %q, %v", actual, err)
		}
	}
}
