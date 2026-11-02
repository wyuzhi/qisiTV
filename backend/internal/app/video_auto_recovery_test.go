package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

func TestVideoAndUpscaleAutomaticRecoveryDownloadsAndBindsCanvas(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	s, canvasID, revision := newAssistantTurnService(t)
	db := s.repo.DB()
	t.Cleanup(func() { closeDB(t, db) })

	videoBytes, err := os.ReadFile("testdata/reference-fragmented-30fps.mp4")
	if err != nil {
		t.Fatal(err)
	}
	pngBytes, err := base64.StdEncoding.DecodeString(strings.SplitN(tinyPNGDataURL, ",", 2)[1])
	if err != nil {
		t.Fatal(err)
	}

	var getCount, recoverPostCount, createPostCount atomic.Int32
	var upstreamURL string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/v1/media-upscale/tasks/up-req-1/recover" {
			recoverPostCount.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"task_id": "up-req-1"})
			return
		}
		if r.Method != http.MethodGet {
			createPostCount.Add(1)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		getCount.Add(1)
		switch r.URL.Path {
		case "/v1/videos/vid-req-1":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":     "vid-req-1",
				"status": "succeeded",
				"data": map[string]any{
					"id":     "vid-req-1",
					"status": "succeeded",
					"result": map[string]any{
						"video": map[string]any{"url": upstreamURL + "/media/video.mp4"},
					},
				},
			})
		case "/media/video.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write(videoBytes)
		case "/v1/media-upscale/tasks/up-req-1":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"task_id":    "up-req-1",
				"model":      "topaz-standard-v2",
				"status":     "completed",
				"media_type": "image",
			})
		case "/v1/media-upscale/tasks/up-req-1/content":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer upstream.Close()
	upstreamURL = upstream.URL

	doc, _ := json.Marshal(map[string]any{
		"id":       canvasID,
		"title":    "视频与超分自动恢复",
		"revision": revision,
		"nodes": []any{
			map[string]any{"id": "node-video", "type": "video", "title": "视频", "position": map[string]any{"x": 0, "y": 0}, "metadata": map[string]any{"taskId": "auto-video-1", "status": "error"}},
			map[string]any{"id": "node-upscale", "type": "image", "title": "超分图片", "position": map[string]any{"x": 200, "y": 0}, "metadata": map[string]any{"taskId": "auto-upscale-1", "status": "error"}},
		},
		"connections": []any{},
	})
	if _, err := s.UpsertUserCanvasProject("local", doc); err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	videoInput, _ := json.Marshal(map[string]any{
		"mode": "video",
		"config": map[string]any{
			"baseUrl":   upstream.URL,
			"apiKey":    "provider-key",
			"apiFormat": "openai",
			"model":     "seedance-2.0-mini",
		},
		"metadata": map[string]any{"source": "canvas", "nodeId": "node-video"},
	})
	upscaleInput, _ := json.Marshal(map[string]any{
		"mode": "image",
		"config": map[string]any{
			"baseUrl":       upstream.URL,
			"apiKey":        "provider-key",
			"interfaceType": "newapi",
			"model":         "topaz-standard-v2",
		},
		"upscale":  map[string]any{"factor": 2},
		"metadata": map[string]any{"source": "canvas", "nodeId": "node-upscale", "operation": "media.upscale.topaz"},
	})

	videoTask := model.Task{
		ID:                "auto-video-1",
		UserID:            "local",
		ProjectID:         canvasID,
		Type:              "canvas_video",
		Model:             "seedance-2.0-mini",
		Status:            model.TaskStatusFailed,
		ProviderRequestID: "vid-req-1",
		RouteRun:          2,
		InputJSON:         string(videoInput),
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	upscaleTask := model.Task{
		ID:                "auto-upscale-1",
		UserID:            "local",
		ProjectID:         canvasID,
		Type:              "canvas_image",
		Model:             "topaz-standard-v2",
		Status:            model.TaskStatusFailed,
		ProviderRequestID: "up-req-1",
		RouteRun:          1,
		InputJSON:         string(upscaleInput),
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := db.Create(&videoTask).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&upscaleTask).Error; err != nil {
		t.Fatal(err)
	}

	beforeVid, err := s.Task("local", videoTask.ID)
	if err != nil || beforeVid.Outcome == nil || beforeVid.Outcome.Phase != "retrievable" || beforeVid.Outcome.Reason != "provider_result_pending" {
		t.Fatalf("video before recovery = %+v err=%v", beforeVid, err)
	}
	beforeUp, err := s.Task("local", upscaleTask.ID)
	if err != nil || beforeUp.Outcome == nil || beforeUp.Outcome.Phase != "retrievable" || beforeUp.Outcome.Reason != "provider_result_pending" {
		t.Fatalf("upscale before recovery = %+v err=%v", beforeUp, err)
	}

	if err := s.recoverFailedVideos(generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: upstream.URL}), 8); err != nil {
		t.Fatalf("recoverFailedVideos error = %v", err)
	}
	if err := s.RecoverIncompleteGenerationDeliveries(0); err != nil {
		t.Fatalf("RecoverIncompleteGenerationDeliveries error = %v", err)
	}

	afterVid, err := s.Task("local", videoTask.ID)
	if err != nil || afterVid.Status != model.TaskStatusSucceeded || afterVid.Outcome == nil || afterVid.Outcome.Phase != "ready" || afterVid.RouteRun != 2 {
		t.Fatalf("video after recovery = %+v outcome=%+v err=%v", afterVid, afterVid.Outcome, err)
	}
	afterUp, err := s.Task("local", upscaleTask.ID)
	if err != nil || afterUp.Status != model.TaskStatusSucceeded || afterUp.Outcome == nil || afterUp.Outcome.Phase != "ready" || afterUp.RouteRun != 1 {
		t.Fatalf("upscale after recovery = %+v outcome=%+v err=%v", afterUp, afterUp.Outcome, err)
	}
	if createPostCount.Load() != 0 || recoverPostCount.Load() != 0 || getCount.Load() == 0 {
		t.Fatalf("expected only GET queries/downloads, got GET=%d recoverPOST=%d createPOST=%d", getCount.Load(), recoverPostCount.Load(), createPostCount.Load())
	}
	var totalTasks int64
	db.Model(&model.Task{}).Count(&totalTasks)
	if totalTasks != 2 {
		t.Fatalf("expected 2 tasks, got %d", totalTasks)
	}
}

func TestVideoAndUpscaleAutomaticRecoveryConclusions(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")

	cases := []struct {
		name           string
		status         string
		httpCode       int
		responseID     string
		providerID     string
		age            time.Duration
		wantOutcome    string
		wantPhase      string
		wantReason     string
		wantRegenerate string
		wantBackoff    bool
	}{
		{
			name:           "upstream-failed",
			status:         "failed",
			httpCode:       http.StatusOK,
			responseID:     "vid-1",
			providerID:     "vid-1",
			wantOutcome:    localtask.RecoveryNoResult,
			wantPhase:      "failed",
			wantReason:     "no_result",
			wantRegenerate: "confirm",
		},
		{
			name:           "upstream-cancelled",
			status:         "cancelled",
			httpCode:       http.StatusOK,
			responseID:     "vid-1",
			providerID:     "vid-1",
			wantOutcome:    localtask.RecoveryNoResult,
			wantPhase:      "failed",
			wantReason:     "no_result",
			wantRegenerate: "confirm",
		},
		{
			name:           "past-retention",
			status:         "processing",
			httpCode:       http.StatusOK,
			responseID:     "vid-1",
			providerID:     "vid-1",
			age:            25 * time.Hour,
			wantOutcome:    localtask.RecoveryUnrecoverable,
			wantPhase:      "failed",
			wantReason:     "result_unrecoverable",
			wantRegenerate: "confirm",
		},
		{
			name:           "missing-receipt",
			status:         "processing",
			httpCode:       http.StatusOK,
			responseID:     "vid-1",
			providerID:     "",
			wantOutcome:    localtask.RecoveryUnrecoverable,
			wantPhase:      "failed",
			wantReason:     "result_unrecoverable",
			wantRegenerate: "confirm",
		},
		{
			name:           "conflicting-id",
			status:         "succeeded",
			httpCode:       http.StatusOK,
			responseID:     "other-task-id",
			providerID:     "vid-1",
			wantOutcome:    localtask.RecoveryUnrecoverable,
			wantPhase:      "failed",
			wantReason:     "result_unrecoverable",
			wantRegenerate: "confirm",
		},
		{
			name:           "still-processing",
			status:         "processing",
			httpCode:       http.StatusOK,
			responseID:     "vid-1",
			providerID:     "vid-1",
			wantOutcome:    "",
			wantPhase:      "retrievable",
			wantReason:     "provider_result_pending",
			wantRegenerate: "blocked",
			wantBackoff:    true,
		},
		{
			name:           "transient-network",
			status:         "processing",
			httpCode:       http.StatusBadGateway,
			responseID:     "vid-1",
			providerID:     "vid-1",
			wantOutcome:    "",
			wantPhase:      "retrievable",
			wantReason:     "provider_result_pending",
			wantRegenerate: "blocked",
			wantBackoff:    true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, canvasID, _ := newAssistantTurnService(t)
			db := s.repo.DB()
			t.Cleanup(func() { closeDB(t, db) })
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.httpCode != http.StatusOK {
					w.WriteHeader(tc.httpCode)
					_, _ = w.Write([]byte(`{"error":{"message":"bad gateway"}}`))
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{
					"id":     tc.responseID,
					"status": tc.status,
					"data": map[string]any{
						"id":     tc.responseID,
						"status": tc.status,
					},
				})
			}))
			defer upstream.Close()

			inputJSON, _ := json.Marshal(map[string]any{
				"mode": "video",
				"config": map[string]any{
					"baseUrl":   upstream.URL,
					"apiKey":    "key",
					"apiFormat": "openai",
					"model":     "seedance-2.0-mini",
				},
			})
			createdAt := time.Now().Add(-tc.age)
			task := model.Task{
				ID:                "vid-" + tc.name,
				UserID:            "local",
				ProjectID:         canvasID,
				Type:              "canvas_video",
				Model:             "seedance-2.0-mini",
				Status:            model.TaskStatusFailed,
				Stage:             "submission_unknown",
				ProviderRequestID: tc.providerID,
				RouteRun:          1,
				InputJSON:         string(inputJSON),
				CreatedAt:         createdAt,
				UpdatedAt:         createdAt,
			}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}

			_ = s.recoverFailedVideos(context.Background(), 8)

			stored, err := s.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			gotOutcome := ""
			if stored.RecoveryOutcome != nil {
				gotOutcome = *stored.RecoveryOutcome
			}
			if gotOutcome != tc.wantOutcome {
				t.Fatalf("RecoveryOutcome = %q, want %q", gotOutcome, tc.wantOutcome)
			}
			if tc.wantBackoff && stored.NextPollAt == nil {
				t.Fatal("expected NextPollAt backoff to be set on pending/transient failure")
			}
			if !tc.wantBackoff && stored.NextPollAt != nil {
				t.Fatalf("expected NextPollAt to be nil on terminal recovery conclusion, got %v", stored.NextPollAt)
			}

			projected, err := s.Task("local", task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if projected.Outcome == nil || projected.Outcome.Phase != tc.wantPhase || projected.Outcome.Reason != tc.wantReason || projected.Outcome.Regenerate != tc.wantRegenerate {
				t.Fatalf("projected Outcome = %+v, want phase=%s reason=%s regenerate=%s", projected.Outcome, tc.wantPhase, tc.wantReason, tc.wantRegenerate)
			}
		})
	}
}

func TestRecoverTaskResetsBackoffAndRecoversAcrossDeliveryImageVideoAndUpscaleWithoutRetry(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	s, canvasID, _ := newAssistantTurnService(t)
	db := s.repo.DB()
	t.Cleanup(func() { closeDB(t, db) })

	pngBytes, _ := base64.StdEncoding.DecodeString(strings.SplitN(tinyPNGDataURL, ",", 2)[1])
	var createPostCount atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/v1/media-upscale/tasks/up-recover-1/recover" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"task_id": "up-recover-1"})
			return
		}
		if r.Method != http.MethodGet {
			createPostCount.Add(1)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		switch r.URL.Path {
		case "/v1/media-upscale/tasks/up-recover-1":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"task_id":    "up-recover-1",
				"model":      "topaz-standard-v2",
				"status":     "completed",
				"media_type": "image",
			})
		case "/v1/media-upscale/tasks/up-recover-1/content", "/out.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer upstream.Close()

	future := time.Now().Add(10 * time.Minute)
	upscaleInput, _ := json.Marshal(map[string]any{
		"mode": "image",
		"config": map[string]any{
			"baseUrl":       upstream.URL,
			"apiKey":        "key",
			"interfaceType": "newapi",
			"model":         "topaz-standard-v2",
		},
		"upscale": map[string]any{"factor": 2},
	})
	upscaleTask := model.Task{
		ID:                "recover-upscale-manual",
		UserID:            "local",
		ProjectID:         canvasID,
		Type:              "canvas_image",
		Model:             "topaz-standard-v2",
		Status:            model.TaskStatusFailed,
		ProviderRequestID: "up-recover-1",
		RouteRun:          1,
		NextPollAt:        &future,
		InputJSON:         string(upscaleInput),
	}
	imageTask := model.Task{
		ID:         "recover-image-manual",
		UserID:     "local",
		ProjectID:  canvasID,
		Type:       "canvas_image",
		Model:      "nanobanana-pro",
		Status:     model.TaskStatusFailed,
		Stage:      "submission_unknown",
		RouteRun:   2,
		NextPollAt: &future,
		InputJSON:  `{"mode":"image"}`,
	}
	deliveryResult, _ := json.Marshal(map[string]any{
		"mode":   "image",
		"images": []any{map[string]any{"url": upstream.URL + "/out.png"}},
	})
	deliveryTask := model.Task{
		ID:         "recover-delivery-manual",
		UserID:     "local",
		ProjectID:  canvasID,
		Type:       "canvas_image",
		Status:     model.TaskStatusSucceeded,
		Stage:      "delivery_paused",
		RouteRun:   1,
		InputJSON:  `{"mode":"image"}`,
		ResultJSON: string(deliveryResult),
	}
	for _, item := range []model.Task{upscaleTask, imageTask, deliveryTask} {
		if err := db.Create(&item).Error; err != nil {
			t.Fatal(err)
		}
	}
	receipt := model.ApiCallLog{
		ID:           "receipt-image-manual",
		UserID:       "local",
		TaskID:       imageTask.ID,
		Capability:   "image",
		RequestKind:  "create",
		Method:       "POST",
		Path:         "/v1/images/generations",
		APIFormat:    "openai",
		Status:       model.ApiCallStatusSucceeded,
		StatusCode:   http.StatusOK,
		ResponseBody: `{"data":[{"url":"` + upstream.URL + `/out.png"}]}`,
	}
	if err := db.Create(&receipt).Error; err != nil {
		t.Fatal(err)
	}

	ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: upstream.URL})
	for _, tc := range []struct {
		id      string
		wantRun int
	}{
		{id: upscaleTask.ID, wantRun: 1},
		{id: imageTask.ID, wantRun: 2},
		{id: deliveryTask.ID, wantRun: 1},
	} {
		got, err := s.RecoverTask(ctx, "local", tc.id)
		if err != nil {
			t.Fatalf("RecoverTask(%s) error = %v", tc.id, err)
		}
		if got.Status != model.TaskStatusSucceeded || got.Outcome == nil || got.Outcome.Phase != "ready" {
			t.Fatalf("RecoverTask(%s) = %+v outcome=%+v", tc.id, got, got.Outcome)
		}
		stored, err := s.repo.Task(tc.id)
		if err != nil || stored.RouteRun != tc.wantRun {
			t.Fatalf("stored(%s) RouteRun=%d want=%d err=%v", tc.id, stored.RouteRun, tc.wantRun, err)
		}
	}
	if createPostCount.Load() != 0 {
		t.Fatalf("expected 0 create POSTs during RecoverTask, got %d", createPostCount.Load())
	}
}

func TestExpiredRunningTaskLeaseIsReclaimedOnRestartAndNeverCancelled(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	past := time.Now().Add(-5 * time.Minute)
	started := time.Now().Add(-10 * time.Minute)
	running := model.Task{
		ID:             "running-expired-lease",
		UserID:         "user",
		ProjectID:      "proj-1",
		Type:           "canvas_video",
		Status:         model.TaskStatusRunning,
		Stage:          "正在等待上游返回",
		LeaseOwner:     "dead-worker-1",
		LeaseExpiresAt: &past,
		StartedAt:      &started,
		RouteRun:       1,
	}
	if err := db.Create(&running).Error; err != nil {
		t.Fatal(err)
	}

	projected, err := s.Task("user", running.ID)
	if err != nil {
		t.Fatal(err)
	}
	if projected.Status != model.TaskStatusRunning || projected.Outcome == nil || projected.Outcome.Phase != "running" || projected.Outcome.Regenerate != "blocked" {
		t.Fatalf("expired running task projected as %+v outcome=%+v", projected, projected.Outcome)
	}

	reclaimed, err := s.repo.ClaimNextTask("live-worker-2", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if reclaimed == nil || reclaimed.ID != running.ID || reclaimed.Status != model.TaskStatusRunning || reclaimed.LeaseOwner != "live-worker-2" || reclaimed.RouteRun != 1 {
		t.Fatalf("expected ClaimNextTask to reclaim expired running task without cancelling, got %+v", reclaimed)
	}
}
