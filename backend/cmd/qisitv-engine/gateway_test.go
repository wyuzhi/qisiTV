package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"qisitv/backend/internal/bootstrap"
	"qisitv/backend/internal/browserbridge"
)

func TestEngineGatewayCreatesRealProjectAndBlocksExternalConflict(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	data, root := t.TempDir(), t.TempDir()
	var shell *engineShell
	rt, err := bootstrap.Open(ctx, bootstrap.Config{Profile: bootstrap.ProfileDesktop, DataDir: data, ListenAddr: "127.0.0.1:0", AutoMigrate: true, RouterMiddleware: []gin.HandlerFunc{engineFolderGuard(func() *engineShell { return shell })}})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close(context.Background())
	shell, err = newEngineShell(ctx, rt, data, "")
	if err != nil {
		t.Fatal(err)
	}
	inner := httptest.NewServer(rt.Handler())
	defer inner.Close()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	bridge := browserbridge.NewServer(strings.Repeat("a", 64), listener.Addr().(*net.TCPAddr).Port)
	gateway, err := browserbridge.NewEngineGateway(browserbridge.EngineConfig{BaseURL: inner.URL + "/api", LaunchToken: rt.LaunchToken(), UIBootstrapToken: rt.UIBootstrapToken(), Shell: shell, WorkspaceConfigured: shell.configured, ProjectDirectory: shell.directory, CheckWritable: shell.checkWritable})
	if err != nil {
		t.Fatal(err)
	}
	bridge.SetEngine(gateway)
	outer := httptest.NewUnstartedServer(bridge)
	outer.Listener.Close()
	outer.Listener = listener
	outer.Start()
	defer outer.Close()
	var token string
	request := func(method, path, body string) (int, []byte) {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, method, outer.URL+path, strings.NewReader(body))
		req.Header.Set("Origin", "https://cheeser.link")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(browserbridge.EngineSessionHeader, token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, raw
	}
	code, _ := bridge.NewPairCode()
	status, raw := request("POST", "/pair", `{"code":"`+code+`"}`)
	var paired struct {
		Token string `json:"token"`
	}
	if status != 200 || json.Unmarshal(raw, &paired) != nil || paired.Token == "" {
		t.Fatal("pair failed", status)
	}
	token = paired.Token
	canvas := `{"project":{"id":"native-test","title":"Native folder","revision":0,"nodes":[],"connections":[]}}`
	if status, _ := request("PUT", "/engine/api/canvas-projects/native-test", canvas); status != 409 {
		t.Fatal("unconfigured write admitted", status)
	}
	configured, _ := json.Marshal(map[string]any{"path": root, "confirmed": true})
	if status, raw := request("POST", "/engine/shell/project-folders/configure", string(configured)); status != 200 {
		t.Fatal(status, string(raw))
	}
	if status, raw := request("PUT", "/engine/api/canvas-projects/native-test", canvas); status != 200 {
		t.Fatal(status, string(raw))
	}
	if status, raw := request("POST", "/engine/shell/project-folders/flush", `{"canvasId":"native-test"}`); status != 200 {
		t.Fatal(status, string(raw))
	}
	owner, err := rt.ProjectFolderOwnerID()
	if err != nil {
		t.Fatal(err)
	}
	folder, err := rt.ProjectFolders().Status(ctx, owner, "native-test")
	if err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(root, folder.Directory, "project.qisitv.json")
	if raw, err := os.ReadFile(manifest); err != nil || !strings.Contains(string(raw), `"native-test"`) {
		t.Fatal("no actual project file", err)
	}
	if err := os.WriteFile(manifest, []byte(`{"externallyChanged":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	if status, raw := request("POST", "/engine/api/tasks", `{"type":"canvas_image"}`); status != 409 || !strings.Contains(string(raw), "project_folder_conflict") {
		t.Fatal("conflict reached task admission", status, string(raw))
	}
	// The private native MCP path has the same guard, even without the gateway.
	req := httptest.NewRequest("POST", "http://127.0.0.1:19000/api/ops/generation.submit", strings.NewReader(`{}`))
	req.Header.Set("X-Desktop-Token", rt.LaunchToken())
	recorder := httptest.NewRecorder()
	rt.Handler().ServeHTTP(recorder, req)
	if recorder.Code != 409 || !strings.Contains(recorder.Body.String(), "project_folder_conflict") {
		t.Fatal("native mutation bypassed folder guard", recorder.Code, recorder.Body.String())
	}
	cancel()
}
