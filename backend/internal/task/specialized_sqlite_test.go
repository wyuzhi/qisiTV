package task

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/taskruntime"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type sqlitePersist struct{ repo *repository.Repository }

func (p sqlitePersist) CreateAdmitted(task *model.Task, limit int) error {
	return p.repo.CreateTaskWithActiveLimit(task, limit)
}

type sqliteProjects struct{ repo *repository.Repository }

func (p sqliteProjects) EnsureActive(userID, canvasOrProjectID string) error {
	if err := p.repo.RequireTaskScopeActive(userID, canvasOrProjectID); err != nil {
		if mapped := mapTaskScopeError(err); mapped != nil {
			return mapped
		}
		return err
	}
	return nil
}

type sqliteOwnedMedia struct{ repo *repository.Repository }

func (p sqliteOwnedMedia) Resource(userID, id string) (*model.Resource, error) {
	return p.repo.ResourceForUser(userID, id)
}

func specializedSQLite(t *testing.T, extra func(*Dependencies, *drainRuntime)) (*Service, *gorm.DB, *drainRuntime) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "specialized.db")+"?_busy_timeout=5000&_journal_mode=WAL&_foreign_keys=on"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	pool.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = pool.Close() })
	if err := db.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.Resource{}, &model.Project{}, &model.CanvasProject{}); err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	runtime := &drainRuntime{}
	deps := specializedDeps(sqlitePersist{repo: repo}, sqliteOwnedMedia{repo: repo}, runtime)
	deps.Projects = sqliteProjects{repo: repo}
	if extra != nil {
		extra(&deps, runtime)
	}
	return NewService(NewStore(repo), deps), db, runtime
}

func seedSQLiteUser(t *testing.T, db *gorm.DB, userID, projectID, resourceID, mime string) {
	t.Helper()
	if projectID != "" {
		if err := db.Create(&model.Project{ID: projectID, UserID: userID, Name: projectID, Status: model.ProjectStatusActive}).Error; err != nil {
			t.Fatal(err)
		}
	}
	if resourceID != "" {
		if err := db.Create(&model.Resource{
			ID: resourceID, UserID: userID, Kind: "media", Status: model.ResourceStatusReady,
			Provider: "local", MimeType: mime, Size: 2048, ObjectKey: "users/" + userID + "/" + resourceID,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
}

func countTasks(t *testing.T, db *gorm.DB, userID string) int64 {
	t.Helper()
	var n int64
	query := db.Model(&model.Task{})
	if userID != "" {
		query = query.Where("user_id = ?", userID)
	}
	if err := query.Count(&n).Error; err != nil {
		t.Fatal(err)
	}
	return n
}

func TestSQLiteEmptyProjectIDIsAllowed(t *testing.T) {
	svc, db, _ := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "", "res-1", "video/mp4")
	task, err := svc.CreateTimelineTranscriptionTask("owner", TimelineTranscriptionCreateRequest{ResourceID: "res-1"})
	if err != nil {
		t.Fatal(err)
	}
	if task.ProjectID != "" {
		t.Fatalf("projectId = %q", task.ProjectID)
	}
	if countTasks(t, db, "owner") != 1 {
		t.Fatalf("rows = %d", countTasks(t, db, "owner"))
	}
}

func TestSQLiteSpecializedAdmissionAcceptsLocalExecutorsWithoutCatalog(t *testing.T) {
	svc, db, _ := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "prj-1", "res-1", "video/mp4")

	render, err := svc.CreateTimelineRenderTask("owner", TimelineRenderCreateRequest{
		ProjectID: "prj-1", Timeline: renderableTimeline("resource:res-1"),
	})
	if err != nil {
		t.Fatal(err)
	}
	trans, err := svc.CreateTimelineTranscriptionTask("owner", TimelineTranscriptionCreateRequest{
		ResourceID: "res-1", Language: "zh", ProjectID: "prj-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	depth, err := svc.CreateDepthCaptureTask("owner", DepthCaptureCreateRequest{ProjectID: "prj-1", ResourceID: "res-1"})
	if err != nil {
		t.Fatal(err)
	}
	if render.Model != LocalExecutorRenderModel || trans.Model != LocalExecutorTranscriptionModel || depth.LogicalModelID != "" {
		t.Fatalf("schema render=%s trans=%s depth.logical=%q", render.Model, trans.Model, depth.LogicalModelID)
	}
	if countTasks(t, db, "owner") != 3 {
		t.Fatalf("rows = %d", countTasks(t, db, "owner"))
	}
}

func TestSQLiteConcurrentClientOperationReplaysOriginal(t *testing.T) {
	svc, db, _ := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "prj-1", "res-1", "video/mp4")
	req := TimelineTranscriptionCreateRequest{
		ResourceID: "res-1", Language: "zh", ProjectID: "prj-1", ClientOperationID: "timeline:race-1",
	}
	const workers = 8
	var wg sync.WaitGroup
	ids := make([]string, workers)
	errs := make([]error, workers)
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func(i int) {
			defer wg.Done()
			task, err := svc.CreateTimelineTranscriptionTask("owner", req)
			errs[i] = err
			if task != nil {
				ids[i] = task.ID
			}
		}(i)
	}
	wg.Wait()
	var first string
	for i := 0; i < workers; i++ {
		if errs[i] != nil {
			t.Fatalf("worker %d: %v", i, errs[i])
		}
		if ids[i] == "" {
			t.Fatalf("worker %d returned empty id", i)
		}
		if first == "" {
			first = ids[i]
		} else if ids[i] != first {
			t.Fatalf("ids diverged: %q %q", first, ids[i])
		}
	}
	if countTasks(t, db, "owner") != 1 {
		t.Fatalf("rows = %d", countTasks(t, db, "owner"))
	}
}

func TestSQLiteClientOperationMismatchRejectsWithoutInsert(t *testing.T) {
	svc, db, _ := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "prj-1", "res-1", "video/mp4")
	seedSQLiteUser(t, db, "owner", "", "res-2", "video/mp4")
	first, err := svc.CreateTimelineRenderTask("owner", TimelineRenderCreateRequest{
		ProjectID: "prj-1", Timeline: renderableTimeline("resource:res-1"), ClientOperationID: "timeline:mismatch-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.CreateTimelineRenderTask("owner", TimelineRenderCreateRequest{
		ProjectID: "prj-1", Timeline: renderableTimeline("resource:res-2"), ClientOperationID: "timeline:mismatch-1",
	})
	if err == nil || !isStatus(err, 409) {
		t.Fatalf("mismatch = %v", err)
	}
	if countTasks(t, db, "owner") != 1 {
		t.Fatalf("rows = %d", countTasks(t, db, "owner"))
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", first.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.ID != first.ID {
		t.Fatalf("stored = %+v", stored)
	}
}

func TestSQLiteInactiveAndForeignProjectWriteZeroRows(t *testing.T) {
	svc, db, _ := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "prj-active", "res-1", "video/mp4")
	if err := db.Create(&model.Project{ID: "prj-archived", UserID: "owner", Name: "旧项目", Status: model.ProjectStatusArchived}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Project{ID: "prj-foreign", UserID: "other", Name: "别人的项目", Status: model.ProjectStatusActive}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.CanvasProject{ID: "canvas-foreign", UserID: "other", Title: "别人的画布", Revision: 1}).Error; err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name      string
		projectID string
		want      string
	}{
		{"archived", "prj-archived", TaskScopeArchivedMessage},
		{"foreign-project", "prj-foreign", TaskScopeUnavailableMessage},
		{"foreign-canvas", "canvas-foreign", TaskScopeUnavailableMessage},
		{"missing", "missing-project", TaskScopeUnavailableMessage},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			_, err := svc.CreateTimelineTranscriptionTask("owner", TimelineTranscriptionCreateRequest{
				ResourceID: "res-1", ProjectID: item.projectID, ClientOperationID: "timeline:" + item.name,
			})
			var appErr *kernel.AppError
			if err == nil || err.Error() != item.want {
				t.Fatalf("err = %v, want %q", err, item.want)
			}
			if !errors.As(err, &appErr) || appErr.Status != 400 {
				t.Fatalf("status = %v", err)
			}
			if countTasks(t, db, "") != 0 {
				t.Fatalf("rejected scope persisted rows")
			}
		})
	}
}

func TestSQLiteForeignOwnerCannotReuseClientOperation(t *testing.T) {
	svc, db, _ := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "prj-owner", "res-owner", "video/mp4")
	seedSQLiteUser(t, db, "intruder", "prj-intruder", "res-intruder", "video/mp4")
	created, err := svc.CreateDepthCaptureTask("owner", DepthCaptureCreateRequest{
		ProjectID: "prj-owner", ResourceID: "res-owner", ClientOperationID: "depth:shared-key", NodeID: " node-depth ",
	})
	if err != nil {
		t.Fatal(err)
	}
	stored, err := repository.New(db).Task(created.ID)
	if err != nil || TargetBindingFromInput(stored.InputJSON).NodeID != "node-depth" || TargetBindingFromInput(stored.InputJSON).Source != "canvas" {
		t.Fatalf("depth binding not persisted: %#v %v", stored, err)
	}
	intruder, err := svc.CreateDepthCaptureTask("intruder", DepthCaptureCreateRequest{
		ProjectID: "prj-intruder", ResourceID: "res-intruder", ClientOperationID: "depth:shared-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	if intruder.ID == created.ID {
		t.Fatal("foreign caller reused another owner's client operation")
	}
	if countTasks(t, db, "owner") != 1 || countTasks(t, db, "intruder") != 1 {
		t.Fatalf("owner=%d intruder=%d", countTasks(t, db, "owner"), countTasks(t, db, "intruder"))
	}
}

func TestSQLiteDrainRejectsNewAndReplaysExisting(t *testing.T) {
	svc, db, runtime := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "prj-1", "res-1", "video/mp4")
	created, err := svc.CreateTimelineRenderTask("owner", TimelineRenderCreateRequest{
		ProjectID: "prj-1", Timeline: renderableTimeline("resource:res-1"), ClientOperationID: "timeline:drain-sql",
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime.draining.Store(true)
	replay, err := svc.CreateTimelineRenderTask("owner", TimelineRenderCreateRequest{
		ProjectID: "prj-1", Timeline: renderableTimeline("resource:res-1"), ClientOperationID: "timeline:drain-sql",
	})
	if err != nil || replay.ID != created.ID {
		t.Fatalf("drain replay = %+v err=%v", replay, err)
	}
	_, err = svc.CreateTimelineTranscriptionTask("owner", TimelineTranscriptionCreateRequest{ResourceID: "res-1", ProjectID: "prj-1"})
	if !isStatus(err, 503) {
		t.Fatalf("drain create = %v", err)
	}
	if countTasks(t, db, "owner") != 1 {
		t.Fatalf("drain rows = %d", countTasks(t, db, "owner"))
	}
}

func TestSQLiteUnknownResourceDoesNotInsert(t *testing.T) {
	svc, db, _ := specializedSQLite(t, nil)
	seedSQLiteUser(t, db, "owner", "prj-1", "", "")
	_, err := svc.CreateTimelineRenderTask("owner", TimelineRenderCreateRequest{
		ProjectID: "prj-1", Timeline: renderableTimeline("resource:res-missing"),
	})
	if err == nil {
		t.Fatal("missing render resource admitted")
	}
	_, err = svc.CreateTimelineTranscriptionTask("owner", TimelineTranscriptionCreateRequest{ResourceID: "res-missing", ProjectID: "prj-1"})
	if err == nil || err.Error() != MissingTranscribableMediaMessage {
		t.Fatalf("missing transcription resource = %v", err)
	}
	if countTasks(t, db, "owner") != 0 {
		t.Fatalf("missing resource rows = %d", countTasks(t, db, "owner"))
	}
}

type sqliteAudioResourcePort struct {
	generation.ResourcePort
	user string
	id   string
	data []byte
}

func (p sqliteAudioResourcePort) Lookup(user, id string) (generation.ResourceInfo, error) {
	if user != p.user || id != p.id {
		return generation.ResourceInfo{}, errors.New("resource not owned")
	}
	return generation.ResourceInfo{
		ID: id, UserID: user, Status: "ready", Kind: "video", MimeType: "video/mp4",
		Size: int64(len(p.data)), Width: 64, Height: 48, DurationMs: 1000,
	}, nil
}

func (p sqliteAudioResourcePort) Open(user, id string) (generation.ResourceInfo, io.ReadCloser, error) {
	info, err := p.Lookup(user, id)
	if err != nil {
		return info, nil, err
	}
	return info, io.NopCloser(bytes.NewReader(p.data)), nil
}

func (p sqliteAudioResourcePort) LocalMode() bool { return true }

func sqliteTestClip(t *testing.T, width, height int, audio bool) []byte {
	t.Helper()
	bin, err := mediatools.ResolveFFmpeg()
	if err != nil {
		t.Skip("native ffmpeg unavailable")
	}
	if _, err := mediatools.ResolveFFprobe(); err != nil {
		t.Skip("native ffprobe unavailable")
	}
	path := filepath.Join(t.TempDir(), "clip.mp4")
	args := []string{"-nostdin", "-v", "error", "-f", "lavfi", "-i", fmt.Sprintf("testsrc2=size=%dx%d:rate=24:duration=1", width, height)}
	if audio {
		args = append(args, "-f", "lavfi", "-i", "sine=frequency=440:duration=1")
	}
	args = append(args, "-c:v", "libx264", "-pix_fmt", "yuv420p")
	if audio {
		args = append(args, "-c:a", "aac", "-shortest")
	}
	args = append(args, path)
	if out, err := exec.Command(bin, args...).CombinedOutput(); err != nil {
		t.Fatalf("fixture ffmpeg: %s %v", out, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestRestoreManagedUpscaleAudioPreservesSubtitleEraseAudio(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	_, db, _ := specializedSQLite(t, nil)
	sourceWithAudio := sqliteTestClip(t, 64, 48, true)
	mutedOutput := sqliteTestClip(t, 64, 48, false)
	inputJSON := `{"mode":"video","config":{"channelId":"beeftv","model":"video-subtitle-erase"},"subtitleErase":{"eraseMethod":"auto","subtitleModel":"standard"},"referenceVideos":[{"storageKey":"resource:source"}]}`
	if err := db.Create(&model.Task{
		ID:        "task-erase-audio",
		UserID:    "owner",
		Type:      "canvas_video",
		Model:     "video-subtitle-erase",
		Status:    model.TaskStatusRunning,
		InputJSON: inputJSON,
	}).Error; err != nil {
		t.Fatal(err)
	}
	bindRuntime := func(ctx context.Context, meta generation.CallMeta) context.Context {
		return generation.WithRuntime(ctx, generation.Runtime{
			Call:      meta,
			Resources: sqliteAudioResourcePort{user: "owner", id: "source", data: sourceWithAudio},
		})
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write(mutedOutput)
	}))
	defer srv.Close()

	repo := repository.New(db)
	deps := DeliveryMediaDeps{
		Repo:             repo,
		DataDir:          t.TempDir(),
		AllowHTTPForTest: true,
		BeginDownload: func(_, _ string, timeout time.Duration) (context.Context, func(error), error) {
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			return ctx, func(error) { cancel() }, nil
		},
		MaxBytes:         func() (int64, error) { return 16 << 20, nil },
		DecryptTaskInput: func(s string) (string, error) { return s, nil },
		DecryptSetting:   func(s string) (string, error) { return s, nil },
		ResolveConfig:    func(c generation.Config) (generation.Config, error) { return c, nil },
		BindRuntime:      bindRuntime,
	}
	kind, restored, mimeType, _, width, height, _, err := DecodeGenerationArtifact(
		deps,
		"owner",
		"task-erase-audio:0",
		"video",
		srv.URL+"/muted-erased.mp4",
		5*time.Second,
	)
	if err != nil {
		t.Fatalf("DecodeGenerationArtifact failed: %v", err)
	}
	if kind != "video" || mimeType != "video/mp4" || width != 64 || height != 48 {
		t.Fatalf("unexpected decoded metadata kind=%q mime=%q %dx%d", kind, mimeType, width, height)
	}
	outPath := filepath.Join(t.TempDir(), "restored.mp4")
	if err := os.WriteFile(outPath, restored, 0o600); err != nil {
		t.Fatal(err)
	}
	facts, err := mediatools.ProbeLocal(context.Background(), outPath)
	if err != nil || !facts.HasAudio || facts.Width != 64 || facts.Height != 48 {
		t.Fatalf("expected restored audio and 64x48 dimensions, got facts=%+v err=%v", facts, err)
	}

	// Verify managed delivery restores audio on .mov while keeping video/quicktime container & .mov filename.
	bin, err := mediatools.ResolveFFmpeg()
	if err == nil {
		srcMovPath := filepath.Join(t.TempDir(), "src-audio.mov")
		if out, mErr := exec.Command(bin, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=24:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-f", "mov", srcMovPath).CombinedOutput(); mErr != nil {
			t.Fatalf("src mov fixture: %s %v", out, mErr)
		}
		srcMovBytes, rErr := os.ReadFile(srcMovPath)
		if rErr != nil {
			t.Fatal(rErr)
		}
		mutedMovPath := filepath.Join(t.TempDir(), "muted.mov")
		if out, mErr := exec.Command(bin, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=24:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mov", mutedMovPath).CombinedOutput(); mErr != nil {
			t.Fatalf("muted mov fixture: %s %v", out, mErr)
		}
		mutedMovBytes, rErr := os.ReadFile(mutedMovPath)
		if rErr != nil {
			t.Fatal(rErr)
		}
		movSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(mutedMovBytes)
		}))
		defer movSrv.Close()
		deps.BindRuntime = func(ctx context.Context, meta generation.CallMeta) context.Context {
			return generation.WithRuntime(ctx, generation.Runtime{
				Call:      meta,
				Resources: sqliteAudioResourcePort{user: "owner", id: "source", data: srcMovBytes},
			})
		}
		gotKind, restoredMov, gotMime, gotFileName, _, _, _, dErr := DecodeGenerationArtifact(
			deps,
			"owner",
			"task-erase-audio:0",
			"video",
			movSrv.URL+"/out.mov",
			5*time.Second,
		)
		if dErr != nil {
			t.Fatalf("DecodeGenerationArtifact(.mov octet-stream with audio restore) failed: %v", dErr)
		}
		if gotKind != "video" || gotMime != "video/quicktime" || gotFileName != "out.mov" {
			t.Fatalf("expected video/quicktime out.mov, got kind=%q mime=%q file=%q", gotKind, gotMime, gotFileName)
		}
		if detected := generation.NormalizedMediaMIMEType("", restoredMov); detected != "video/quicktime" {
			t.Fatalf("expected restored .mov bytes to remain video/quicktime, got %q", detected)
		}
		restoredMovPath := filepath.Join(t.TempDir(), "restored-out.mov")
		if err := os.WriteFile(restoredMovPath, restoredMov, 0o600); err != nil {
			t.Fatal(err)
		}
		movFacts, pErr := mediatools.ProbeLocal(context.Background(), restoredMovPath)
		if pErr != nil || !movFacts.HasVideo || !movFacts.HasAudio {
			t.Fatalf("expected restored .mov to contain both video and audio, got facts=%+v err=%v", movFacts, pErr)
		}

		// Verify mismatched URL extension (.mp4 serving QuickTime .mov bytes) is rewritten to .mov to match normalized MIME.
		mismatchKind, _, mismatchMime, mismatchFileName, _, _, _, mErr := DecodeGenerationArtifact(
			deps,
			"owner",
			"task-erase-audio:0",
			"video",
			movSrv.URL+"/mislabeled.mp4",
			5*time.Second,
		)
		if mErr != nil {
			t.Fatalf("DecodeGenerationArtifact(mislabeled.mp4 -> .mov) failed: %v", mErr)
		}
		if mismatchKind != "video" || mismatchMime != "video/quicktime" || mismatchFileName != "mislabeled.mov" {
			t.Fatalf("expected extension rewritten to mislabeled.mov with video/quicktime, got kind=%q mime=%q file=%q", mismatchKind, mismatchMime, mismatchFileName)
		}
	}
}

type fakeClaimedSession struct {
	ctx  context.Context
	task *model.Task
}

func (f fakeClaimedSession) Context() context.Context { return f.ctx }
func (f fakeClaimedSession) Task() *model.Task        { return f.task }
func (f fakeClaimedSession) Lost() bool               { return false }
func (f fakeClaimedSession) LostErr() error           { return nil }

type noopTerminalReplay struct{}

func (noopTerminalReplay) FinalizeTaskTextReplay(string, model.TaskStatus) error { return nil }

type noopTerminalLogger struct{}

func (noopTerminalLogger) Log(string, string, string, string, string) error { return nil }

type noopTerminalOutputs struct{}

func (noopTerminalOutputs) DeliverSucceededTask(model.Task) error       { return nil }
func (noopTerminalOutputs) RegisterTaskOutputFromTask(model.Task) error { return nil }

func TestExecuteClaimedTaskSyncsPersistedStageBeforeFailureDiagnostics(t *testing.T) {
	_, db, _ := specializedSQLite(t, nil)
	repo := repository.New(db)
	now := time.Now()
	leaseExp := now.Add(5 * time.Minute)
	claimed := &model.Task{
		ID:             "task-worker-stage-sync",
		UserID:         "owner",
		Type:           "canvas_video",
		Operation:      "media.video.subtitle_erase",
		Status:         model.TaskStatusRunning,
		LeaseOwner:     "worker-1",
		LeaseExpiresAt: &leaseExp,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := db.Create(claimed).Error; err != nil {
		t.Fatal(err)
	}

	var capturedStage string
	terminal := taskruntime.NewTerminal(taskruntime.TerminalDependencies{
		Repository:        repo,
		Replay:            noopTerminalReplay{},
		Logger:            noopTerminalLogger{},
		Outputs:           noopTerminalOutputs{},
		UserFacingMessage: func(err error) string { return err.Error() },
		FailureErrorCode:  func(error) string { return "async_failed" },
		CaptureFailure: func(task *model.Task, _ error, _ string) {
			capturedStage = task.Stage
			task.FailureDiagnostics = &model.TaskFailureDiagnostics{Source: "upstream_response", Stage: task.Stage}
		},
		LogFailedAttempt: func(model.Task, error) {},
	})

	deps := WorkerExecuteDeps{
		Repo:     repo,
		Terminal: terminal,
		Log:      func(string, string, string, string, string) error { return nil },
		BeginRouteAttempt: func(*model.Task) (*model.RouteAttempt, error) {
			return &model.RouteAttempt{}, nil
		},
		ExecuteRoute: func(_ context.Context, task *model.Task, _ *model.RouteAttempt) (RouteExecutionResult, error) {
			// Simulate managedMediaPort.Project updating persisted stage via its value copy while session.Task() still holds "正在连接上游".
			if err := repo.UpdateTaskStageForLease(task.ID, task.LeaseOwner, "正在消除视频字幕"); err != nil {
				t.Fatalf("update stage: %v", err)
			}
			return RouteExecutionResult{Err: errors.New("upstream failed")}, nil
		},
		DecryptTaskInput:      func(s string) (string, error) { return s, nil },
		ShouldDeferImage:      func(model.Task, error, bool) bool { return false },
		ResolveProviderConfig: func(c generation.Config) (generation.Config, error) { return c, nil },
		ImageTaskEnded:        func(error) bool { return true },
	}

	outcome := ExecuteClaimedTask(deps, fakeClaimedSession{ctx: context.Background(), task: claimed})
	if outcome.Kind != taskruntime.KindFailed {
		t.Fatalf("expected failed outcome, got %+v", outcome)
	}
	if capturedStage != "正在消除视频字幕" {
		t.Fatalf("expected captured failure stage 正在消除视频字幕, got %q", capturedStage)
	}
	stored, err := repo.Task(claimed.ID)
	if err != nil || stored == nil || stored.FailureDiagnostics == nil || stored.FailureDiagnostics.Stage != "正在消除视频字幕" {
		t.Fatalf("expected persisted FailureDiagnostics.Stage 正在消除视频字幕, got %+v (err=%v)", stored, err)
	}
}
