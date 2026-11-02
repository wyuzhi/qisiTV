package handler

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"qisitv/backend/internal/app"
	"qisitv/backend/internal/database"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestPlaybackMissingCopyDoesNotReturnStaleVariant304(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dataDir := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(dataDir, "test.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	svc := app.NewLocal(repository.New(db), dataDir)
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: "video", UserID: owner.ID, Kind: "video", MimeType: "video/mp4", Provider: "local", Status: model.ResourceStatusReady,
		ObjectKey: "video.mp4", PlaybackStatus: model.PlaybackStatusReady, PlaybackObjectKey: "video.mp4"}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "resources"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "resources", "video.mp4"), []byte("original-video"), 0644); err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	RegisterUserDataRoutes(router.Group("/api"), svc, svc.CanvasService(), svc.PromptService(), svc.AssetLibraryService(), svc.ResourceService(), svc.PlaybackService(), svc, svc, svc)
	request := httptest.NewRequest(http.MethodGet, "/api/resources/video/file?variant=playback&proxy=1", nil)
	request.Header.Set("If-None-Match", playbackResponseETag(resourceResponseETag(&resource)))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "original-video" {
		t.Fatalf("missing playback response = %d %s", response.Code, response.Body.String())
	}
	if response.Header().Get("ETag") != resourceResponseETag(&resource) {
		t.Fatal("fallback retained playback ETag")
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "playback"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "playback", "video.mp4"), []byte("playback-video"), 0644); err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodGet, "/api/resources/video/file?variant=playback&proxy=1", nil)
	request.Header.Set("If-None-Match", playbackResponseETag(resourceResponseETag(&resource)))
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusNotModified {
		t.Fatalf("existing playback response = %d", response.Code)
	}
	request = httptest.NewRequest(http.MethodGet, "/api/resources/video/file?variant=playback&proxy=1", nil)
	request.Header.Set("Range", "bytes=0-7")
	request.Header.Set("If-Range", playbackResponseETag(resourceResponseETag(&resource)))
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusPartialContent || response.Body.String() != "playback" {
		t.Fatalf("playback range = %d %s", response.Code, response.Body.String())
	}

	missingResource := model.Resource{
		ID: "missing-image", UserID: owner.ID, Kind: "image", MimeType: "image/png",
		Provider: "local", Status: model.ResourceStatusReady, ObjectKey: "missing.png",
	}
	if err := db.Create(&missingResource).Error; err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodGet, "/api/resources/missing-image/file?proxy=1", nil)
	request.Header.Set("If-None-Match", resourceResponseETag(&missingResource))
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing local file status = %d, want 404: %s", response.Code, response.Body.String())
	}
	if response.Header().Get("ETag") != "" || response.Header().Get("Cache-Control") != "" {
		t.Fatalf("missing local file leaked cache headers: ETag=%q Cache-Control=%q", response.Header().Get("ETag"), response.Header().Get("Cache-Control"))
	}
}
