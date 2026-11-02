package handler

import (
	"testing"

	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

func TestUserDataIncrementalRoutesAreRegistered(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	svc := &app.Service{}
	RegisterUserDataRoutes(router.Group("/api"), svc, svc.CanvasService(), svc.PromptService(), svc.AssetLibraryService(), svc.ResourceService(), svc.PlaybackService(), svc, svc, svc)
	wanted := map[string]bool{
		"GET /api/canvas-projects":           false,
		"GET /api/canvas-projects/:id":       false,
		"POST /api/assets/batch":             false,
		"GET /api/resources/storage-usage":   false,
		"PATCH /api/resources/storage-usage": false,
	}
	for _, route := range router.Routes() {
		key := route.Method + " " + route.Path
		if _, exists := wanted[key]; exists {
			wanted[key] = true
		}
	}
	for route, found := range wanted {
		if !found {
			t.Errorf("missing route: %s", route)
		}
	}
}
