package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"qisitv/backend/internal/app"
	"qisitv/backend/internal/database"
	"qisitv/backend/internal/repository"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestCanvasControlHTTPAndInteractionRoundTrip(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "control.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err = database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	svc := app.NewLocal(repository.New(db), t.TempDir())
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.UpsertUserCanvasProject(owner.ID, json.RawMessage(`{"id":"canvas","revision":0,"title":"integration","nodes":[],"connections":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{RequestCoordinator: &stubRequestCoordinator{allowed: true}}))
	RegisterDesktopUserDataRoutes(router.Group("/api"), svc)
	request := func(method, path, body string, status int) map[string]json.RawMessage {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		if response.Code != status {
			t.Fatalf("%s %s status=%d: %s", method, path, response.Code, response.Body.String())
		}
		var envelope struct {
			Data map[string]json.RawMessage `json:"data"`
		}
		_ = json.Unmarshal(response.Body.Bytes(), &envelope)
		return envelope.Data
	}
	data := request(http.MethodPost, "/api/canvas-projects/canvas/operations", `{"baseRevision":1,"operations":[{"op":"add","node":{"id":"text","type":"text","title":"Codex"}}]}`, http.StatusOK)
	if !strings.Contains(string(data["project"]), `"title":"Codex"`) {
		t.Fatalf("not a full project: %s", data["project"])
	}
	request(http.MethodPost, "/api/canvas-projects/canvas/operations", `{"baseRevision":1,"operations":[{"op":"delete","nodeId":"text"}]}`, http.StatusConflict)
	request(http.MethodPost, "/api/canvas-projects/canvas/operations", `{"operations":[{"op":"project","patch":{"title":"bad"}}]} {}`, http.StatusBadRequest)
	request(http.MethodPut, "/api/canvas-projects/canvas/interaction", `{"tabId":"browser-tab","isActive":true,"selectedNodeIds":["text"],"viewport":{"x":4,"y":5,"k":1.5}}`, http.StatusOK)
	data = request(http.MethodGet, "/api/canvas-interaction", "", http.StatusOK)
	if !strings.Contains(string(data["interaction"]), `"selectedNodeIds":["text"]`) {
		t.Fatalf("interaction did not survive app facade: %s", data["interaction"])
	}
	request(http.MethodPut, "/api/canvas-projects/canvas/interaction", `{"tabId":"browser-tab","isActive":false,"selectedNodeIds":["text"],"viewport":{"x":4,"y":5,"k":1.5}}`, http.StatusOK)
	data = request(http.MethodGet, "/api/canvas-interaction", "", http.StatusOK)
	if !strings.Contains(string(data["interaction"]), `"isActive":false`) {
		t.Fatalf("switching to Codex lost selection: %s", data["interaction"])
	}
	request(http.MethodGet, "/api/canvas-projects/missing/interaction", "", http.StatusNotFound)
}
