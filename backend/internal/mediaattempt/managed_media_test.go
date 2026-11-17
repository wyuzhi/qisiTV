package mediaattempt

import (
	"context"
	"encoding/json"
	"qisitv/backend/internal/beeftv"
	"qisitv/backend/internal/database"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestManagedMediaActiveStageAndObserveTiming(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "test.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatalf("migrate schema: %v", err)
	}
	repo := repository.New(db)

	now := time.Now()
	leaseExp := now.Add(5 * time.Minute)
	task := model.Task{
		ID:             "task-sub-erase",
		UserID:         "u1",
		Type:           "canvas_video",
		Operation:      "media.video.subtitle_erase",
		Status:         model.TaskStatusRunning,
		Stage:          "正在连接上游",
		LeaseOwner:     "worker-1",
		LeaseExpiresAt: &leaseExp,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatalf("create task: %v", err)
	}

	port := managedMediaPort{service: &Service{repo: repo}}
	ctx := context.WithValue(context.Background(), TaskContext{}, task)
	port.Project(ctx, beeftv.MediaTask{TaskID: "remote-1", MediaType: "video", Status: "in_progress"})

	stored, err := repo.Task(task.ID)
	if err != nil || stored == nil {
		t.Fatalf("load task: %v", err)
	}
	if stored.Stage != "正在消除视频字幕" {
		t.Fatalf("expected stage 正在消除视频字幕, got %q", stored.Stage)
	}

	// Once stage advances further (e.g., 正在取回生成结果), subsequent polls must not overwrite it back.
	if err := repo.UpdateTaskStageForLease(task.ID, task.LeaseOwner, "正在取回生成结果"); err != nil {
		t.Fatalf("advance stage: %v", err)
	}
	port.Project(ctx, beeftv.MediaTask{TaskID: "remote-1", MediaType: "video", Status: "in_progress"})
	stored, err = repo.Task(task.ID)
	if err != nil || stored.Stage != "正在取回生成结果" {
		t.Fatalf("expected stage 正在取回生成结果 preserved, got %q (err=%v)", stored.Stage, err)
	}

	// Legacy subtitle-erase tasks with empty Operation but InputJSON subtitleErase also map to 正在消除视频字幕.
	legacyTask := model.Task{
		ID:             "task-sub-erase-legacy",
		UserID:         "u1",
		Type:           "canvas_video",
		Status:         model.TaskStatusRunning,
		Stage:          "正在连接上游",
		InputJSON:      `{"mode":"video","subtitleErase":{"eraseMethod":"auto"}}`,
		LeaseOwner:     "worker-1",
		LeaseExpiresAt: &leaseExp,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := db.Create(&legacyTask).Error; err != nil {
		t.Fatalf("create legacy task: %v", err)
	}
	port.Project(context.WithValue(context.Background(), TaskContext{}, legacyTask), beeftv.MediaTask{TaskID: "remote-legacy", MediaType: "video", Status: "in_progress"})
	storedLegacy, err := repo.Task(legacyTask.ID)
	if err != nil || storedLegacy == nil || storedLegacy.Stage != "正在消除视频字幕" {
		t.Fatalf("expected legacy task stage 正在消除视频字幕, got %+v (err=%v)", storedLegacy, err)
	}

	// Verify MediaClient.Observe receives pre-flight startedAt so durationMs > 0.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(25 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(beeftv.MediaTask{
			TaskRef:   "remote-1",
			MediaType: "video",
			Status:    "in_progress",
			Outputs:   []beeftv.MediaOutput{},
		})
	}))
	defer server.Close()

	var observedElapsed time.Duration
	client := &beeftv.MediaClient{
		BaseURL:       server.URL,
		APIKey:        "test-key",
		AllowHTTPTest: true,
		Client:        server.Client(),
		Observe: func(_ *http.Request, _ *http.Response, _ []byte, startedAt time.Time, _ error) {
			observedElapsed = time.Since(startedAt)
		},
	}
	if _, err := client.Query(context.Background(), "remote-1", "video"); err != nil {
		t.Fatalf("Query: %v", err)
	}
	if observedElapsed < 20*time.Millisecond {
		t.Fatalf("expected observedElapsed >= 20ms, got %v", observedElapsed)
	}
}
