package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/workspace"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type captureTaskPort struct {
	mu             sync.Mutex
	userID         string
	render         localtask.TimelineRenderCreateRequest
	trans          localtask.TimelineTranscriptionCreateRequest
	depth          localtask.DepthCaptureCreateRequest
	gen            localtask.CreateRequest
	recovered      string
	manualRecovery bool
}

func (c *captureTaskPort) TasksWithOptions(string, localtask.ListOptions) ([]localtask.Summary, error) {
	return nil, nil
}

func (c *captureTaskPort) CreateTimelineRenderTask(userID string, req localtask.TimelineRenderCreateRequest) (*model.Task, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.userID = userID
	c.render = req
	return &model.Task{ID: "render-1", Type: model.TaskTypeTimelineRender, Status: model.TaskStatusQueued}, nil
}

func (c *captureTaskPort) CreateTimelineTranscriptionTask(userID string, req localtask.TimelineTranscriptionCreateRequest) (*model.Task, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.userID = userID
	c.trans = req
	return &model.Task{ID: "trans-1", Type: model.TaskTypeTimelineTranscription, Status: model.TaskStatusQueued}, nil
}

func (c *captureTaskPort) CreateDepthCaptureTask(userID string, req localtask.DepthCaptureCreateRequest) (*model.Task, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.userID = userID
	c.depth = req
	return &model.Task{ID: "depth-1", Type: model.TaskTypeDepthCapture, Status: model.TaskStatusQueued}, nil
}

func (c *captureTaskPort) RecoverTask(ctx context.Context, userID, id string) (*model.Task, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.userID = userID
	c.recovered = id
	c.manualRecovery = localtask.ManualRecovery(ctx)
	return &model.Task{ID: id, UserID: userID, Status: model.TaskStatusSucceeded}, nil
}

func (c *captureTaskPort) CreateTask(userID string, req localtask.CreateRequest) (*model.Task, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.userID = userID
	c.gen = req
	return &model.Task{ID: "gen-1", Type: req.Type, Status: model.TaskStatusQueued}, nil
}

func TestSpecializedRoutesBindLocalExecutorRequests(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "specialized-routes.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	svc := app.NewLocal(repository.New(db), t.TempDir())
	t.Cleanup(func() { _ = svc.Close() })
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	capture := &captureTaskPort{}
	deps := defaultRuntimeDependencies(svc)
	deps.Tasks = capture
	deps.Generation = capture
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: owner.ID, DataDir: t.TempDir()}))
	router.Use(RuntimeDependenciesMiddleware(deps))
	RegisterTaskRoutes(router.Group("/api"), svc)

	visible := true
	renderBody, _ := json.Marshal(localtask.TimelineRenderCreateRequest{
		ProjectID:         "prj-1",
		ClientOperationID: "timeline:http-render",
		Timeline: editing.Project{
			Version: 2, DurationMs: 2000,
			Tracks: []editing.Track{{ID: "v", Kind: "video", Visible: &visible}},
			Clips: []editing.Clip{{
				ID: "v", Kind: "video", TrackID: "v", DurationMs: 2000, Volume: 1,
				DirectMedia: &editing.DirectMedia{ID: "v", Kind: "video", StorageKey: "resource:res-1"},
			}},
		},
	})
	postJSON(t, router, "/api/timeline/renders", renderBody)
	if capture.render.ProjectID != "prj-1" || capture.render.ClientOperationID != "timeline:http-render" || capture.userID != owner.ID {
		t.Fatalf("render bound = %+v user=%s", capture.render, capture.userID)
	}

	transBody, _ := json.Marshal(localtask.TimelineTranscriptionCreateRequest{
		ResourceID: "res-1", Language: "zh", ProjectID: "prj-1", ClientOperationID: "timeline:http-trans",
	})
	postJSON(t, router, "/api/timeline/transcriptions", transBody)
	if capture.trans.ResourceID != "res-1" || capture.trans.ClientOperationID != "timeline:http-trans" {
		t.Fatalf("transcription bound = %+v", capture.trans)
	}

	depthBody, _ := json.Marshal(localtask.DepthCaptureCreateRequest{
		ProjectID: "prj-1", ResourceID: "res-1", ClientOperationID: "depth:http-1",
	})
	postJSON(t, router, "/api/depth-captures", depthBody)
	if capture.depth.ResourceID != "res-1" || capture.depth.ClientOperationID != "depth:http-1" {
		t.Fatalf("depth bound = %+v", capture.depth)
	}

	genBody, _ := json.Marshal(localtask.CreateRequest{Type: model.TaskTypeTimelineRender, Prompt: "时间线渲染"})
	postJSON(t, router, "/api/tasks", genBody)
	if capture.gen.Type != model.TaskTypeTimelineRender || capture.gen.Prompt != "时间线渲染" {
		t.Fatalf("generation bound = %+v", capture.gen)
	}
	if capture.render.Timeline.Clips[0].DirectMedia == nil {
		t.Fatal("render timeline was not bound")
	}

	postJSON(t, router, "/api/tasks/task-recover-1/recover", nil)
	if capture.recovered != "task-recover-1" || capture.userID != owner.ID || !capture.manualRecovery {
		t.Fatalf("recover bound = %s user=%s manual=%v", capture.recovered, capture.userID, capture.manualRecovery)
	}
}

func postJSON(t *testing.T, router *gin.Engine, path string, body []byte) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("%s status=%d body=%s", path, recorder.Code, recorder.Body.String())
	}
}

type stubSubtitleEraseService struct {
	*app.Service
	caps   map[string]any
	create func(context.Context, string, generation.SubtitleEraseRequest) (*model.Task, error)
}

func (s stubSubtitleEraseService) VideoSubtitleEraseCapabilities(context.Context) map[string]any {
	return s.caps
}

func (s stubSubtitleEraseService) CreateVideoSubtitleErase(ctx context.Context, user string, req generation.SubtitleEraseRequest) (*model.Task, error) {
	return s.create(ctx, user, req)
}

func TestVideoSubtitleEraseRoutesCapabilitiesContractAndModeGuard(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "subtitle-erase-routes.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	svc := app.NewLocal(repository.New(db), t.TempDir())
	t.Cleanup(func() { _ = svc.Close() })
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	stub := stubSubtitleEraseService{
		Service: svc,
		caps: map[string]any{
			"model":              generation.SubtitleEraseModelName,
			"available":          true,
			"capabilitiesLoaded": true,
			"availableModels":    []string{generation.SubtitleEraseModelName},
			"eraseTypes":         []string{"subtitle"},
			"eraseMethods":       []string{"auto", "custom"},
			"subtitleModels":     []string{"standard", "area"},
			"translateDstLangs":  []string{"zh", "en", "tr"},
			"maxVideoDurationMs": 600000,
			"cloudProcessing":    true,
		},
		create: func(_ context.Context, user string, req generation.SubtitleEraseRequest) (*model.Task, error) {
			return &model.Task{ID: "erase-1", UserID: user, Type: "canvas_video", Operation: "media.video.subtitle_erase", Status: model.TaskStatusQueued}, nil
		},
	}
	deps := defaultRuntimeDependencies(svc)
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: owner.ID, DataDir: t.TempDir()}))
	router.Use(RuntimeDependenciesMiddleware(deps))
	registerVideoSubtitleEraseRoutes(router.Group("/api"), stub)

	capRec := httptest.NewRecorder()
	router.ServeHTTP(capRec, httptest.NewRequest(http.MethodGet, "/api/video-subtitle-erase/capabilities", nil))
	if capRec.Code != http.StatusOK {
		t.Fatalf("GET capabilities status=%d body=%s", capRec.Code, capRec.Body.String())
	}
	var capEnvelope struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(capRec.Body.Bytes(), &capEnvelope); err != nil {
		t.Fatal(err)
	}
	if _, nested := capEnvelope.Data["smartErase"]; nested {
		t.Fatalf("expected flat capability contract without nested smartErase, got %+v", capEnvelope.Data)
	}
	if len(capEnvelope.Data["availableModels"].([]any)) != 1 || len(capEnvelope.Data["eraseTypes"].([]any)) != 1 {
		t.Fatalf("unexpected flat capability payload: %+v", capEnvelope.Data)
	}

	untrustedReq := httptest.NewRequest(http.MethodPost, "/api/video-subtitle-erase/tasks", bytes.NewReader([]byte(`{"resourceId":"res-1","channelId":"beeftv","eraseType":"subtitle","clientOperationId":"op-untrusted"}`)))
	untrustedReq.Header.Set("Content-Type", "application/json")
	untrustedReq.Header.Set("X-Beeftv-Client", "external-cli")
	untrustedRec := httptest.NewRecorder()
	router.ServeHTTP(untrustedRec, untrustedReq)
	if untrustedRec.Code != http.StatusForbidden {
		t.Fatalf("expected external client header to fail with 403, got %d body=%s", untrustedRec.Code, untrustedRec.Body.String())
	}

	blockedReq := httptest.NewRequest(http.MethodPost, "/api/video-subtitle-erase/tasks", bytes.NewReader([]byte(`{"resourceId":"res-1","channelId":"beeftv","eraseType":"watermark","clientOperationId":"op-wm"}`)))
	blockedReq.Header.Set("Content-Type", "application/json")
	blockedRec := httptest.NewRecorder()
	router.ServeHTTP(blockedRec, blockedReq)
	if blockedRec.Code != http.StatusBadRequest {
		t.Fatalf("expected restricted watermark mode to fail with 400, got %d body=%s", blockedRec.Code, blockedRec.Body.String())
	}

	allowedReq := httptest.NewRequest(http.MethodPost, "/api/video-subtitle-erase/tasks", bytes.NewReader([]byte(`{"resourceId":"res-1","channelId":"beeftv","eraseType":"subtitle","subtitleModel":"standard","clientOperationId":"op-sub"}`)))
	allowedReq.Header.Set("Content-Type", "application/json")
	allowedRec := httptest.NewRecorder()
	router.ServeHTTP(allowedRec, allowedReq)
	if allowedRec.Code != http.StatusOK {
		t.Fatalf("expected allowed subtitle mode to succeed, got %d body=%s", allowedRec.Code, allowedRec.Body.String())
	}
}
