package browserbridge

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const engineLaunch = "engine-launch-token-kept-only-in-process-123456789"
const engineBootstrap = "engine-ui-bootstrap-kept-only-in-process-123456789"

func engineTestServer(t *testing.T, handler http.Handler) (*Server, *httptest.Server, string) {
	t.Helper()
	backend := httptest.NewServer(handler)
	t.Cleanup(backend.Close)
	gateway, err := NewEngineGateway(EngineConfig{BaseURL: backend.URL + "/api", LaunchToken: engineLaunch, UIBootstrapToken: engineBootstrap, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	bridge, server := startTestServer(t)
	bridge.SetEngine(gateway)
	return bridge, server, pairTest(t, bridge, server)
}

func engineRequest(t *testing.T, server *httptest.Server, method, path, token, origin string, body io.Reader) *http.Request {
	t.Helper()
	r, err := http.NewRequest(method, server.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set(EngineSessionHeader, token)
	r.Header.Set("Origin", origin)
	return r
}

func TestEnginePairingScopeRevocationAndPrivateRuntime(t *testing.T) {
	hits := 0
	bridge, server, token := engineTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++; w.WriteHeader(204) }))
	for _, item := range []struct {
		token, origin, path string
		status              int
	}{
		{"", testOrigin, "/engine/api/canvases", 401},
		{testAgentToken, testOrigin, "/engine/api/canvases", 401},
		{token, "https://www.cheeser.link", "/engine/api/canvases", 401},
		{token, "", "/engine/api/canvases", 403},
		{token, testOrigin, "/engine/api/assistant/runtime/turns/x", 403},
		{token, testOrigin, "/engine/api/assistant/host/config", 403},
		{token, testOrigin, "/engine/api/../secret", 400},
	} {
		res, err := http.DefaultClient.Do(engineRequest(t, server, "GET", item.path, item.token, item.origin, nil))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != item.status {
			t.Fatalf("%s status %d want %d", item.path, res.StatusCode, item.status)
		}
	}
	if hits != 0 {
		t.Fatalf("unauthorized requests reached engine: %d", hits)
	}
	status, _ := requestTest(t, server, "POST", "/unpair", testOrigin, "", map[string]any{"token": token})
	if status != 200 {
		t.Fatal(status)
	}
	res, err := http.DefaultClient.Do(engineRequest(t, server, "GET", "/engine/status", token, testOrigin, nil))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatal("revoked session still worked")
	}
	_ = bridge
}

func TestEngineRefusesLegacyCanvasToolsBeforeBrowserDispatch(t *testing.T) {
	bridge, _, _ := engineTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {t.Fatal("legacy tool reached the workspace API") }))
	for _, operation := range []string{"canvas_current","canvas_apply","task_submit","asset_import"} {
		_,err:=bridge.Call(context.Background(),operation,map[string]any{})
		rpc,ok:=err.(*RPCError)
		if !ok || rpc.Code!="NATIVE_AGENT_SETUP_REQUIRED" || !strings.Contains(rpc.Message,"/#/agents") {t.Fatalf("legacy %s did not fail closed: %v",operation,err)}
	}
	if _,err:=bridge.Call(context.Background(),"canvas_list_sessions",nil);err!=nil {t.Fatal("pairing session discovery unavailable",err)}
}

func TestEngineProxyKeepsBodyRangeAndStripsAuthority(t *testing.T) {
	_, server, token := engineTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.String() != "/api/resources/test/file?variant=playback" || r.Header.Get("Range") != "bytes=1-3" {
			t.Errorf("lost request target/range: %s %v", r.URL, r.Header)
		}
		if r.Header.Get("X-Desktop-Token") != engineLaunch || r.Header.Get("X-Beeftv-UI-Bootstrap") != engineBootstrap {
			t.Error("runtime capabilities missing")
		}
		for _, name := range []string{"Origin", "Authorization", "Cookie", EngineSessionHeader, "X-Beeftv-Owner", "X-Beeftv-Agent-Token", "X-Beeftv-Client", "X-Forwarded-Host"} {
			if r.Header.Get(name) != "" {
				t.Errorf("authority header forwarded: %s", name)
			}
		}
		if r.Header.Get("X-Beeftv-Ui-Session") != "scoped-ui-session" {
			t.Error("UI session lost")
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != "multipart bytes remain exact" {
			t.Error("request body changed")
		}
		w.Header().Set("Content-Range", "bytes 1-3/9")
		w.Header().Set("ETag", "version-1")
		w.Header().Set("X-Beeftv-Owner", "must-not-leak")
		w.Header().Set("Access-Control-Allow-Origin", "http://inner-runtime")
		w.WriteHeader(206)
		_, _ = io.WriteString(w, "abc")
	}))
	req := engineRequest(t, server, "POST", "/engine/api/resources/test/file?variant=playback", token, testOrigin, strings.NewReader("multipart bytes remain exact"))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=unchanged")
	req.Header.Set("Range", "bytes=1-3")
	req.Header.Set("X-Beeftv-Ui-Session", "scoped-ui-session")
	for _, name := range []string{"Authorization", "Cookie", "X-Beeftv-Owner", "X-Beeftv-Agent-Token", "X-Beeftv-Client", "X-Forwarded-Host"} {
		req.Header.Set(name, "forged")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode != 206 || string(data) != "abc" || res.Header.Get("Content-Range") != "bytes 1-3/9" || res.Header.Get("ETag") != "version-1" {
		t.Fatalf("lost binary response: %d %q %v", res.StatusCode, data, res.Header)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != testOrigin || res.Header.Get("X-Beeftv-Owner") != "" {
		t.Fatal("response authority/CORS leaked")
	}
}

func TestEngineStreamFlushesAndUnpairCancels(t *testing.T) {
	stopped := make(chan struct{})
	_, server, token := engineTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = io.WriteString(w, "{\"type\":\"text_delta\",\"delta\":\"first\"}\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(stopped)
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req := engineRequest(t, server, "POST", "/engine/api/assistant/chat", token, testOrigin, strings.NewReader("{}"))
	res, err := http.DefaultClient.Do(req.WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	line, err := bufio.NewReader(res.Body).ReadString('\n')
	if err != nil || !strings.Contains(line, "first") {
		t.Fatalf("stream was buffered: %q %v", line, err)
	}
	status, _ := requestTest(t, server, "POST", "/unpair", testOrigin, "", map[string]any{"token": token})
	if status != 200 {
		t.Fatal(status)
	}
	select {
	case <-stopped:
	case <-ctx.Done():
		t.Fatal("revocation did not cancel stream")
	}
}

func TestEngineStatusContainsNoRuntimeSecretsAndFolderGate(t *testing.T) {
	bridge, server, token := engineTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }))
	bridge.engine.config.WorkspaceConfigured = func() bool { return false }
	res, err := http.DefaultClient.Do(engineRequest(t, server, "GET", "/engine/status", token, testOrigin, nil))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	for _, secret := range []string{engineLaunch, engineBootstrap, testAgentToken, token} {
		if strings.Contains(string(raw), secret) {
			t.Fatal("status leaked a capability")
		}
	}
	var status struct {
		Data struct {
			WorkspaceConfigured bool   `json:"workspaceConfigured"`
			APIPath             string `json:"apiPath"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &status) != nil || status.Data.WorkspaceConfigured || status.Data.APIPath != "/engine/api" {
		t.Fatalf("wrong status %s", raw)
	}
	res, err = http.DefaultClient.Do(engineRequest(t, server, "POST", "/engine/api/tasks", token, testOrigin, strings.NewReader("{}")))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 409 {
		t.Fatal("unconfigured folder allowed task submission")
	}
}
