package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"qisitv/backend/internal/model"
)

// Manual-only browser fixture. No generation worker or real provider is started.
// BEEFTV_IMAGE_RECOVERY_PROBE=1 go test ./internal/app -run '^TestManualImageRecoveryProbe$' -count=1 -v -timeout=20m
func TestManualImageRecoveryProbe(t *testing.T) {
	if os.Getenv("BEEFTV_IMAGE_RECOVERY_PROBE") != "1" {
		t.Skip("set BEEFTV_IMAGE_RECOVERY_PROBE=1 for the local browser probe")
	}
	addr := os.Getenv("BEEFTV_IMAGE_RECOVERY_PROBE_ADDR")
	if addr == "" {
		addr = "127.0.0.1:19105"
	}
	if host, _, err := net.SplitHostPort(addr); err != nil || host != "127.0.0.1" {
		t.Fatal("probe address must use 127.0.0.1 and an explicit port")
	}
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	s, canvasID, revision := newAssistantTurnService(t)
	db := s.repo.DB()
	t.Cleanup(func() { closeDB(t, db) })
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	var gets, posts, resourceGets atomic.Int32
	marker := image.NewRGBA(image.Rect(0, 0, 320, 200))
	palette := []color.RGBA{{24, 126, 218, 255}, {245, 176, 40, 255}, {35, 184, 130, 255}, {202, 74, 158, 255}}
	for i, c := range palette {
		draw.Draw(marker, image.Rect((i%2)*160, (i/2)*100, (i%2+1)*160, (i/2+1)*100), &image.Uniform{C: c}, image.Point{}, draw.Src)
	}
	// A high-contrast cross distinguishes the actual recovered image from a placeholder.
	draw.Draw(marker, image.Rect(144, 28, 176, 172), image.White, image.Point{}, draw.Src)
	draw.Draw(marker, image.Rect(88, 84, 232, 116), image.White, image.Point{}, draw.Src)
	var pngBytes bytes.Buffer
	if err := png.Encode(&pngBytes, marker); err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			posts.Add(1)
			http.Error(w, "generation is unavailable in this fixture", http.StatusMethodNotAllowed)
			return
		}
		gets.Add(1)
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(pngBytes.Bytes())
	}))
	t.Cleanup(upstream.Close)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := s.backgroundWorkers().Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	task := model.Task{ID: "historical-image-probe", UserID: "local", ProjectID: canvasID, Type: "canvas_image", Status: model.TaskStatusFailed, Stage: "submission_unknown", Error: "context deadline exceeded", RouteRun: 3,
		InputJSON: `{"mode":"image","metadata":{"source":"canvas","nodeId":"n1"}}`}
	doc, err := json.Marshal(map[string]any{"id": canvasID, "title": "历史图片自动恢复验收", "revision": revision, "nodes": []any{map[string]any{"id": "n1", "type": "image", "title": "历史图片", "width": 320, "height": 200, "position": map[string]any{"x": 0, "y": 0}, "metadata": map[string]any{"taskId": task.ID, "status": "error", "error": task.Error, "generationSubmissionState": "unknown"}}}, "connections": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertUserCanvasProject("local", doc); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	receipt := model.ApiCallLog{ID: "historical-image-probe-receipt", UserID: task.UserID, TaskID: task.ID, Capability: "image", RequestKind: "create", Method: "POST", Path: "/v1/images/generations", APIFormat: "openai", Status: model.ApiCallStatusSucceeded, StatusCode: 200, ResponseBody: fmt.Sprintf(`{"data":[{"url":%q}]}`, upstream.URL+"/original.png")}
	if err := db.Create(&receipt).Error; err != nil {
		t.Fatal(err)
	}
	before, err := s.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	initial, err := s.Task("local", task.ID)
	if err != nil || initial.Outcome == nil || initial.Outcome.Phase != "retrievable" {
		t.Fatalf("initial task=%+v error=%v", initial, err)
	}
	respond := func(w http.ResponseWriter, value any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": value, "msg": ""})
	}
	var started atomic.Bool
	var startOnce, finishOnce sync.Once
	finished := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/probe/state", func(w http.ResponseWriter, r *http.Request) {
		current, err := s.UserCanvasProject("local", canvasID)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		got, err := s.Task("local", task.ID)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		var tasks, attempts int64
		if err := db.Model(&model.Task{}).Count(&tasks).Error; err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if err := db.Model(&model.RouteAttempt{}).Count(&attempts).Error; err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		respond(w, map[string]any{"before": json.RawMessage(before), "canvas": json.RawMessage(current), "task": got, "routeRun": got.RouteRun, "started": started.Load(), "upstreamGets": gets.Load(), "upstreamPosts": posts.Load(), "resourceGets": resourceGets.Load(), "taskCount": tasks, "routeAttempts": attempts})
	})
	mux.HandleFunc("POST /api/probe/start", func(w http.ResponseWriter, r *http.Request) {
		startOnce.Do(func() {
			ctx, _ := s.backgroundWorkers().Start()
			s.startGenerationDeliveryRecovery(ctx)
			started.Store(true)
		})
		respond(w, map[string]bool{"started": started.Load()})
	})
	mux.HandleFunc("POST /api/probe/finish", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]bool{"finished": true})
		finishOnce.Do(func() { close(finished) })
	})
	readResource := func(w http.ResponseWriter, r *http.Request) {
		resource, body, err := s.OpenResource("local", r.PathValue("id"))
		if err != nil {
			http.Error(w, err.Error(), 404)
			return
		}
		defer body.Close()
		resourceGets.Add(1)
		w.Header().Set("Content-Type", resource.MimeType)
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.Copy(w, body)
	}
	mux.HandleFunc("GET /api/resources/{id}/content", readResource)
	// The real CanvasNodeContent resolves resource: storage keys through /file.
	mux.HandleFunc("GET /api/resources/{id}/file", readResource)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()
	defer server.Close()
	t.Logf("image recovery probe listening at http://%s; POST /api/probe/start then POST /api/probe/finish", listener.Addr())
	select {
	case <-finished:
	case err := <-serveErr:
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := s.Task("local", task.ID)
	if err != nil || got.Status != model.TaskStatusSucceeded || got.Outcome == nil || got.Outcome.Phase != "ready" || got.RouteRun != 3 || gets.Load() != 1 || posts.Load() != 0 {
		t.Fatalf("probe finished before recovery acceptance: task=%+v GET=%d POST=%d err=%v", got, gets.Load(), posts.Load(), err)
	}
	raw, err := s.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Nodes []struct {
			Metadata map[string]any `json:"metadata"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &document); err != nil || len(document.Nodes) != 1 {
		t.Fatalf("unexpected canvas: %s %v", raw, err)
	}
	meta := document.Nodes[0].Metadata
	if meta["status"] != "success" || meta["content"] == nil || meta["storageKey"] == nil {
		t.Fatalf("legacy canvas was not updated: %s", raw)
	}
	var tasks, attempts int64
	if err := db.Model(&model.Task{}).Count(&tasks).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.RouteAttempt{}).Count(&attempts).Error; err != nil {
		t.Fatal(err)
	}
	if tasks != 1 || attempts != 0 {
		t.Fatalf("unexpected new task or route: tasks=%d routes=%d", tasks, attempts)
	}
}
