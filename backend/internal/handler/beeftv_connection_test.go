package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"qisitv/backend/internal/app"
	"qisitv/backend/internal/beeftv"
	"qisitv/backend/internal/workspace"

	"github.com/gin-gonic/gin"
)

func TestBeefTVConnectionRoutesRequireWorkspaceAndHideSecrets(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	store, err := workspace.NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := beeftv.New(beeftv.Options{
		DataDir: dir, Origin: "http://127.0.0.1:9", Provider: store, ClientVersion: "test", Hostname: "test",
		HTTPClient: http.DefaultClient, OpenURL: func(string) error { return nil }, Sleep: func(time.Duration) {},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(connection.Close)
	service := app.NewLocal(nil, dir)
	service.SetBeefTV(connection)
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: "local", DataDir: dir}))
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{
		RequestCoordinator: &stubRequestCoordinator{allowed: true},
		ProviderConfig:     store,
		BeefTV:             connection,
	}))
	RegisterWorkspaceRoutes(router.Group("/api"), service)
	RegisterBeefTVConnectionRoutes(router.Group("/api"), service)

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/beeftv/connection", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var envelope struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data["state"] != beeftv.StateDisconnected {
		t.Fatalf("state = %#v", envelope.Data["state"])
	}
	if _, exists := envelope.Data["apiKey"]; exists {
		t.Fatalf("connection summary leaked apiKey: %#v", envelope.Data)
	}
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/beeftv/connection/models", strings.NewReader(`{"apiKey":"client-forged","models":[{"id":"seedance-2.0-portrait"}]}`)))
	if recorder.Code == http.StatusOK || strings.Contains(recorder.Body.String(), "client-forged") {
		t.Fatal("disconnected catalog endpoint accepted or exposed client credentials")
	}
	for _, tc := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/beeftv/connection?refresh=1", ""},
		{http.MethodGet, "/api/beeftv/connection/topup/info", ""},
		{http.MethodPost, "/api/beeftv/connection/topup/checkout", `{"paymentMethod":"wxpay","amount":100}`},
		{http.MethodPost, "/api/beeftv/connection/topup/reconcile", `{"tradeNo":"T1"}`},
	} {
		recorder = httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body)))
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("expected disconnected %s %s to return 401, got %d body=%s", tc.method, tc.path, recorder.Code, recorder.Body.String())
		}
		var errEnv struct {
			Code   int    `json:"code"`
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &errEnv); err != nil {
			t.Fatalf("unmarshal %s %s: %v", tc.method, tc.path, err)
		}
		if errEnv.Code != http.StatusUnauthorized || errEnv.Reason != "unauthorized" {
			t.Fatalf("disconnected %s %s envelope = %+v", tc.method, tc.path, errEnv)
		}
	}
}

type stubBeefTVConnections struct {
	service *beeftv.Service
}

func (s stubBeefTVConnections) IsLocalMode() bool       { return true }
func (s stubBeefTVConnections) BeefTV() *beeftv.Service { return s.service }

func TestBeefTVTopUpAndRefreshErrorStatusMapping(t *testing.T) {
	gin.SetMode(gin.TestMode)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := "http://" + r.Host
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/oauth/device/code":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"device_code":               "dev-topup",
				"user_code":                 "ABCD-EFGH",
				"verification_uri":          origin + "/desktop-auth",
				"verification_uri_complete": origin + "/desktop-auth?user_code=ABCD-EFGH",
				"expires_in":                60,
				"interval":                  1,
			})
		case "/api/oauth/device/token":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"api_key":  "ent-test-key",
				"base_url": origin + "/v1",
				"key_name": "BeefTV",
				"token_id": 101,
				"market":   "enterprise",
				"group":    "enterprise",
				"account":  map[string]any{"id": 7, "username": "creator", "display_name": "测试账号"},
			})
		case "/api/oauth/device/complete":
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		case "/v1/beeftv/connection":
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"message":"账户服务维护中"}`))
		case "/v1/beeftv/topup/info":
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"message":"上游收银台不可用"}`))
		case "/v1/beeftv/topup/reconcile":
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"message":"查询过于频繁"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(upstream.Close)

	dir := t.TempDir()
	store, err := workspace.NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := beeftv.New(beeftv.Options{
		DataDir:       dir,
		Origin:        upstream.URL,
		Provider:      store,
		ClientVersion: "test",
		Hostname:      "test",
		HTTPClient:    upstream.Client(),
		OpenURL:       func(string) error { return nil },
		Sleep:         func(time.Duration) {},
		FetchCatalog: func(string, string) ([]beeftv.CatalogModel, error) {
			return []beeftv.CatalogModel{{ID: "gpt-test", SupportedEndpointTypes: []string{"openai"}}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(connection.Close)

	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: "local", DataDir: dir}))
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{
		RequestCoordinator: &stubRequestCoordinator{allowed: true},
		ProviderConfig:     store,
		BeefTV:             connection,
	}))
	RegisterBeefTVConnectionRoutes(router.Group("/api"), stubBeefTVConnections{service: connection})

	startRec := httptest.NewRecorder()
	router.ServeHTTP(startRec, httptest.NewRequest(http.MethodPost, "/api/beeftv/connection/start", nil))
	if startRec.Code != http.StatusOK {
		t.Fatalf("start status = %d body=%s", startRec.Code, startRec.Body.String())
	}
	deadline := time.Now().Add(2 * time.Second)
	for connection.Status().State != beeftv.StateConnected && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := connection.Status().State; got != beeftv.StateConnected {
		t.Fatalf("expected connected state, got %q", got)
	}

	for _, tc := range []struct {
		method     string
		path       string
		body       string
		wantStatus int
		wantReason string
	}{
		{http.MethodPost, "/api/beeftv/connection/topup/checkout", `{"paymentMethod":"unsupported"}`, http.StatusBadRequest, "invalid_argument"},
		{http.MethodGet, "/api/beeftv/connection?refresh=1", "", http.StatusServiceUnavailable, "unavailable"},
		{http.MethodGet, "/api/beeftv/connection/topup/info", "", http.StatusBadGateway, "bad_gateway"},
		{http.MethodPost, "/api/beeftv/connection/topup/reconcile", `{"tradeNo":"T1"}`, http.StatusTooManyRequests, "rate_limited"},
	} {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body)))
		if recorder.Code != tc.wantStatus {
			t.Fatalf("%s %s status = %d, want %d (body=%s)", tc.method, tc.path, recorder.Code, tc.wantStatus, recorder.Body.String())
		}
		var errEnv struct {
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &errEnv); err != nil {
			t.Fatalf("unmarshal %s %s: %v", tc.method, tc.path, err)
		}
		if errEnv.Reason != tc.wantReason {
			t.Fatalf("%s %s reason = %q, want %q", tc.method, tc.path, errEnv.Reason, tc.wantReason)
		}
	}
}
