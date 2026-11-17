package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestTaskOutcomeReadEndpointsOnlyAddPublicProjection(t *testing.T) {
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}
	op := "canvas:outcome-receipt"
	conclusion := "unrecoverable"
	task := model.Task{ID: "outcome-task", UserID: owner.ID, ProjectID: "outcome-canvas", Type: "canvas_image", Status: model.TaskStatusFailed, Stage: "submission_unknown", ClientOperationID: &op, RecoveryOutcome: &conclusion, InputJSON: `{"mode":"image","config":{"apiKey":"never-expose"},"metadata":{"nodeId":"n1"}}`}
	if err := h.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/tasks/" + task.ID, "/api/tasks/by-operation/" + op + "?projectId=" + task.ProjectID, "/api/tasks?projectId=" + task.ProjectID} {
		t.Run(path, func(t *testing.T) {
			resp := h.do(t, http.MethodGet, path, nil)
			if resp.Code != 200 {
				t.Fatalf("%d %s", resp.Code, resp.Body.String())
			}
			if strings.Contains(resp.Body.String(), "never-expose") || strings.Contains(resp.Body.String(), "recovery_outcome") {
				t.Fatal("泄露私有事实或凭据")
			}
			var env struct {
				Data json.RawMessage `json:"data"`
			}
			if err := json.Unmarshal(resp.Body.Bytes(), &env); err != nil {
				t.Fatal(err)
			}
			var got model.Task
			if strings.HasPrefix(strings.TrimSpace(string(env.Data)), "[") {
				var items []model.Task
				if err := json.Unmarshal(env.Data, &items); err != nil || len(items) != 1 {
					t.Fatalf("list=%s err=%v", env.Data, err)
				}
				got = items[0]
			} else if err := json.Unmarshal(env.Data, &got); err != nil {
				t.Fatal(err)
			}
			if got.ID != task.ID || got.Status != model.TaskStatusFailed || got.Outcome == nil || got.Outcome.Phase != "failed" || got.Outcome.Regenerate != "confirm" || got.Outcome.Reason != "result_unrecoverable" {
				t.Fatalf("投影=%+v", got)
			}
		})
	}
	stored, err := h.svc.Task(owner.ID, task.ID)
	if err != nil || stored.Status != task.Status {
		t.Fatal("读接口改了任务")
	}
}

func TestTaskRecoverEndpointRecoversAndNeverCreatesOrIncrementsRouteRun(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}

	var queries, creates atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			creates.Add(1)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		queries.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"vid-upstream-1","status":"failed","error":{"message":"upstream failed"}}`))
	}))
	defer upstream.Close()

	future := time.Now().Add(10 * time.Minute)
	inputJSON, _ := json.Marshal(map[string]any{
		"mode": "video",
		"config": map[string]any{
			"baseUrl":   upstream.URL,
			"apiKey":    "secret-key",
			"apiFormat": "openai",
			"model":     "seedance-2.0-mini",
		},
	})
	videoTask := model.Task{
		ID:                "recover-video-endpoint",
		UserID:            owner.ID,
		ProjectID:         "outcome-canvas",
		Type:              "canvas_video",
		Model:             "seedance-2.0-mini",
		Status:            model.TaskStatusFailed,
		ProviderRequestID: "vid-upstream-1",
		RouteRun:          2,
		NextPollAt:        &future,
		InputJSON:         string(inputJSON),
	}
	if err := h.db.Create(&videoTask).Error; err != nil {
		t.Fatal(err)
	}

	resp := h.do(t, http.MethodPost, "/api/tasks/"+videoTask.ID+"/recover", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var env struct {
		Data model.Task `json:"data"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Data.ID != videoTask.ID || env.Data.Outcome == nil || env.Data.Outcome.Phase != "failed" || env.Data.Outcome.Reason != "no_result" {
		t.Fatalf("unexpected recover outcome: %+v outcome=%+v", env.Data, env.Data.Outcome)
	}
	var storedVideo model.Task
	if err := h.db.First(&storedVideo, "id = ?", videoTask.ID).Error; err != nil || storedVideo.RouteRun != 2 {
		t.Fatalf("stored video RouteRun=%d err=%v", storedVideo.RouteRun, err)
	}
	if queries.Load() != 1 || creates.Load() != 0 {
		t.Fatalf("queries=%d creates=%d", queries.Load(), creates.Load())
	}
	var totalTasks int64
	h.db.Model(&model.Task{}).Count(&totalTasks)
	if totalTasks != 1 {
		t.Fatalf("expected 1 task in DB, got %d", totalTasks)
	}
}

func TestActiveOnlyTasksEndpointIncludesOutcomeActiveTasksBeyondFirstPage(t *testing.T) {
	h := newRetiredAgentHarness(t)
	owner, err := h.svc.WorkspaceOwner("local")
	if err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	unrecoverable := "unrecoverable"
	seed := []model.Task{
		{
			ID:         "old-succeeded-retrievable",
			UserID:     owner.ID,
			ProjectID:  "active-canvas",
			Type:       "canvas_image",
			Status:     model.TaskStatusSucceeded,
			Stage:      "delivery_paused",
			ResultJSON: `{"images":[{"url":"https://example.invalid/img.png"}]}`,
			CreatedAt:  base,
			UpdatedAt:  base,
		},
		{
			ID:                "old-failed-retrievable",
			UserID:            owner.ID,
			ProjectID:         "active-canvas",
			Type:              "canvas_video",
			Status:            model.TaskStatusFailed,
			Stage:             "任务失败",
			ProviderRequestID: "synthetic-upstream-video-1",
			CreatedAt:         base.Add(time.Second),
			UpdatedAt:         base.Add(time.Second),
		},
		{
			ID:        "old-failed-log-retrievable",
			UserID:    owner.ID,
			ProjectID: "active-canvas",
			Type:      "canvas_video",
			Status:    model.TaskStatusFailed,
			Stage:     "任务失败",
			CreatedAt: base.Add(1500 * time.Millisecond),
			UpdatedAt: base.Add(1500 * time.Millisecond),
		},
		{
			ID:        "old-cancelled-log-retrievable",
			UserID:    owner.ID,
			ProjectID: "active-canvas",
			Type:      "canvas_video",
			Status:    model.TaskStatusCancelled,
			Stage:     "任务已取消",
			CreatedAt: base.Add(1800 * time.Millisecond),
			UpdatedAt: base.Add(1800 * time.Millisecond),
		},
		{
			ID:        "old-cancelled-plain",
			UserID:    owner.ID,
			ProjectID: "active-canvas",
			Type:      "canvas_video",
			Status:    model.TaskStatusCancelled,
			Stage:     "任务已取消",
			CreatedAt: base.Add(1900 * time.Millisecond),
			UpdatedAt: base.Add(1900 * time.Millisecond),
		},
		{
			ID:              "old-failed-terminal",
			UserID:          owner.ID,
			ProjectID:       "active-canvas",
			Type:            "canvas_image",
			Status:          model.TaskStatusFailed,
			Stage:           "任务失败",
			RecoveryOutcome: &unrecoverable,
			CreatedAt:       base.Add(2 * time.Second),
			UpdatedAt:       base.Add(2 * time.Second),
		},
		{
			ID:        "old-running",
			UserID:    owner.ID,
			ProjectID: "active-canvas",
			Type:      "canvas_image",
			Status:    model.TaskStatusRunning,
			Stage:     "生成中",
			CreatedAt: base.Add(3 * time.Second),
			UpdatedAt: base.Add(3 * time.Second),
		},
	}
	var readyResults []model.Result
	for i := 0; i < 60; i++ {
		stamp := base.Add(time.Duration(10+i) * time.Second)
		taskID := fmt.Sprintf("ready-img-%d", i)
		seed = append(seed, model.Task{
			ID:         taskID,
			UserID:     owner.ID,
			ProjectID:  "active-canvas",
			Type:       "canvas_image",
			Status:     model.TaskStatusSucceeded,
			Stage:      "生成完成",
			ResultJSON: `{"images":[{"url":"https://example.invalid/ready.png"}]}`,
			CreatedAt:  stamp,
			UpdatedAt:  stamp,
		})
		readyResults = append(readyResults, model.Result{
			ID:        fmt.Sprintf("res-img-%d", i),
			UserID:    owner.ID,
			TaskID:    taskID,
			Kind:      "generation_output",
			Payload:   `{"outputIndex":0,"mediaType":"image","providerArtifactRef":"https://example.invalid/ready.png","materializedAssetId":"asset-ready-1"}`,
			CreatedAt: stamp,
		})
	}
	for i := 0; i < 2045; i++ {
		stamp := base.Add(time.Duration(100+i) * time.Second)
		seed = append(seed, model.Task{
			ID:        fmt.Sprintf("plain-fail-%d", i),
			UserID:    owner.ID,
			ProjectID: "active-canvas",
			Type:      "canvas_video",
			Status:    model.TaskStatusFailed,
			Stage:     "任务失败",
			CreatedAt: stamp,
			UpdatedAt: stamp,
		})
	}
	for i := 0; i < 5; i++ {
		stamp := base.Add(time.Duration(3000+i) * time.Second)
		seed = append(seed, model.Task{
			ID:         fmt.Sprintf("ready-text-%d", i),
			UserID:     owner.ID,
			ProjectID:  "active-canvas",
			Type:       "canvas_text",
			Status:     model.TaskStatusSucceeded,
			Stage:      "已完成",
			ResultJSON: `{"text":"done"}`,
			CreatedAt:  stamp,
			UpdatedAt:  stamp,
		})
	}
	if err := h.db.CreateInBatches(&seed, 100).Error; err != nil {
		t.Fatal(err)
	}
	if err := h.db.CreateInBatches(&readyResults, 100).Error; err != nil {
		t.Fatal(err)
	}
	logs := []model.ApiCallLog{
		{
			ID:                "log-old-failed-retrievable",
			UserID:            owner.ID,
			TaskID:            "old-failed-log-retrievable",
			Capability:        "video",
			RequestKind:       "create",
			Method:            http.MethodPost,
			Status:            model.ApiCallStatusSucceeded,
			ProviderRequestID: "synthetic-upstream-video-2",
			CreatedAt:         base.Add(1500 * time.Millisecond),
		},
		{
			ID:                "log-old-cancelled-retrievable",
			UserID:            owner.ID,
			TaskID:            "old-cancelled-log-retrievable",
			Capability:        "video",
			RequestKind:       "create",
			Method:            http.MethodPost,
			Status:            model.ApiCallStatusSucceeded,
			ProviderRequestID: "synthetic-upstream-video-3",
			CreatedAt:         base.Add(1800 * time.Millisecond),
		},
	}
	if err := h.db.Create(&logs).Error; err != nil {
		t.Fatal(err)
	}

	resp := h.do(t, http.MethodGet, "/api/tasks?projectId=active-canvas&pageSize=100&activeOnly=true", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var env struct {
		Data []model.Task `json:"data"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	gotIDs := make([]string, 0, len(env.Data))
	for _, item := range env.Data {
		gotIDs = append(gotIDs, item.ID)
	}
	wantIDs := []string{"old-running", "old-cancelled-log-retrievable", "old-failed-log-retrievable", "old-failed-retrievable", "old-succeeded-retrievable"}
	if strings.Join(gotIDs, ",") != strings.Join(wantIDs, ",") {
		t.Fatalf("activeOnly ids=%v, want %v", gotIDs, wantIDs)
	}
}
