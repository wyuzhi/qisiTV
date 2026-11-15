package generation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/topaz"
)

func ptrFloat(v float64) *float64 { return &v }

func TestValidateSubtitleEraseInputAndRegion(t *testing.T) {
	validAuto := Input{
		Mode:            "video",
		Config:          Config{Model: SubtitleEraseModelName},
		SubtitleErase:   &SubtitleEraseOptions{EraseMethod: "auto", SubtitleModel: "standard"},
		ReferenceVideos: []Media{{StorageKey: "resource:clip-1"}},
	}
	if err := ValidateSubtitleEraseInput(validAuto); err != nil {
		t.Fatalf("valid auto rejected: %v", err)
	}

	missingRegion := Input{
		Mode:            "video",
		Config:          Config{Model: SubtitleEraseModelName},
		SubtitleErase:   &SubtitleEraseOptions{EraseMethod: "custom", SubtitleModel: "area"},
		ReferenceVideos: []Media{{StorageKey: "resource:clip-1"}},
	}
	if err := ValidateSubtitleEraseInput(missingRegion); err == nil {
		t.Fatal("expected custom without region to fail")
	}

	outOfBounds := Input{
		Mode:   "video",
		Config: Config{Model: SubtitleEraseModelName},
		SubtitleErase: &SubtitleEraseOptions{
			EraseMethod:   "custom",
			SubtitleModel: "area",
			Region:        &SubtitleEraseRegion{X: ptrFloat(0.5), Y: ptrFloat(0.8), Width: ptrFloat(0.7), Height: ptrFloat(0.15)},
		},
		ReferenceVideos: []Media{{StorageKey: "resource:clip-1"}},
	}
	if err := ValidateSubtitleEraseInput(outOfBounds); err == nil {
		t.Fatal("expected out-of-bounds region to fail")
	}

	validCustom := Input{
		Mode:   "video",
		Config: Config{Model: SubtitleEraseModelName},
		SubtitleErase: &SubtitleEraseOptions{
			EraseMethod:   "custom",
			SubtitleModel: "area",
			Region:        &SubtitleEraseRegion{X: ptrFloat(0.1), Y: ptrFloat(0.78), Width: ptrFloat(0.8), Height: ptrFloat(0.16)},
		},
		ReferenceVideos: []Media{{StorageKey: "resource:clip-1"}},
	}
	if err := ValidateSubtitleEraseInput(validCustom); err != nil {
		t.Fatalf("valid custom rejected: %v", err)
	}
}

func TestDynamicUpscaleModesAndSubtitleEraseClient(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var estimateHits, createHits, pollHits, contentHits atomic.Int32
	fakeMP4 := []byte{0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 'm', 'p', '4', '2', 0x00, 0x00, 0x00, 0x00, 'm', 'p', '4', '2', 'i', 's', 'o', 'm'}

	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/media-upscale/capabilities":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"billing": "mps_video_seconds",
				"supported_models": []map[string]any{
					{
						"id":              "vendor-video-real",
						"label":           "通用实拍增强",
						"media_type":      "video",
						"mode":            "precision",
						"billing_mode":    "mps_video_seconds",
						"billing_summary": "按视频时长与输出分辨率计费，多扣自动退回",
					},
					{
						"id":              "vendor-video-restore",
						"label":           "老片画质修复",
						"media_type":      "video",
						"mode":            "precision",
						"billing_mode":    "mps_video_seconds",
						"billing_summary": "按视频时长与输出分辨率计费，多扣自动退回",
					},
				},
				"max_video_seconds": 300,
			})
		case "/v1/video-smart-erase/capabilities", "/v1/video-subtitle-erase/capabilities":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"model":             SubtitleEraseModelName,
				"available":         false,
				"erase_methods":     []string{"auto", "custom"},
				"subtitle_models":   []string{"standard", "area"},
				"max_video_seconds": 600,
				"billing_mode":      "mps_video_seconds",
				"billing_summary":   "保留原视频音轨 · 按实际时长结算，失败或多扣自动退回",
			})
		case "/v1/video-subtitle-erase/estimate":
			estimateHits.Add(1)
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["erase_method"] != "custom" || body["subtitle_model"] != "area" {
				t.Errorf("unexpected estimate body: %+v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"model":                SubtitleEraseModelName,
				"currency":             "CNY",
				"reservation":          0.15,
				"resolution_tier":      "720p",
				"billed_seconds":       6,
				"rate_cny_per_minute":  1.5,
				"billing_mode":         "mps_video_seconds",
				"generation_submitted": false,
			})
		case "/v1/video-subtitle-erase/tasks":
			createHits.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"task_id":    "erase_task_1",
				"model":      SubtitleEraseModelName,
				"status":     "queued",
				"media_type": "video",
			})
		case "/v1/video-subtitle-erase/tasks/erase_task_1":
			pollHits.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"task_id":    "erase_task_1",
				"model":      SubtitleEraseModelName,
				"status":     "completed",
				"media_type": "video",
			})
		case "/v1/video-subtitle-erase/tasks/erase_task_1/content":
			http.Redirect(w, r, srv.URL+"/artifact.mp4", http.StatusFound)
		case "/artifact.mp4":
			contentHits.Add(1)
			if r.Header.Get("Authorization") != "" {
				t.Error("authorization leaked on storage redirect")
			}
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = io.Copy(w, io.LimitReader(bytes.NewReader(fakeMP4), int64(len(fakeMP4))))
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	lookup := func() (string, string, string, string, error) {
		return "test-key", srv.URL, "beeftv", "", nil
	}
	bind := func(ctx context.Context, _ CallMeta) context.Context {
		return WithEndpoints(ctx, Endpoints{BeefTVVideoBaseURL: srv.URL})
	}
	caps := LiveUpscaleCapabilities(context.Background(), lookup, bind)
	if caps["maxVideoDurationMs"] != 300000 {
		t.Fatalf("expected maxVideoDurationMs=300000, got %+v", caps["maxVideoDurationMs"])
	}
	modes := caps["modes"].([]topaz.Mode)
	if len(modes) != 1 {
		t.Fatalf("expected dynamic upstream catalog to omit unconfigured static modes, got %+v", modes)
	}
	if _, staticErr := topaz.ResolveModelID(topaz.Request{ResourceID: "r1", ChannelID: "beeftv", Mode: "precision", Model: "Proteus", Scale: 2}, "video", modes); staticErr == nil {
		t.Fatal("expected withdrawn static model Proteus to be rejected when absent from dynamic catalog")
	}
	emptyFiltered := topaz.ModesFromUpstream([]topaz.UpstreamModel{{ID: "unknown-x", MediaType: "audio", Mode: "unknown"}})
	if len(emptyFiltered) != 0 {
		t.Fatalf("expected invalid upstream items to return empty modes rather than static defaults, got %+v", emptyFiltered)
	}
	if _, err := topaz.ResolveModelID(topaz.Request{ResourceID: "r1", ChannelID: "beeftv", Mode: "precision", Model: "Proteus", Scale: 2}, "video", emptyFiltered); err == nil {
		t.Fatal("expected empty filtered modes to reject static model Proteus")
	}
	resolved, err := topaz.ResolveModelID(topaz.Request{ResourceID: "r1", ChannelID: "beeftv", Mode: "precision", Model: "通用实拍增强", Scale: 2}, "video", modes)
	if err != nil || resolved != "vendor-video-real" {
		t.Fatalf("ResolveModelID got %q, err=%v", resolved, err)
	}
	var videoPrecision *topaz.Mode
	for i := range modes {
		if modes[i].MediaType == "video" && modes[i].Mode == "precision" {
			videoPrecision = &modes[i]
			break
		}
	}
	if videoPrecision == nil || len(videoPrecision.ModelOptions) == 0 || videoPrecision.ModelOptions[0].BillingSummary == "" {
		t.Fatalf("expected billingSummary on dynamic video precision mode: %+v", modes)
	}

	eraseCaps := SubtitleEraseCapabilities(context.Background(), lookup, bind)
	if eraseCaps["available"] != false || eraseCaps["billingSummary"] == "" {
		t.Fatalf("expected available=false and billingSummary from server capabilities, got %+v", eraseCaps)
	}

	ensure := func(_ context.Context, _, id string) (*model.Resource, error) {
		return &model.Resource{ID: id, Kind: "video", MimeType: "video/mp4", Width: 1280, Height: 720, DurationMs: 6000, Status: model.ResourceStatusReady}, nil
	}
	client := &beeftv.MediaClient{BaseURL: srv.URL, APIKey: "test-key", AllowHTTPTest: true}
	est, err := client.EstimateSubtitleErase(context.Background(), beeftv.SubtitleEraseInput{
		Model:           SubtitleEraseModelName,
		EraseMethod:     "custom",
		SubtitleModel:   "area",
		Region:          &beeftv.SubtitleEraseRegion{X: ptrFloat(0.1), Y: ptrFloat(0.8), Width: ptrFloat(0.8), Height: ptrFloat(0.15)},
		Width:           1280,
		Height:          720,
		DurationSeconds: 6,
	})
	if err != nil || est.Reservation != 0.15 || est.ResolutionTier != "720p" || est.RateCNYPerMinute != 1.5 || estimateHits.Load() != 1 {
		t.Fatalf("estimate=%+v err=%v hits=%d", est, err, estimateHits.Load())
	}
	taskID, err := client.CreateSubtitleErase(context.Background(), "idem-1", beeftv.SubtitleEraseInput{
		Model:         SubtitleEraseModelName,
		SourceURL:     srv.URL + "/source.mp4",
		EraseMethod:   "auto",
		SubtitleModel: "standard",
	})
	if err != nil || taskID != "erase_task_1" || createHits.Load() != 1 {
		t.Fatalf("taskID=%q err=%v", taskID, err)
	}
	queried, err := client.QuerySubtitleErase(context.Background(), taskID, SubtitleEraseModelName)
	if err != nil || queried.Status != "completed" || pollHits.Load() != 1 {
		t.Fatalf("queried=%+v err=%v", queried, err)
	}
	bodyBytes, mime, err := client.SubtitleEraseContent(context.Background(), taskID, 10<<20)
	if err != nil || mime != "video/mp4" || len(bodyBytes) != len(fakeMP4) || contentHits.Load() != 1 {
		t.Fatalf("content len=%d mime=%q err=%v", len(bodyBytes), mime, err)
	}
	_, payload, err := BuildVideoSubtitleEraseTaskPayload(context.Background(), "u1", SubtitleEraseRequest{
		ResourceID:        "r1",
		ChannelID:         "beeftv",
		EraseMethod:       "auto",
		SubtitleModel:     "standard",
		ClientOperationID: "op-1",
		NodeID:            "node-1",
	}, ensure, lookup)
	if err != nil || payload["mode"] != "video" {
		t.Fatalf("payload=%+v err=%v", payload, err)
	}
}

func TestRunRecoverCancelSubtitleEraseAndAudioPreservation(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	sourceWithAudio := upscaleClip(t, 64, 48, true)
	mutedOutput := upscaleClip(t, 64, 48, false)
	corruptVideo := []byte{0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 'm', 'p', '4', '2', 0x00, 0x00, 0x00, 0x00, 'm', 'p', '4', '2', 'i', 's', 'o', 'm', 0xff, 0x00}

	var uploads, creates, polls, downloads, cancels atomic.Int32
	var serveCorrupt atomic.Bool
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/media/uploads":
			uploads.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(BeefTVSeedanceUploadSession{
				Ticket:          "erase-ticket",
				UploadURL:       server.URL + "/put",
				UploadMethod:    "PUT",
				RequiredHeaders: map[string]string{"Content-Type": "video/mp4"},
			})
		case "/put":
			data, _ := io.ReadAll(r.Body)
			if !bytes.Equal(data, sourceWithAudio) || r.Header.Get("Authorization") != "" {
				t.Error("upload altered source bytes or leaked auth")
			}
			w.WriteHeader(http.StatusOK)
		case "/v1/media/uploads/complete":
			sum := sha256.Sum256(sourceWithAudio)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(BeefTVSeedanceUploadComplete{
				URL:    server.URL + "/source.mp4",
				Kind:   "video",
				Mime:   "video/mp4",
				Bytes:  int64(len(sourceWithAudio)),
				SHA256: hex.EncodeToString(sum[:]),
			})
		case "/v1/video-subtitle-erase/tasks":
			creates.Add(1)
			if r.Header.Get("Idempotency-Key") != "erase-op-1" {
				t.Errorf("missing idempotency key: %q", r.Header.Get("Idempotency-Key"))
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"task_id":    "erase_task_full",
				"model":      SubtitleEraseModelName,
				"status":     "queued",
				"media_type": "video",
			})
		case "/v1/video-subtitle-erase/tasks/erase_task_full":
			polls.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"task_id":    "erase_task_full",
				"model":      SubtitleEraseModelName,
				"status":     "completed",
				"media_type": "video",
			})
		case "/v1/video-subtitle-erase/tasks/erase_task_full/content":
			downloads.Add(1)
			w.Header().Set("Content-Type", "video/mp4")
			if serveCorrupt.Load() {
				_, _ = w.Write(corruptVideo)
				return
			}
			_, _ = w.Write(mutedOutput)
		case "/v1/video-subtitle-erase/tasks/erase_task_full/cancel":
			cancels.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]any{"task_id": "erase_task_full", "cancellation_requested": true})
		default:
			t.Errorf("unexpected endpoint %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	progress := &upscaleProgressPort{}
	runtime := taskRuntime(func(r *Runtime) {
		r.Endpoints.BeefTVVideoBaseURL = server.URL
		r.Resources = upscaleResources{data: sourceWithAudio, kind: "video"}
		r.ReferenceProgress = progress
		r.Stages = progress
	})
	input := Input{
		Mode:   "video",
		Prompt: "视频去字幕",
		Config: Config{
			BaseURL:       server.URL,
			APIKey:        "synthetic-erase-key",
			Model:         SubtitleEraseModelName,
			InterfaceType: "newapi",
		},
		SubtitleErase:   &SubtitleEraseOptions{EraseMethod: "auto", SubtitleModel: "standard"},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}

	ctx := WithSubmissionKey(WithRuntime(context.Background(), runtime), "erase-op-1")
	result, err := Execute(ctx, input)
	if err != nil {
		t.Fatalf("Execute subtitle erase failed: %v", err)
	}
	if uploads.Load() != 1 || creates.Load() != 1 || downloads.Load() != 1 {
		t.Fatalf("unexpected call counts: uploads=%d creates=%d downloads=%d", uploads.Load(), creates.Load(), downloads.Load())
	}
	video := result["video"].(map[string]any)
	_, outBytes, err := DecodeProviderDataURL(video["dataUrl"].(string))
	if err != nil {
		t.Fatalf("decode output dataUrl: %v", err)
	}
	outPath, _ := upscaleTempFile(t.TempDir(), "erased.mp4", outBytes)
	facts, err := mediatools.ProbeLocal(ctx, outPath)
	if err != nil || !facts.HasAudio || facts.Width != 64 || facts.Height != 48 {
		t.Fatalf("expected restored audio and 64x48 dimensions, got facts=%+v err=%v", facts, err)
	}
	if input.ReferenceVideos[0].StorageKey != "resource:source" {
		t.Fatalf("original ReferenceVideos storageKey mutated: %q", input.ReferenceVideos[0].StorageKey)
	}

	// Recover must query and download without re-uploading or creating another paid task.
	recovered, status, err := RecoverSubtitleEraseResult(WithRuntime(context.Background(), runtime), input, "erase_task_full")
	if err != nil || status != "completed" || recovered == nil {
		t.Fatalf("RecoverSubtitleEraseResult got status=%q err=%v", status, err)
	}
	if uploads.Load() != 1 || creates.Load() != 1 || downloads.Load() != 2 {
		t.Fatalf("recover re-uploaded or re-created task: uploads=%d creates=%d downloads=%d", uploads.Load(), creates.Load(), downloads.Load())
	}

	// Loud failure when source has audio and audio remux fails (never silently deliver muted video).
	serveCorrupt.Store(true)
	_, _, err = RecoverSubtitleEraseResult(WithRuntime(context.Background(), runtime), input, "erase_task_full")
	var dlErr VideoDownloadError
	if err == nil || !errors.As(err, &dlErr) {
		t.Fatalf("expected VideoDownloadError when audio remux fails, got %v", err)
	}

	// Loud failure when source video is unreadable during audio restoration.
	serveCorrupt.Store(false)
	missingRuntime := taskRuntime(func(r *Runtime) {
		r.Endpoints.BeefTVVideoBaseURL = server.URL
		r.Call.UserID = "other-user"
		r.Resources = upscaleResources{data: sourceWithAudio, kind: "video"}
	})
	_, _, err = RecoverSubtitleEraseResult(WithRuntime(context.Background(), missingRuntime), input, "erase_task_full")
	if err == nil || !errors.As(err, &dlErr) {
		t.Fatalf("expected VideoDownloadError when source video cannot be read for audio check, got %v", err)
	}

	if err := CancelSubtitleErase(WithRuntime(context.Background(), runtime), input.Config, "erase_task_full"); err != nil || cancels.Load() != 1 {
		t.Fatalf("CancelSubtitleErase err=%v cancels=%d", err, cancels.Load())
	}
}

func TestManagedEnvelopeSubtitleEraseCancelAndReconcile(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	expectedTaskRef := uuid.NewSHA1(uuid.NameSpaceOID, []byte("t-env-1:att-env-1")).String()

	var cancelHits, queryHits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/video-subtitle-erase/tasks/erase_env_job_1/cancel":
			cancelHits.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]any{"task_id": "erase_env_job_1", "cancellation_requested": true})
		case "/v1/media/tasks/" + expectedTaskRef:
			queryHits.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-BeefTV-Media-Protocol", "managed-media-v1")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"task_ref":   expectedTaskRef,
				"task_id":    "erase_env_job_1",
				"media_type": "video",
				"model":      SubtitleEraseModelName,
				"status":     "failed",
				"error": map[string]any{
					"code":     "cancelled",
					"category": "upstream",
					"message":  "task cancelled",
				},
			})
		default:
			t.Errorf("unexpected endpoint %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "cancel.db")+"?_busy_timeout=5000"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.RouteAttempt{}, &model.ImageSubmission{}); err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)

	inputBytes, _ := json.Marshal(Input{
		Mode:   "video",
		Prompt: "视频去字幕",
		Config: Config{
			BaseURL:       srv.URL,
			APIKey:        "test-key",
			Model:         SubtitleEraseModelName,
			ChannelID:     beeftv.ChannelID,
			InterfaceType: "newapi",
		},
		SubtitleErase:   &SubtitleEraseOptions{EraseMethod: "auto", SubtitleModel: "standard"},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	})
	taskRow := &model.Task{
		ID:         "t-env-1",
		UserID:     "u-env",
		Type:       "canvas_video",
		Model:      SubtitleEraseModelName,
		Status:     model.TaskStatusCancelled,
		RouteRun:   1,
		ImageJobID: "erase_env_job_1",
		InputJSON:  string(inputBytes),
	}
	if err := db.Create(taskRow).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.RouteAttempt{
		ID:            "att-env-1",
		TaskID:        "t-env-1",
		RouteRun:      1,
		AttemptNumber: 1,
		ChannelID:     beeftv.ChannelID,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ImageSubmission{
		AttemptID:   "att-env-1",
		TaskID:      "t-env-1",
		UserID:      "u-env",
		QueryCipher: "retained-query-identity",
	}).Error; err != nil {
		t.Fatal(err)
	}

	bindTaskCtx := func(ctx context.Context, _ model.Task) context.Context {
		return WithRuntime(ctx, Runtime{
			Endpoints: Endpoints{BeefTVVideoBaseURL: srv.URL},
		})
	}
	identity := func(s string) (string, error) { return s, nil }
	resolveCfg := func(cfg Config) (Config, error) { return cfg, nil }

	if err := RequestProviderCancellation(context.Background(), repo, taskRow, nil, identity, resolveCfg, bindTaskCtx, nil); err != nil {
		t.Fatalf("RequestProviderCancellation error: %v", err)
	}
	if cancelHits.Load() != 1 {
		t.Fatalf("expected 1 cancel hit on /v1/video-subtitle-erase/tasks/erase_env_job_1/cancel, got %d", cancelHits.Load())
	}

	var claimed model.Task
	if err := db.First(&claimed, "id = ?", "t-env-1").Error; err != nil {
		t.Fatal(err)
	}
	if err := ReconcileProviderCancellation(context.Background(), repo, &claimed, identity, resolveCfg, bindTaskCtx, nil); err != nil {
		t.Fatalf("ReconcileProviderCancellation error: %v", err)
	}
	if queryHits.Load() != 1 {
		t.Fatalf("expected 1 managed query hit on /v1/media/tasks/%s, got %d", expectedTaskRef, queryHits.Load())
	}
}

func TestSmartEraseModesMovAndSubtitlesMetadata(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	ptrInt64 := func(v int64) *int64 { return &v }
	ptrBool := func(v bool) *bool { return &v }

	edgeTouching := Input{
		Mode:   "video",
		Config: Config{Model: SubtitleEraseModelName},
		SubtitleErase: &SubtitleEraseOptions{
			EraseType:     "subtitle",
			EraseMethod:   "custom",
			SubtitleModel: "area",
			Region:        &SubtitleEraseRegion{X: ptrFloat(0), Y: ptrFloat(0.75), Width: ptrFloat(1.0), Height: ptrFloat(0.25)},
		},
		ReferenceVideos: []Media{{StorageKey: "resource:clip-edge"}},
	}
	if err := ValidateSubtitleEraseInput(edgeTouching); err != nil {
		t.Fatalf("edge-touching full-width box rejected: %v", err)
	}
	clampedPrepared := subtitleEraseInputFromPrepared(edgeTouching)
	if clampedPrepared.Region == nil || *clampedPrepared.Region.X != 0 || *clampedPrepared.Region.Width != 0.9999 || *clampedPrepared.Region.Y != 0.75 || *clampedPrepared.Region.Height != 0.2499 {
		t.Fatalf("expected full-width region clamped to <=0.9999 on wire, got %+v", clampedPrepared.Region)
	}
	wireBody := beeftv.SubtitleEraseBody(clampedPrepared)
	wireRegion, _ := wireBody["region"].(*beeftv.SubtitleEraseRegion)
	if wireRegion == nil || *wireRegion.X+*wireRegion.Width > 0.9999 || *wireRegion.Y+*wireRegion.Height > 0.9999 {
		t.Fatalf("expected outbound body region right/bottom <= 0.9999, got %+v", wireRegion)
	}

	invalidWatermark := Input{
		Mode:          "video",
		Config:        Config{Model: WatermarkEraseModelName},
		SubtitleErase: &SubtitleEraseOptions{EraseType: "watermark"},
	}
	if err := ValidateSubtitleEraseInput(invalidWatermark); err == nil || err.Error() != "视频去水印需要且仅需要一个源视频" {
		t.Fatalf("expected watermark-specific error message, got %v", err)
	}
	if stage := SmartEraseStageForTask("media.video.privacy_protect", SubtitleEraseModelName); stage != "正在进行隐私打码" {
		t.Fatalf("unexpected SmartEraseStageForTask: %q", stage)
	}

	megaAuto := Input{
		Mode:            "video",
		Config:          Config{Model: SubtitleEraseMegaModelName},
		SubtitleErase:   &SubtitleEraseOptions{EraseType: "subtitle", EraseMethod: "auto", SubtitleModel: "mega"},
		ReferenceVideos: []Media{{StorageKey: "resource:clip-mega"}},
	}
	if err := ValidateSubtitleEraseInput(megaAuto); err != nil {
		t.Fatalf("mega auto rejected: %v", err)
	}
	megaWithCustom := megaAuto
	megaWithCustom.SubtitleErase = &SubtitleEraseOptions{
		EraseType:     "subtitle",
		EraseMethod:   "custom",
		SubtitleModel: "mega",
		Region:        &SubtitleEraseRegion{X: ptrFloat(0.1), Y: ptrFloat(0.8), Width: ptrFloat(0.8), Height: ptrFloat(0.15)},
	}
	if err := ValidateSubtitleEraseInput(megaWithCustom); err == nil {
		t.Fatal("expected mega with custom region to fail")
	}

	watermarkInput := Input{
		Mode:   "video",
		Config: Config{Model: WatermarkEraseModelName},
		SubtitleErase: &SubtitleEraseOptions{
			EraseType:      "watermark",
			EraseMethod:    "custom",
			WatermarkModel: "advanced",
			Region:         &SubtitleEraseRegion{X: ptrFloat(0.02), Y: ptrFloat(0.02), Width: ptrFloat(0.2), Height: ptrFloat(0.12)},
		},
		ReferenceVideos: []Media{{StorageKey: "resource:clip-wm"}},
	}
	if err := ValidateSubtitleEraseInput(watermarkInput); err != nil {
		t.Fatalf("watermark custom rejected: %v", err)
	}

	privacyInput := Input{
		Mode:   "video",
		Config: Config{Model: PrivacyProtectModelName},
		SubtitleErase: &SubtitleEraseOptions{
			EraseType:      "privacy",
			PrivacyModel:   "mosaic",
			PrivacyTargets: []string{"face", "plate"},
		},
		ReferenceVideos: []Media{{StorageKey: "resource:clip-priv"}},
	}
	if err := ValidateSubtitleEraseInput(privacyInput); err != nil {
		t.Fatalf("privacy mosaic rejected: %v", err)
	}

	translateEmbed := Input{
		Mode:   "video",
		Config: Config{Model: SubtitleEraseModelName},
		SubtitleErase: &SubtitleEraseOptions{
			EraseType:        "subtitle",
			EraseMethod:      "auto",
			SubtitleModel:    "standard",
			OCRExtract:       true,
			SubtitleLang:     "zh_en",
			SubtitleFormat:   "srt",
			Translate:        true,
			TranslateDstLang: "en",
			SubtitleEmbedID:  ptrInt64(10001),
			UseOriginalPos:   ptrBool(true),
			UseOriginalSize:  ptrBool(false),
		},
		ReferenceVideos: []Media{{StorageKey: "resource:clip-trans"}},
	}
	if err := ValidateSubtitleEraseInput(translateEmbed); err != nil {
		t.Fatalf("translate+embed rejected: %v", err)
	}
	unsupportedLang := translateEmbed
	unsupportedLangCopy := *translateEmbed.SubtitleErase
	unsupportedLangCopy.TranslateDstLang = "zh-TW"
	unsupportedLang.SubtitleErase = &unsupportedLangCopy
	if err := ValidateSubtitleEraseInput(unsupportedLang); err == nil {
		t.Fatal("expected unsupported translateDstLang zh-TW to fail")
	}

	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	bin, err := mediatools.ResolveFFmpeg()
	if err != nil {
		t.Skip("native ffmpeg unavailable")
	}
	if _, err := mediatools.ResolveFFprobe(); err != nil {
		t.Skip("native ffprobe unavailable")
	}
	movPath := filepath.Join(t.TempDir(), "clip.mov")
	if out, err := exec.Command(bin, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=24:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mov", movPath).CombinedOutput(); err != nil {
		t.Fatalf("fixture mov ffmpeg: %s %v", out, err)
	}
	validMOV, err := os.ReadFile(movPath)
	if err != nil {
		t.Fatal(err)
	}
	if gotMime := NormalizedMediaMIMEType("application/octet-stream", validMOV); gotMime != "video/quicktime" {
		t.Fatalf("NormalizedMediaMIMEType(.mov) = %q, want video/quicktime", gotMime)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/video-subtitle-erase/tasks/erase_mov_sub_1":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"task_id":    "erase_mov_sub_1",
				"model":      SubtitleEraseModelName,
				"status":     "completed",
				"media_type": "video",
			})
		case "/v1/video-subtitle-erase/tasks/erase_mov_sub_1/content":
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(validMOV)
		case "/v1/video-subtitle-erase/tasks/erase_mov_sub_1/subtitles":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":              "erase_mov_sub_1",
				"format":          "srt",
				"origin_text":     "1\n00:00:00,000 --> 00:00:02,000\n你好世界\n",
				"translated_text": "1\n00:00:00,000 --> 00:00:02,000\nHello world\n",
				"target_lang":     "en",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	runtime := taskRuntime(func(r *Runtime) {
		r.Endpoints.BeefTVVideoBaseURL = srv.URL
		r.Resources = upscaleResources{data: validMOV, kind: "video"}
	})
	ctx := WithRuntime(context.Background(), runtime)
	queryInput := translateEmbed
	queryInput.Config = Config{BaseURL: srv.URL, APIKey: "k", Model: SubtitleEraseModelName, ChannelID: beeftv.ChannelID}
	queryInput.ReferenceVideos = []Media{{StorageKey: "resource:source"}}

	res, status, err := QuerySubtitleEraseResult(ctx, queryInput, "erase_mov_sub_1")
	if err != nil || status != "completed" {
		t.Fatalf("QuerySubtitleEraseResult err=%v status=%q", err, status)
	}
	videoMap, _ := res["video"].(map[string]any)
	if videoMap["mimeType"] != "video/quicktime" {
		t.Fatalf("expected video/quicktime mimeType, got %#v", videoMap["mimeType"])
	}
	metaMap, _ := res["metadata"].(map[string]any)
	subsMap, _ := metaMap["subtitles"].(map[string]string)
	if subsMap["origin_text"] == "" || subsMap["translated_text"] == "" || subsMap["target_lang"] != "en" {
		t.Fatalf("expected subtitles metadata, got %#v", res["metadata"])
	}

	// Verify /v1/video-smart-erase/capabilities path, sub-option capability guard, legacy fallback, and explicit available=false.
	var smartCapHits, disabledCapHits atomic.Int32
	capSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/video-smart-erase/capabilities":
			smartCapHits.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"available":           true,
				"available_models":    []string{SubtitleEraseModelName, WatermarkEraseModelName, PrivacyProtectModelName},
				"erase_types":         []string{"subtitle", "watermark", "privacy"},
				"erase_methods":       []string{"auto"},
				"subtitle_models":     []string{"standard", "area", "mega"},
				"watermark_models":    []string{"basic"},
				"privacy_models":      []string{"mosaic"},
				"privacy_targets":     []string{"face"},
				"subtitle_langs":      []string{"multi"},
				"subtitle_formats":    []string{"vtt"},
				"translate_dst_langs": []string{"en", "tr", "unknown-code"},
			})
		case "/disabled/v1/video-smart-erase/capabilities":
			disabledCapHits.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"available": false,
				"smart_erase": map[string]any{
					"available_models": []string{SubtitleEraseModelName, WatermarkEraseModelName},
					"erase_types":      []string{"subtitle", "watermark", "privacy"},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer capSrv.Close()

	capLookup := func() (string, string, string, string, error) {
		return "k", capSrv.URL, "beeftv", "", nil
	}
	restrictedCaps := SubtitleEraseCapabilities(context.Background(), capLookup, func(ctx context.Context, _ CallMeta) context.Context {
		return WithEndpoints(ctx, Endpoints{BeefTVVideoBaseURL: capSrv.URL})
	})
	if smartCapHits.Load() != 1 {
		t.Fatalf("expected 1 hit on /v1/video-smart-erase/capabilities, got %d", smartCapHits.Load())
	}
	if restrictedCaps["available"] != true {
		t.Fatalf("expected available=true, got %#v", restrictedCaps)
	}
	gotSubModels, _ := restrictedCaps["subtitleModels"].([]string)
	gotDstLangs, _ := restrictedCaps["translateDstLangs"].([]string)
	if len(gotSubModels) != 2 || gotSubModels[0] != "standard" || gotSubModels[1] != "area" {
		t.Fatalf("expected subtitleModels=[standard area] without mega, got %v", gotSubModels)
	}
	if !slices.Equal(gotDstLangs, []string{"en", "tr"}) {
		t.Fatalf("expected translateDstLangs filtered to protocol-supported [en tr], got %v", gotDstLangs)
	}

	reqMega := SubtitleEraseRequest{EraseType: "subtitle", SubtitleModel: "mega"}
	if err := ValidateSmartEraseRequestCapabilities(&reqMega, restrictedCaps); err == nil {
		t.Fatal("expected mega subtitle request to be rejected when video-subtitle-erase-mega is absent")
	}
	reqCustom := SubtitleEraseRequest{EraseType: "subtitle", SubtitleModel: "standard", EraseMethod: "custom", Region: &SubtitleEraseRegion{X: ptrFloat(0.1), Y: ptrFloat(0.7), Width: ptrFloat(0.8), Height: ptrFloat(0.2)}}
	if err := ValidateSmartEraseRequestCapabilities(&reqCustom, restrictedCaps); err == nil {
		t.Fatal("expected custom eraseMethod to be rejected when capabilities only allow auto")
	}
	reqWmAdv := SubtitleEraseRequest{EraseType: "watermark", WatermarkModel: "advanced"}
	if err := ValidateSmartEraseRequestCapabilities(&reqWmAdv, restrictedCaps); err == nil {
		t.Fatal("expected advanced watermarkModel to be rejected when capabilities only allow basic")
	}
	reqPrivPlate := SubtitleEraseRequest{EraseType: "privacy", PrivacyModel: "mosaic", PrivacyTargets: []string{"face", "plate"}}
	if err := ValidateSmartEraseRequestCapabilities(&reqPrivPlate, restrictedCaps); err == nil {
		t.Fatal("expected plate target to be rejected when capabilities only allow face")
	}
	reqDisallowedLang := SubtitleEraseRequest{EraseType: "subtitle", Translate: true, TranslateDstLang: "ja"}
	if err := ValidateSmartEraseRequestCapabilities(&reqDisallowedLang, restrictedCaps); err == nil {
		t.Fatal("expected translateDstLang=ja to be rejected when capabilities only allow [en tr]")
	}

	reqDefaultWm := SubtitleEraseRequest{EraseType: "watermark"}
	if err := ValidateSmartEraseRequestCapabilities(&reqDefaultWm, restrictedCaps); err != nil || reqDefaultWm.WatermarkModel != "basic" || reqDefaultWm.EraseMethod != "auto" {
		t.Fatalf("expected omitted watermark defaults derived from capabilities, got req=%+v err=%v", reqDefaultWm, err)
	}
	reqDefaultPriv := SubtitleEraseRequest{EraseType: "privacy"}
	if err := ValidateSmartEraseRequestCapabilities(&reqDefaultPriv, restrictedCaps); err != nil || reqDefaultPriv.PrivacyModel != "mosaic" || !slices.Equal(reqDefaultPriv.PrivacyTargets, []string{"face"}) {
		t.Fatalf("expected omitted privacy defaults derived from capabilities, got req=%+v err=%v", reqDefaultPriv, err)
	}
	reqDefaultSub := SubtitleEraseRequest{EraseType: "subtitle", Translate: true}
	if err := ValidateSmartEraseRequestCapabilities(&reqDefaultSub, restrictedCaps); err != nil || reqDefaultSub.SubtitleLang != "multi" || reqDefaultSub.SubtitleFormat != "vtt" || reqDefaultSub.TranslateDstLang != "en" {
		t.Fatalf("expected omitted subtitle defaults derived from capabilities, got req=%+v err=%v", reqDefaultSub, err)
	}

	disabledURL := capSrv.URL + "/disabled"
	disabledCaps := SubtitleEraseCapabilities(context.Background(), func() (string, string, string, string, error) {
		return "k", disabledURL, "beeftv", "", nil
	}, func(ctx context.Context, _ CallMeta) context.Context {
		return WithEndpoints(ctx, Endpoints{BeefTVVideoBaseURL: disabledURL})
	})
	if disabledCapHits.Load() != 1 || disabledCaps["available"] != false {
		t.Fatalf("expected explicit available=false preserved (hits=%d), got %#v", disabledCapHits.Load(), disabledCaps)
	}
	reqOnDisabled := SubtitleEraseRequest{EraseType: "subtitle"}
	if err := ValidateSmartEraseRequestCapabilities(&reqOnDisabled, disabledCaps); err == nil {
		t.Fatal("expected request to fail when capabilities explicitly report available=false")
	}

	// Verify legacy gateway fallback (404 with non-empty polluting JSON body on /v1/video-smart-erase/capabilities -> 200 on /v1/video-subtitle-erase/capabilities with only subtitle_models).
	var legacySmartHits, legacySubHits atomic.Int32
	legacyCapSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/video-smart-erase/capabilities":
			legacySmartHits.Add(1)
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"available":        false,
				"model":            "polluted-404-model",
				"available_models": []string{WatermarkEraseModelName},
				"erase_types":      []string{"watermark"},
			})
		case "/v1/video-subtitle-erase/capabilities":
			legacySubHits.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"subtitle_models": []string{"standard", "area"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer legacyCapSrv.Close()
	legacyCaps := SubtitleEraseCapabilities(context.Background(), func() (string, string, string, string, error) {
		return "k", legacyCapSrv.URL, "beeftv", "", nil
	}, func(ctx context.Context, _ CallMeta) context.Context {
		return WithEndpoints(ctx, Endpoints{BeefTVVideoBaseURL: legacyCapSrv.URL})
	})
	if legacySmartHits.Load() != 1 || legacySubHits.Load() != 1 {
		t.Fatalf("expected fallback from smart-erase (%d) to subtitle-erase (%d)", legacySmartHits.Load(), legacySubHits.Load())
	}
	legacyEraseTypes, _ := legacyCaps["eraseTypes"].([]string)
	if legacyCaps["available"] != true || legacyCaps["model"] != SubtitleEraseModelName || !slices.Equal(legacyEraseTypes, []string{"subtitle"}) {
		t.Fatalf("expected legacy subtitle-only caps unpolluted available=true eraseTypes=[subtitle], got %#v", legacyCaps)
	}
	reqLegacyWatermark := SubtitleEraseRequest{EraseType: "watermark"}
	if err := ValidateSmartEraseRequestCapabilities(&reqLegacyWatermark, legacyCaps); err == nil {
		t.Fatal("expected legacy subtitle-only gateway capabilities to block watermark mode")
	}

	// Verify partial capability responses: availableModels-only (mega-only & base+mega without subtitle_models) and single-list responses (watermark_models / privacy_targets / subtitle_langs).
	partialCapSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/mega-only/v1/video-smart-erase/capabilities":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"available_models": []string{SubtitleEraseMegaModelName},
			})
		case "/base-and-mega/v1/video-smart-erase/capabilities":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"available_models": []string{SubtitleEraseModelName, SubtitleEraseMegaModelName},
			})
		case "/wm-only/v1/video-smart-erase/capabilities":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"watermark_models": []string{"basic"},
			})
		case "/priv-only/v1/video-smart-erase/capabilities":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"privacy_targets": []string{"face"},
			})
		case "/lang-only/v1/video-smart-erase/capabilities":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"subtitle_langs": []string{"multi"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer partialCapSrv.Close()
	fetchPartialCaps := func(prefix string) map[string]any {
		baseURL := partialCapSrv.URL + prefix
		return SubtitleEraseCapabilities(context.Background(), func() (string, string, string, string, error) {
			return "k", baseURL, "beeftv", "", nil
		}, func(ctx context.Context, _ CallMeta) context.Context {
			return WithEndpoints(ctx, Endpoints{BeefTVVideoBaseURL: baseURL})
		})
	}

	megaOnlyCaps := fetchPartialCaps("/mega-only")
	megaOnlySubModels, _ := megaOnlyCaps["subtitleModels"].([]string)
	megaOnlyTypes, _ := megaOnlyCaps["eraseTypes"].([]string)
	if megaOnlyCaps["available"] != true || !slices.Equal(megaOnlyTypes, []string{"subtitle"}) || !slices.Equal(megaOnlySubModels, []string{"mega"}) {
		t.Fatalf("expected mega-only availableModels to derive available=true eraseTypes=[subtitle] subtitleModels=[mega], got %#v", megaOnlyCaps)
	}
	reqExplicitMega := SubtitleEraseRequest{EraseType: "subtitle", SubtitleModel: "mega"}
	if err := ValidateSmartEraseRequestCapabilities(&reqExplicitMega, megaOnlyCaps); err != nil {
		t.Fatalf("expected mega-only caps to accept explicit mega request, got %v", err)
	}
	reqOmittedSubModelOnMega := SubtitleEraseRequest{}
	if err := ValidateSmartEraseRequestCapabilities(&reqOmittedSubModelOnMega, megaOnlyCaps); err != nil || reqOmittedSubModelOnMega.SubtitleModel != "mega" {
		t.Fatalf("expected mega-only caps to default omitted subtitleModel to mega, got req=%+v err=%v", reqOmittedSubModelOnMega, err)
	}
	reqStandardOnMegaOnly := SubtitleEraseRequest{EraseType: "subtitle", SubtitleModel: "standard"}
	if err := ValidateSmartEraseRequestCapabilities(&reqStandardOnMegaOnly, megaOnlyCaps); err == nil {
		t.Fatal("expected mega-only caps to reject standard subtitleModel")
	}

	baseAndMegaCaps := fetchPartialCaps("/base-and-mega")
	baseAndMegaSubModels, _ := baseAndMegaCaps["subtitleModels"].([]string)
	if baseAndMegaCaps["available"] != true || !slices.Equal(baseAndMegaSubModels, []string{"standard", "area", "mega"}) {
		t.Fatalf("expected base+mega availableModels without subtitle_models to expose [standard area mega], got %#v", baseAndMegaCaps)
	}
	if err := ValidateSmartEraseRequestCapabilities(&SubtitleEraseRequest{EraseType: "subtitle", SubtitleModel: "mega"}, baseAndMegaCaps); err != nil {
		t.Fatalf("expected base+mega caps to accept mega, got %v", err)
	}

	wmListOnlyCaps := fetchPartialCaps("/wm-only")
	wmListOnlyTypes, _ := wmListOnlyCaps["eraseTypes"].([]string)
	if wmListOnlyCaps["available"] != true || !slices.Equal(wmListOnlyTypes, []string{"watermark"}) {
		t.Fatalf("expected watermark_models-only response to derive available=true eraseTypes=[watermark], got %#v", wmListOnlyCaps)
	}
	if err := ValidateSmartEraseRequestCapabilities(&SubtitleEraseRequest{EraseType: "watermark"}, wmListOnlyCaps); err != nil {
		t.Fatalf("expected watermark_models-only caps to accept watermark, got %v", err)
	}

	privListOnlyCaps := fetchPartialCaps("/priv-only")
	privListOnlyTypes, _ := privListOnlyCaps["eraseTypes"].([]string)
	if privListOnlyCaps["available"] != true || !slices.Equal(privListOnlyTypes, []string{"privacy"}) {
		t.Fatalf("expected privacy_targets-only response to derive available=true eraseTypes=[privacy], got %#v", privListOnlyCaps)
	}

	langListOnlyCaps := fetchPartialCaps("/lang-only")
	langListOnlyTypes, _ := langListOnlyCaps["eraseTypes"].([]string)
	if langListOnlyCaps["available"] != true || !slices.Equal(langListOnlyTypes, []string{"subtitle"}) {
		t.Fatalf("expected subtitle_langs-only response to derive available=true eraseTypes=[subtitle], got %#v", langListOnlyCaps)
	}

	// Verify omitted eraseType defaults to subtitle (never silently switching a legacy caller to watermark/privacy) and mega requires auto in eraseMethods.
	watermarkOnlyCaps := map[string]any{
		"capabilitiesLoaded": true,
		"available":          true,
		"availableModels":    []string{WatermarkEraseModelName},
		"eraseTypes":         []string{"watermark"},
		"watermarkModels":    []string{"advanced"},
	}
	reqOmittedEraseType := SubtitleEraseRequest{}
	if err := ValidateSmartEraseRequestCapabilities(&reqOmittedEraseType, watermarkOnlyCaps); err == nil || reqOmittedEraseType.EraseType != "subtitle" {
		t.Fatalf("expected omitted eraseType to stay subtitle and be rejected when subtitle is unavailable, got req=%+v err=%v", reqOmittedEraseType, err)
	}

	customOnlyMegaCaps := map[string]any{
		"capabilitiesLoaded": true,
		"available":          true,
		"availableModels":    []string{SubtitleEraseModelName, SubtitleEraseMegaModelName},
		"eraseTypes":         []string{"subtitle"},
		"eraseMethods":       []string{"custom"},
		"subtitleModels":     []string{"standard", "mega"},
	}
	reqMegaCustomOnly := SubtitleEraseRequest{EraseType: "subtitle", SubtitleModel: "mega"}
	if err := ValidateSmartEraseRequestCapabilities(&reqMegaCustomOnly, customOnlyMegaCaps); err == nil {
		t.Fatal("expected mega to be rejected when eraseMethods only allows custom")
	}

	// Consistency invariant: every value in supported* option sets is accepted by normalizeSmartEraseOptions.
	for _, sm := range supportedSubtitleModels {
		for _, m := range supportedEraseMethods {
			if sm == "mega" && m != "auto" {
				continue
			}
			var reg *SubtitleEraseRegion
			if m == "custom" {
				reg = &SubtitleEraseRegion{X: ptrFloat(0.1), Y: ptrFloat(0.7), Width: ptrFloat(0.8), Height: ptrFloat(0.2)}
			}
			if _, err := normalizeSmartEraseOptions(SubtitleEraseOptions{EraseType: "subtitle", SubtitleModel: sm, EraseMethod: m, Region: reg}); err != nil {
				t.Fatalf("supported subtitle option (%s,%s) rejected: %v", sm, m, err)
			}
		}
	}
	for _, lang := range supportedSubtitleLangs {
		for _, fmtName := range supportedSubtitleFormats {
			for _, dst := range supportedSmartEraseTranslateLangs {
				if _, err := normalizeSmartEraseOptions(SubtitleEraseOptions{EraseType: "subtitle", EraseMethod: "auto", SubtitleModel: "standard", OCRExtract: true, SubtitleLang: lang, SubtitleFormat: fmtName, Translate: true, TranslateDstLang: dst}); err != nil {
					t.Fatalf("supported subtitle ocr/translate option (%s,%s,%s) rejected: %v", lang, fmtName, dst, err)
				}
			}
		}
	}
	for _, wm := range supportedWatermarkModels {
		if _, err := normalizeSmartEraseOptions(SubtitleEraseOptions{EraseType: "watermark", EraseMethod: "auto", WatermarkModel: wm}); err != nil {
			t.Fatalf("supported watermark model %s rejected: %v", wm, err)
		}
	}
	for _, pm := range supportedPrivacyModels {
		if _, err := normalizeSmartEraseOptions(SubtitleEraseOptions{EraseType: "privacy", PrivacyModel: pm, PrivacyTargets: supportedPrivacyTargets}); err != nil {
			t.Fatalf("supported privacy option %s rejected: %v", pm, err)
		}
	}

	// Test end-to-end singleMediaResult setting LastTaskID + attachSmartEraseSubtitles for both embedded metadata and /subtitles fallback.
	managedClient := &beeftv.MediaClient{BaseURL: srv.URL, APIKey: "k", AllowHTTPTest: true}
	managedEmbedded, err := managedClient.Result(ctx, beeftv.MediaTask{
		TaskID:    "erase_mov_sub_1",
		MediaType: "video",
		Outputs:   []beeftv.MediaOutput{{Kind: "video", URL: srv.URL + "/out.mov"}},
		Metadata: map[string]any{
			"subtitles": map[string]any{
				"format":          "vtt",
				"origin_text":     "WEBVTT\n\n00:00.000 --> 00:01.000\n你好\n",
				"translated_text": "WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n",
				"target_lang":     "en",
			},
		},
	}, false)
	if err != nil || managedClient.LastTaskID != "erase_mov_sub_1" {
		t.Fatalf("expected singleMediaResult to populate LastTaskID=erase_mov_sub_1, got %q err=%v", managedClient.LastTaskID, err)
	}
	attachSmartEraseSubtitles(ctx, managedClient, queryInput, managedClient.LastTaskID, managedEmbedded)
	embeddedSubs, _ := managedEmbedded["metadata"].(map[string]any)["subtitles"].(map[string]string)
	if embeddedSubs["format"] != "vtt" || embeddedSubs["translated_text"] == "" {
		t.Fatalf("expected embedded managed subtitles normalized, got %#v", managedEmbedded["metadata"])
	}

	fallbackClient := &beeftv.MediaClient{BaseURL: srv.URL, APIKey: "k", AllowHTTPTest: true}
	managedFallback, err := fallbackClient.Result(ctx, beeftv.MediaTask{
		TaskID:    "erase_mov_sub_1",
		MediaType: "video",
		Outputs:   []beeftv.MediaOutput{{Kind: "video", URL: srv.URL + "/out.mov"}},
	}, false)
	if err != nil || fallbackClient.LastTaskID != "erase_mov_sub_1" {
		t.Fatalf("expected fallbackClient.LastTaskID=erase_mov_sub_1, got %q err=%v", fallbackClient.LastTaskID, err)
	}
	attachSmartEraseSubtitles(ctx, fallbackClient, queryInput, fallbackClient.LastTaskID, managedFallback)
	fallbackSubs, _ := managedFallback["metadata"].(map[string]any)["subtitles"].(map[string]string)
	if fallbackSubs["origin_text"] == "" || fallbackSubs["translated_text"] == "" {
		t.Fatalf("expected fallback /subtitles fetch for managed result, got %#v", managedFallback["metadata"])
	}
}
