package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"qisitv/backend/internal/app"
	"qisitv/backend/internal/database"
	"qisitv/backend/internal/repository"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestAgentCapabilitiesOmitCommerceMetadata(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	local := app.NewLocal(repo, t.TempDir())
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterAgentRoutes(router.Group("/api"), local)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/agent/capabilities", nil)
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(recorder.Body.String()), "billing") {
		t.Fatalf("agent capabilities still expose commerce metadata: %s", recorder.Body.String())
	}
}
