package beefapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// The upscale content endpoint redirects to the file the API already saved in
// object storage. Only that GET follows the redirect, and only to public HTTPS.

func TestUpscaleContentRejectsPrivateAndInvalidRedirects(t *testing.T) {
	// The API itself is a loopback test server, so the client runs in test mode
	// and loopback is allowed for the first hop. Loopback redirect targets are
	// therefore covered by TestStorageRedirectHopPolicyInProduction instead.
	for name, tc := range map[string]struct{ target, want string }{
		"private range":   {"https://10.0.0.8/saved", "内网"},
		"link-local":      {"https://169.254.169.254/latest/meta-data", "链路本地"},
		"credentials":     {"https://user:pass@storage.example.com/saved", "认证信息"},
		"non-http scheme": {"file:///etc/passwd", "地址无效"},
	} {
		t.Run(name, func(t *testing.T) {
			var hops atomic.Int32
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hops.Add(1)
				http.Redirect(w, r, tc.target, http.StatusTemporaryRedirect)
			}))
			defer api.Close()
			client := &MediaClient{BaseURL: api.URL + "/v1", APIKey: "secret", AllowHTTPTest: true}
			t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
			t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
			_, _, err := client.LegacyUpscaleContent(context.Background(), "task-1", 1<<20)
			if hops.Load() != 1 {
				t.Fatalf("API content endpoint hits = %d (err %v)", hops.Load(), err)
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("redirect to %s: err = %v, want policy error containing %q", tc.target, err, tc.want)
			}
		})
	}
}

func TestUpscaleContentStopsAfterRedirectLimit(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var hops atomic.Int32
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hops.Add(1)
		http.Redirect(w, r, server.URL+"/loop", http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	client := &MediaClient{BaseURL: server.URL + "/v1", APIKey: "secret", AllowHTTPTest: true}
	_, _, err := client.LegacyUpscaleContent(context.Background(), "task-1", 1<<20)
	if err == nil || !strings.Contains(err.Error(), "重定向次数过多") {
		t.Fatalf("err = %v", err)
	}
	if got := hops.Load(); got != storageRedirectLimit {
		t.Fatalf("hops = %d", got)
	}
}

func TestUpscaleContentEnforcesSizeLimitAfterRedirect(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(make([]byte, 2048))
	}))
	defer storage.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, storage.URL+"/saved", http.StatusTemporaryRedirect)
	}))
	defer api.Close()
	client := &MediaClient{BaseURL: api.URL + "/v1", APIKey: "secret", AllowHTTPTest: true}
	if _, _, err := client.LegacyUpscaleContent(context.Background(), "task-1", 1024); err == nil {
		t.Fatal("accepted a stored file larger than the limit")
	}
}

func TestUpscaleJSONAndPOSTStillRefuseRedirects(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var storageHits atomic.Int32
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		storageHits.Add(1)
		_, _ = w.Write([]byte(`{"task_id":"task-1","status":"completed","model":"m","media_type":"image"}`))
	}))
	defer storage.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, storage.URL+"/elsewhere", http.StatusTemporaryRedirect)
	}))
	defer api.Close()
	client := &MediaClient{BaseURL: api.URL + "/v1", APIKey: "secret", AllowHTTPTest: true}
	if _, err := client.QueryLegacyUpscale(context.Background(), "task-1", "m", "image"); err == nil {
		t.Fatal("status query followed a redirect")
	}
	if _, err := client.CreateLegacyUpscale(context.Background(), "key-1", LegacyUpscaleInput{}); err == nil {
		t.Fatal("create followed a redirect")
	}
	if err := client.CancelLegacyUpscale(context.Background(), "task-1"); err == nil {
		t.Fatal("cancel followed a redirect")
	}
	if storageHits.Load() != 0 {
		t.Fatalf("JSON or POST calls reached the redirect target %d times", storageHits.Load())
	}
}

// Production clients (no test mode) refuse every non-public or non-HTTPS hop.
func TestStorageRedirectHopPolicyInProduction(t *testing.T) {
	client := &MediaClient{}
	for _, target := range []string{
		"https://127.0.0.1/saved",
		"https://localhost/saved",
		"https://10.0.0.8/saved",
		"https://169.254.169.254/latest/meta-data",
		"http://storage.example.com/saved",
		"https://user:pass@storage.example.com/saved",
	} {
		req, err := http.NewRequestWithContext(client.networkContext(context.Background()), http.MethodGet, target, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := client.storageClient("too many").CheckRedirect(req, []*http.Request{req}); err == nil {
			t.Fatalf("hop to %s allowed", target)
		}
	}
	req, _ := http.NewRequestWithContext(client.networkContext(context.Background()), http.MethodGet, "https://storage.example.com/saved", nil)
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("Cookie", "session=1")
	req.Header.Set("X-Private-Gateway", "private")
	_ = client.storageClient("too many").CheckRedirect(req, []*http.Request{req})
	if len(req.Header) != 0 {
		t.Fatalf("hop kept headers: %v", req.Header)
	}
}
