package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"qisitv/backend/internal/bootstrap"
)

func TestEngineFolderConfirmationPersistsAndRejectsReplacement(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	data := t.TempDir()
	rt, err := bootstrap.Open(ctx, bootstrap.Config{Profile: bootstrap.ProfileDesktop, DataDir: data, ListenAddr: "127.0.0.1:0", AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close(context.Background())
	shell, err := newEngineShell(ctx, rt, data, "")
	if err != nil {
		t.Fatal(err)
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	shell.choose = func(context.Context) (string, error) { return root, nil }
	request := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		shell.ServeHTTP(recorder, httptest.NewRequest(method, "/engine/shell"+path, strings.NewReader(body)))
		return recorder
	}
	if shell.configured() {
		t.Fatal("a folder was granted without consent")
	}
	if got := request("GET", "/project-folders/list", ""); got.Code != 409 {
		t.Fatal(got.Code, got.Body.String())
	}
	if got := request("POST", "/project-folders/choose", ""); got.Code != 200 || !strings.Contains(got.Body.String(), root) {
		t.Fatal(got.Code, got.Body.String())
	}
	if shell.configured() {
		t.Fatal("choosing must not itself grant authority")
	}
	body, _ := json.Marshal(map[string]any{"path": root})
	if got := request("POST", "/project-folders/configure", string(body)); got.Code != 400 {
		t.Fatal(got.Code, got.Body.String())
	}
	body, _ = json.Marshal(map[string]any{"path": root, "confirmed": true})
	if got := request("POST", "/project-folders/configure", string(body)); got.Code != 200 {
		t.Fatal(got.Code, got.Body.String())
	}
	if !shell.configured() || shell.directory() != root {
		t.Fatal("confirmed directory was not activated")
	}
	if got := request("POST", "/project-folders/configure", string(body)); got.Code != 200 {
		t.Fatal("same directory is not idempotent")
	}
	settings, err := os.ReadFile(filepath.Join(data, "qisitv-engine.json"))
	if err != nil || !strings.Contains(string(settings), root) {
		t.Fatal("directory was not persisted", err)
	}
	other, _ := json.Marshal(map[string]any{"path": t.TempDir(), "confirmed": true})
	if got := request("POST", "/project-folders/configure", string(other)); got.Code != 409 {
		t.Fatal("existing authority replaced", got.Body.String())
	}
	if got := request("GET", "/project-folders/list", ""); got.Code != http.StatusOK {
		t.Fatal(got.Code, got.Body.String())
	}
	if got := request("PUT", "/reference-storage", `{"enabled":false,"accessKeyId":"fixture-id","secretAccessKey":"fixture-never-return","hasSecret":false}`); got.Code != 200 || strings.Contains(got.Body.String(), "fixture-never-return") {
		t.Fatal("reference credentials were not masked", got.Code)
	}
	if got := request("GET", "/reference-storage", ""); got.Code != 200 || strings.Contains(got.Body.String(), "fixture-never-return") || !strings.Contains(got.Body.String(), `"hasSecret":true`) {
		t.Fatal("reference config read leaked a secret or lost configuration", got.Code)
	}
	if got := request("GET", "/storage", ""); got.Code != 200 {
		t.Fatal("storage unavailable", got.Code, got.Body.String())
	} else {
		var response struct {
			Data struct {
				DataDir          string `json:"dataDir"`
				EngineExecutable string `json:"engineExecutable"`
				RuntimeOS        string `json:"runtimeOS"`
			} `json:"data"`
		}
		if err := json.Unmarshal(got.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		executable, err := os.Executable()
		if err != nil || response.Data.DataDir != data || response.Data.EngineExecutable != executable || response.Data.RuntimeOS != runtime.GOOS {
			t.Fatal("storage maintenance location does not match this engine", response.Data, err)
		}
	}
	if got := request("POST", "/project-folders/import", `{"directory":"../escape","receiptsComplete":true}`); got.Code != 400 {
		t.Fatal("path traversal accepted", got.Code, got.Body.String())
	}
	stopped := make(chan struct{})
	shell.stop = func() { close(stopped) }
	if got := request("POST", "/maintenance/stop", `{}`); got.Code != 400 {
		t.Fatal("maintenance did not require confirmation")
	}
	if got := request("POST", "/maintenance/stop", `{"confirmed":true}`); got.Code != 200 {
		t.Fatal("maintenance rejected idle workspace", got.Code, got.Body.String())
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("maintenance never stopped the lifecycle")
	}
	if shell.checkWritable(ctx) == nil {
		t.Fatal("maintenance did not reject new mutations")
	}
	cancel()
}

func TestEngineDirectoryChecksRejectRelativeFileAndRoot(t *testing.T) {
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"relative", file, filepath.VolumeName(file) + string(filepath.Separator)} {
		if _, err := checkedProjectDirectory(path); err == nil {
			t.Fatal("unsafe directory accepted", path)
		}
	}
}
