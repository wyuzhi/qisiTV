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
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"qisitv/backend/internal/beeftv"
	"qisitv/backend/internal/mediatools"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
	"qisitv/backend/internal/topaz"
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
		case "/v1/video-subtitle-erase/capabilities":
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
