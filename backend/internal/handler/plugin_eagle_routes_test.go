package handler

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/eagle"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/plugins"

	"github.com/gin-gonic/gin"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestEaglePluginCanonicalAndLegacyRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)

	fakeEagleClient := eagle.NewWithTransport(roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/api/library/info" {
			return &http.Response{
				StatusCode: http.StatusNotFound,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("not found")),
			}, nil
		}
		header := make(http.Header)
		header.Set("Content-Type", "application/json")
		body := `{"status":"success","data":{"applicationVersion":"4.0.0","library":{"name":"DemoLib","path":"/tmp/Demo.library"},"folders":[]}}`
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     header,
			Body:       io.NopCloser(strings.NewReader(body)),
		}, nil
	}))

	eagleRoutes := []string{
		"/api/plugins/beeftv-plugin-eagle-asset-connector/library",
		"/api/plugins/eagle-asset-connector/library",
		"/api/plugins/eagle/library",
	}

	buildRouter := func(t *testing.T, enabledID string) *gin.Engine {
		t.Helper()
		tmpDir := t.TempDir()
		runtime, err := plugins.NewRuntime(filepath.Join(tmpDir, "plugins-data"))
		if err != nil {
			t.Fatalf("NewRuntime: %v", err)
		}
		pluginSvc := plugins.New(runtime, nil)
		pluginSvc.SetPackageFetcher(copyPackageForTest)
		if enabledID != "" {
			pkgDir := createSampleHandlerPluginPackage(t, tmpDir, enabledID, "0.2.0")
			if _, err := pluginSvc.InstallPackage(pkgDir, ""); err != nil {
				t.Fatalf("InstallPackage(%s): %v", enabledID, err)
			}
		}
		center := &fakePluginCenter{
			user: &model.User{
				ID:   "admin-1",
				Role: model.UserRoleAdmin,
			},
			pluginSvc: pluginSvc,
		}
		router := gin.New()
		router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{Eagle: fakeEagleClient}))
		api := router.Group("/api")
		RegisterPluginRoutes(api, center)
		return router
	}

	t.Run("rejects all eagle routes when neither canonical nor legacy plugin is enabled", func(t *testing.T) {
		router := buildRouter(t, "")
		for _, route := range eagleRoutes {
			req := httptest.NewRequest(http.MethodGet, route+"?baseUrl=http://127.0.0.1:41595", nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code == http.StatusOK {
				t.Fatalf("expected non-200 on %s when disabled, got 200: %s", route, rec.Body.String())
			}
		}
	})

	t.Run("serves canonical and legacy eagle routes when canonical package is enabled", func(t *testing.T) {
		router := buildRouter(t, plugins.EagleAssetConnector)
		for _, route := range eagleRoutes {
			req := httptest.NewRequest(http.MethodGet, route+"?baseUrl=http://127.0.0.1:41595", nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("GET %s status = %d, body = %s", route, rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"DemoLib"`) {
				t.Fatalf("GET %s unexpected body: %s", route, rec.Body.String())
			}
		}
	})

	t.Run("serves canonical and legacy eagle routes when legacy package is enabled", func(t *testing.T) {
		router := buildRouter(t, plugins.EagleAssetConnectorLegacy)
		for _, route := range eagleRoutes {
			req := httptest.NewRequest(http.MethodGet, route+"?baseUrl=http://127.0.0.1:41595", nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("GET %s status = %d, body = %s", route, rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"DemoLib"`) {
				t.Fatalf("GET %s unexpected body: %s", route, rec.Body.String())
			}
		}
	})
}
