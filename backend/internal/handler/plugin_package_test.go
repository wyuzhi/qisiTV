package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/plugins"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/skills"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type fakePluginCenter struct {
	user      *model.User
	pluginSvc *plugins.Service
}

func (f *fakePluginCenter) WorkspaceOwner(string) (*model.User, error) {
	return f.user, nil
}

func (f *fakePluginCenter) LocalWorkspaceOwner() (*model.User, error) {
	return f.user, nil
}

func (f *fakePluginCenter) PluginDomain() *plugins.Service {
	return f.pluginSvc
}

func (f *fakePluginCenter) PluginsForUser(*model.User) ([]plugins.View, error) {
	return f.pluginSvc.List(), nil
}

func (f *fakePluginCenter) RequireAdmin(*model.User) error {
	return nil
}

func (f *fakePluginCenter) InstallPluginForAdmin(_ *model.User, data []byte, fileName string) (plugins.View, error) {
	return f.pluginSvc.Install(data, fileName)
}

func (f *fakePluginCenter) SetUserPluginEnabled(actor *model.User, pluginID string, enabled bool) (plugins.StateView, error) {
	return f.pluginSvc.SetUserEnabled(actor, pluginID, enabled)
}

func (f *fakePluginCenter) UninstallPluginForAdmin(_ *model.User, id string) error {
	return f.pluginSvc.Uninstall(id)
}

func (f *fakePluginCenter) RequireFeature(string) error {
	return nil
}

func (f *fakePluginCenter) SetPluginPlatformAvailability(_ *model.User, pluginID string, available bool) (plugins.AdminStateView, error) {
	view, err := f.pluginSvc.SetEnabled(pluginID, available)
	if err != nil {
		return plugins.AdminStateView{}, err
	}
	return plugins.AdminStateView{
		StateView: plugins.StateView{
			PluginID:          pluginID,
			PlatformAvailable: view.Status == plugins.StatusEnabled,
			EffectiveEnabled:  view.Status == plugins.StatusEnabled,
		},
	}, nil
}

func (f *fakePluginCenter) RequirePluginForUser(_ string, pluginID string) error {
	return f.pluginSvc.RequireForUser(f.user.ID, pluginID)
}

func createSampleHandlerPluginPackage(t *testing.T, root string, id string, version string) string {
	t.Helper()
	pkgDir := filepath.Join(root, id)
	if err := os.MkdirAll(filepath.Join(pkgDir, "extensions"), 0o755); err != nil {
		t.Fatalf("mkdir extensions: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(pkgDir, "skills", "story-card"), 0o755); err != nil {
		t.Fatalf("mkdir skills: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(pkgDir, "client"), 0o755); err != nil {
		t.Fatalf("mkdir client: %v", err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "extensions", "index.js"), []byte("export default function() {}\n"), 0o644); err != nil {
		t.Fatalf("write extension: %v", err)
	}
	skillContent := "---\nname: Story Card Skill\ndescription: Helps create story cards\n---\n# Story Card\nUse story card nodes.\n"
	if err := os.WriteFile(filepath.Join(pkgDir, "skills", "story-card", "SKILL.md"), []byte(skillContent), 0o644); err != nil {
		t.Fatalf("write skill: %v", err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "client", "index.js"), []byte("export function registerClientPlugin() {}\n"), 0o644); err != nil {
		t.Fatalf("write client entry: %v", err)
	}
	pkgJSON := `{
  "name": "@beeftv/plugin-` + id + `",
  "version": "` + version + `",
  "description": "Handler test plugin",
  "keywords": ["beeftv-plugin", "pi-package"],
  "pi": {
    "extensions": ["./extensions/index.js"],
    "skills": ["./skills"]
  },
  "beeftv": {
    "schemaVersion": 1,
    "id": "` + id + `",
    "displayName": "Story Card Plugin",
    "category": "canvas",
    "client": "./client/index.js",
    "contributes": {
      "canvasNodes": [
        {
          "type": "` + id + `.card",
          "title": "Story Card",
          "renderer": "client",
          "defaultWidth": 400,
          "defaultHeight": 280
        }
      ]
    }
  }
}`
	if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(pkgJSON), 0o644); err != nil {
		t.Fatalf("write package.json: %v", err)
	}
	return pkgDir
}

func TestPluginPackageRoutesAndSkillSyncLifecycle(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmpDir := t.TempDir()

	runtime, err := plugins.NewRuntime(filepath.Join(tmpDir, "plugins-data"))
	if err != nil {
		t.Fatalf("NewRuntime: %v", err)
	}
	pluginSvc := plugins.New(runtime, nil)
	db, err := gorm.Open(sqlite.Open("file:"+kernel.NewID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.Skill{}, &model.SkillVersion{}, &model.SkillFile{}, &model.UserSkillState{}, &model.Workspace{}, &model.SystemSetting{}); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	if err := db.Create(&model.Workspace{ID: "admin-1", Name: "Admin Workspace"}).Error; err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	skillsSvc := skills.New(repository.New(db), filepath.Join(tmpDir, "skills-data"), nil)
	pluginSvc.SetSkillSyncHook(skillsSvc.ApplyPluginSkills)
	pluginSvc.SetPackageFetcher(copyPackageForTest)

	center := &fakePluginCenter{
		user: &model.User{
			ID:   "admin-1",
			Role: model.UserRoleAdmin,
		},
		pluginSvc: pluginSvc,
	}

	router := gin.New()
	api := router.Group("/api")
	RegisterPluginRoutes(api, center)

	pkgDir := createSampleHandlerPluginPackage(t, tmpDir, "story-card", "1.0.0")

	// 1. Install package from local source path via POST /api/plugins/install
	installBody, _ := json.Marshal(map[string]any{"source": pkgDir})
	req := httptest.NewRequest(http.MethodPost, "/api/plugins/install", bytes.NewReader(installBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/plugins/install status = %d, body = %s", rec.Code, rec.Body.String())
	}

	// Verify skill was automatically synced into skills service
	addedSkills, err := skillsSvc.AddedSkills("admin-1")
	if err != nil {
		t.Fatalf("AddedSkills: %v", err)
	}
	foundSkill := false
	for _, item := range addedSkills {
		if strings.HasPrefix(item.SkillID, "plugin-story-card-") {
			foundSkill = true
			break
		}
	}
	if !foundSkill {
		t.Fatalf("expected plugin skill to be synced into skills catalog, got %+v", addedSkills)
	}

	// 2. GET /api/plugins/packages/enabled returns the installed package
	req = httptest.NewRequest(http.MethodGet, "/api/plugins/packages/enabled", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/plugins/packages/enabled status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"story-card"`) {
		t.Fatalf("expected story-card in enabled packages response: %s", rec.Body.String())
	}

	// 3. GET /api/plugins/:id/files/*filepath serves client/index.js and blocks traversal
	req = httptest.NewRequest(http.MethodGet, "/api/plugins/story-card/files/client/index.js", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET client/index.js status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Header().Get("Content-Type"), "javascript") {
		t.Fatalf("unexpected Content-Type: %s", rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Body.String(), "registerClientPlugin") {
		t.Fatalf("unexpected client/index.js body: %s", rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/plugins/story-card/files/../package.json", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code == http.StatusOK || !strings.Contains(rec.Body.String(), `"reason"`) {
		t.Fatalf("expected path traversal to fail with an envelope, got %d %s", rec.Code, rec.Body.String())
	}

	// 4. POST /api/plugins/:id/load-error marks plugin invalid
	errBody, _ := json.Marshal(map[string]any{"error": "syntax error in extension"})
	req = httptest.NewRequest(http.MethodPost, "/api/plugins/story-card/load-error", bytes.NewReader(errBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/plugins/story-card/load-error status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"invalid"`) {
		t.Fatalf("expected plugin status invalid in response: %s", rec.Body.String())
	}

	// 5. Package plugins are system-scoped: disable and re-enable through the admin toggle
	req = httptest.NewRequest(http.MethodPost, "/api/plugins/story-card/disable", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/plugins/story-card/disable status = %d, body = %s", rec.Code, rec.Body.String())
	}
	addedAfterDisable, _ := skillsSvc.AddedSkills("admin-1")
	for _, item := range addedAfterDisable {
		if strings.HasPrefix(item.SkillID, "plugin-story-card-") {
			t.Fatalf("expected plugin skill to be removed when plugin is disabled, still found %+v", item)
		}
	}

	req = httptest.NewRequest(http.MethodPost, "/api/plugins/story-card/enable", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/plugins/story-card/enable status = %d, body = %s", rec.Code, rec.Body.String())
	}

	// 6. GET /api/plugins/market/search returns local package match
	req = httptest.NewRequest(http.MethodGet, "/api/plugins/market/search?q=story-card", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/plugins/market/search status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"story-card"`) {
		t.Fatalf("expected story-card in market search response: %s", rec.Body.String())
	}

	// 7. DELETE /api/plugins/:id uninstalls package and removes skills
	req = httptest.NewRequest(http.MethodDelete, "/api/plugins/story-card", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE /api/plugins/story-card status = %d, body = %s", rec.Code, rec.Body.String())
	}
	addedAfterDelete, _ := skillsSvc.AddedSkills("admin-1")
	for _, item := range addedAfterDelete {
		if strings.HasPrefix(item.SkillID, "plugin-story-card-") {
			t.Fatalf("expected plugin skill to be removed after uninstall, still found %+v", item)
		}
	}
}

func copyPackageForTest(_ context.Context, spec, _ string, prefixDir string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(spec, "package.json"))
	if err != nil {
		return "", err
	}
	var pkg struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		return "", err
	}
	root := filepath.Join(prefixDir, "node_modules", filepath.FromSlash(pkg.Name))
	return root, os.CopyFS(root, os.DirFS(spec))
}
