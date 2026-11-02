package generation

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"qisitv/backend/internal/outbound"
)

func TestProviderImageDownloadRedirectNeverRestoresCredentials(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var origin *httptest.Server
	var sameOrigin, external, returned int
	checkClean := func(r *http.Request) {
		t.Helper()
		for _, name := range []string{"Authorization", "Cookie", "X-Provider-Secret", "Referer"} {
			if r.Header.Get(name) != "" {
				t.Errorf("download leaked %s at %s", name, r.URL.Path)
			}
		}
		if r.UserAgent() != outbound.DefaultOutboundUserAgent {
			t.Errorf("download User-Agent = %q", r.UserAgent())
		}
	}
	cdn := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		external++
		checkClean(r)
		http.Redirect(w, r, origin.URL+"/returned", http.StatusFound)
	}))
	defer cdn.Close()
	origin = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/returned" {
			returned++
			checkClean(r)
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("original image bytes"))
			return
		}
		sameOrigin++
		if r.Header.Get("Authorization") != "Bearer provider-key" || r.Header.Get("X-Provider-Secret") != "private-header" {
			t.Error("same-origin download lost provider headers")
		}
		if r.URL.Path == "/proxy" {
			http.Redirect(w, r, "/same?token=synthetic", http.StatusFound)
			return
		}
		http.Redirect(w, r, cdn.URL+"/object?signature=synthetic", http.StatusFound)
	}))
	defer origin.Close()
	config := Config{BaseURL: origin.URL, APIKey: "provider-key", Headers: []outbound.OutboundHeader{
		{Name: "X-Provider-Secret", Value: "private-header"},
	}}
	data, _, err := GetProviderExternalBinary(context.Background(), config, origin.URL+"/proxy")
	if err != nil || string(data) != "original image bytes" || sameOrigin != 2 || external != 1 || returned != 1 {
		t.Fatalf("download = %q, error=%v, hops=%d/%d/%d", data, err, sameOrigin, external, returned)
	}
	// An external first hop must also start without the provider's headers.
	if _, _, err := GetProviderExternalBinary(context.Background(), config, cdn.URL+"/object"); err != nil {
		t.Fatal(err)
	}
}

func TestProviderImageDownloadRedirectRetainsOutboundGuard(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/private", http.StatusFound)
	}))
	defer origin.Close()
	if _, _, err := GetProviderExternalBinary(context.Background(), Config{BaseURL: origin.URL}, origin.URL+"/image"); err == nil {
		t.Fatal("download followed a blocked redirect")
	}
}
