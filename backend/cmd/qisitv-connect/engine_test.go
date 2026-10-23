package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"qisitv/backend/internal/browserbridge"
)

func TestManagedEngineDiscoveryUsesOnlyCompleteSibling(t *testing.T) {
	dir := t.TempDir()
	connector := filepath.Join(dir, "qisitv-connect")
	if got := managedExecutable(connector); got != connector {
		t.Fatal(got)
	}
	name := "qisitv-engine"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	engine := filepath.Join(dir, name)
	if err := os.WriteFile(engine, nil, 0755); err != nil {
		t.Fatal(err)
	}
	if got := managedExecutable(connector); got != connector {
		t.Fatal("empty engine selected")
	}
	if err := os.WriteFile(engine, []byte("fixture"), 0755); err != nil {
		t.Fatal(err)
	}
	if got := managedExecutable(connector); got != engine {
		t.Fatal(got)
	}
}

func TestOpenURLUsesOneUseFragmentPairingWithoutBrowserLaunch(t *testing.T) {
	t.Setenv("QISITV_CONNECT_CONFIG_DIR", t.TempDir())
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	config, err := browserbridge.SaveConfig("http://" + listener.Addr().String())
	if err != nil {
		listener.Close()
		t.Fatal(err)
	}
	bridge := browserbridge.NewServer(config.AgentToken, port)
	gateway, err := browserbridge.NewEngineGateway(browserbridge.EngineConfig{BaseURL: config.Address + "/api", LaunchToken: strings.Repeat("l", 64), UIBootstrapToken: strings.Repeat("u", 64)})
	if err != nil {
		t.Fatal(err)
	}
	bridge.SetEngine(gateway)
	server := httptest.NewUnstartedServer(bridge)
	server.Listener.Close()
	server.Listener = listener
	server.Start()
	defer server.Close()
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	previous := os.Stdout
	os.Stdout = write
	err = openWebsite(context.Background(), []string{"--url", "--port", strconv.Itoa(port)})
	os.Stdout = previous
	write.Close()
	output, _ := io.ReadAll(read)
	read.Close()
	if err != nil {
		t.Fatal(err)
	}
	link, err := url.Parse(strings.TrimSpace(string(output)))
	if err != nil || link.Scheme != "https" || link.Host != "cheeser.link" || link.Path != "/qisitv/" || link.RawQuery != "" {
		t.Fatal("unexpected pairing URL")
	}
	query, err := url.ParseQuery(strings.TrimPrefix(link.Fragment, "/?"))
	if err != nil || query.Get("pair") == "" {
		t.Fatal("missing fragment pairing")
	}
	body, _ := json.Marshal(map[string]string{"code": query.Get("pair")})
	for _, expected := range []int{200, 403} {
		req, _ := http.NewRequest("POST", server.URL+"/pair", strings.NewReader(string(body)))
		req.Header.Set("Origin", "https://cheeser.link")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != expected {
			t.Fatal("pairing replay status", response.StatusCode)
		}
	}
	if err := openWebsite(context.Background(), []string{"qisitv://arbitrary"}); err == nil {
		t.Fatal("arbitrary scheme input accepted")
	}
	for _, args := range [][]string{{"--skill-id", "../secret", "--release-id", "v1"}, {"--skill-id", "valid"}, {"--skill-id", "https://evil.invalid", "--release-id", "v1"}} {
		if err := openWebsite(context.Background(), args); err == nil {
			t.Fatal("invalid skill identifiers accepted")
		}
	}
}
