package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"qisitv/backend/internal/model"
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
