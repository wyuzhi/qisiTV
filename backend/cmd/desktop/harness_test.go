package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestHarnessBridgeRequiresPrivateCapability(t *testing.T) {
	apiCalled := false
	config := harnessRuntimeConfig{BridgeToken: "private-test-capability"}
	handler := harnessHTTPHandler(config, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		apiCalled = true
	}), fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("workspace")}})
	for _, requestPath := range []string{"/", "/api/health", "/beeftv/app/api/health"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, requestPath, nil))
		if response.Code != http.StatusForbidden || apiCalled {
			t.Fatalf("unauthenticated bridge request %q reached the workspace", requestPath)
		}
	}
}

func TestHarnessBridgeForwardsTrustedAPIWithoutCallerIdentity(t *testing.T) {
	config := harnessRuntimeConfig{DesktopRuntimeConfig: DesktopRuntimeConfig{
		BaseURL: "http://127.0.0.1:12345/api", LaunchToken: "desktop-test-token", UIBootstrapToken: "bootstrap-test-token",
	}, BridgeToken: "bridge-test-token"}
	handler := harnessHTTPHandler(config, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspace/bootstrap" || r.URL.RawQuery != "view=canvas" || r.Host != "127.0.0.1:12345" {
			t.Fatalf("wrong API target %s %s", r.Host, r.URL)
		}
		if r.Header.Get("X-Desktop-Token") != config.LaunchToken || r.Header.Get("X-Beeftv-UI-Bootstrap") != config.UIBootstrapToken || r.Header.Get("Origin") != "wails://wails" {
			t.Fatal("bridge did not supply desktop trust")
		}
		for _, header := range []string{harnessTokenHeader, "X-Beeftv-Client", "X-Beeftv-Owner", "X-Beeftv-Agent-Turn", "X-Beeftv-Agent-Token"} {
			if r.Header.Get(header) != "" {
				t.Fatalf("caller identity %s reached the backend", header)
			}
		}
		w.WriteHeader(http.StatusNoContent)
	}), fstest.MapFS{})
	request := httptest.NewRequest(http.MethodGet, "/beeftv/app/api/workspace/bootstrap?view=canvas", nil)
	for _, header := range []string{harnessTokenHeader, "X-Beeftv-Client", "X-Beeftv-Owner", "X-Beeftv-Agent-Turn", "X-Beeftv-Agent-Token"} {
		request.Header.Set(header, config.BridgeToken)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("API status = %d", response.Code)
	}
}

func TestHarnessBridgeServesSPAAndAssetsWithoutCredentials(t *testing.T) {
	config := harnessRuntimeConfig{BridgeToken: "bridge-test-token"}
	frontend := fstest.MapFS{
		"index.html":    &fstest.MapFile{Data: []byte("<html>workspace</html>")},
		"assets/app.js": &fstest.MapFile{Data: []byte("workspaceJavaScript()")},
	}
	handler := harnessHTTPHandler(config, http.NotFoundHandler(), frontend)
	for _, fixture := range []struct {
		path   string
		status int
		body   string
	}{
		{"/", http.StatusOK, "<html>workspace</html>"},
		{"/beeftv/app/canvas/project", http.StatusOK, "<html>workspace</html>"},
		{"/beeftv/app/assets/app.js", http.StatusOK, "workspaceJavaScript()"},
		{"/assets/missing.js", http.StatusNotFound, "404 page not found"},
		{"/__desktop/runtime-config", http.StatusNotFound, "404 page not found"},
	} {
		request := httptest.NewRequest(http.MethodGet, fixture.path, nil)
		request.Header.Set(harnessTokenHeader, config.BridgeToken)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != fixture.status || !strings.Contains(response.Body.String(), fixture.body) {
			t.Fatalf("path %q status %d body %q", fixture.path, response.Code, response.Body.String())
		}
	}
}

func TestDesktopAcceptsSeparatedDataDirectoryFlag(t *testing.T) {
	if err := validateDesktopArgs([]string{"--data-dir", "/Users/example/BeefTV"}); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"--data-dir"}, {"--data-dir", "relative"}, {"--data-dir", "/"}} {
		if err := validateDesktopArgs(args); err == nil {
			t.Fatalf("accepted invalid data directory %v", args)
		}
	}
}
