package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
)

func TestSeedreamPluginRunsThroughTaskRoute(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, size := range []string{"2K", "4K"} {
		t.Run(size, func(t *testing.T) {
			svc, db, _, _ := creationTestService(t)
			svc.coordinator = platform.NewLocalCoordinator()
			var posts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/v1/images/generations" {
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
				}
				posts.Add(1)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII="}]}`))
			}))
			t.Cleanup(server.Close)
			input, _ := json.Marshal(map[string]any{"mode": "image", "prompt": "fixture", "config": map[string]any{
				"baseUrl": server.URL, "apiKey": "synthetic", "model": "doubao-seedream-5-0-pro-260628", "interfaceType": "volcengine-ark-image", "size": size,
			}})
			expires := time.Now().Add(time.Hour)
			task := model.Task{ID: "seedream-route", UserID: "user", Type: "canvas_image", Status: model.TaskStatusRunning, Attempts: 1, InputJSON: string(input), LeaseOwner: "owner", LeaseExpiresAt: &expires}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			attempt, err := svc.beginTaskRouteAttempt(&task)
			if err != nil {
				t.Fatal(err)
			}
			result, err := svc.routeExecutor().execute(context.Background(), &task, attempt)
			if err != nil {
				t.Fatal(err)
			}
			if size == "4K" {
				stored, err := svc.repo.LatestRouteAttempt(task.ID)
				if err != nil || posts.Load() != 0 || result.err == nil || stored.FailureCode != "request_not_sent" || stored.DispatchState != "rejected_no_job" {
					t.Fatalf("invalid request: posts=%d result=%v attempt=%+v err=%v", posts.Load(), result.err, stored, err)
				}
				return
			}
			if result.err != nil || posts.Load() != 1 || result.result["mode"] != "image" {
				t.Fatalf("posts=%d result=%#v err=%v", posts.Load(), result.result, result.err)
			}
		})
	}
}

func TestSeedreamPluginUsedByAdminModelTest(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	svc, db, _, _ := creationTestService(t)
	svc.coordinator = platform.NewLocalCoordinator()
	var posts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/v1/images/generations" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["model"] != "doubao-seedream-5-0-pro-260628" || body["response_format"] != "url" {
			t.Errorf("body=%#v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII="}]}`))
	}))
	t.Cleanup(server.Close)
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	channel := model.ModelChannel{ID: "ark", UserID: admin.ID, Scope: model.ChannelScopeSystem, Enabled: true, Name: "Ark", BaseURL: server.URL, APIKey: "synthetic", APIFormat: "openai", ModelsJSON: `[]`}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	profile := DefaultModelCapabilityConfigForModel("openai-image", "fixture")
	profile.Image.Size.Values = []string{"2K"}
	profile.Image.Size.Default = "2K"
	_, err := svc.TestAdminChannelModel(context.Background(), admin, channel.ID, ChannelModelRequest{
		ModelKey: "doubao-seedream-5-0-pro-260628", ProviderModelKey: "doubao-seedream-5-0-pro-260628", Capability: "image", Protocol: "volcengine-ark-image",
		CapabilityConfig: profile,
	})
	if err != nil || posts.Load() != 1 {
		t.Fatalf("posts=%d err=%v", posts.Load(), err)
	}
}

func TestYsduiPluginCreateRejectionWithTraceRequestIDKeepsRegenerateAllowed(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, tc := range []struct {
		name       string
		httpStatus int
		respBody   string
	}{
		{
			name:       "http-400-with-trace-request-id",
			httpStatus: http.StatusBadRequest,
			respBody:   `{"error":{"code":"InvalidParameter","message":"The parameter size specified in the request is not valid."},"request_id":"req-trace-synthetic-400"}`,
		},
		{
			name:       "http-200-payload-rejection-with-trace-request-id",
			httpStatus: http.StatusOK,
			respBody:   `{"code":400,"message":"invalid parameter: size","request_id":"req-trace-payload-400"}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, db, _, _ := creationTestService(t)
			svc.coordinator = platform.NewLocalCoordinator()
			var seenBody map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewDecoder(r.Body).Decode(&seenBody)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.httpStatus)
				_, _ = w.Write([]byte(tc.respBody))
			}))
			t.Cleanup(server.Close)

			input, _ := json.Marshal(map[string]any{
				"mode":   "image",
				"prompt": "fixture",
				"config": map[string]any{
					"baseUrl":       server.URL,
					"apiKey":        "synthetic",
					"model":         "doubao-seedream-5-0-pro-260628",
					"interfaceType": "ysdui-image",
					"size":          "16:9",
					"count":         "1",
				},
			})
			expires := time.Now().Add(time.Hour)
			task := model.Task{
				ID:             "ysdui-pro-reject-" + tc.name,
				UserID:         "user",
				Type:           "canvas_image",
				Status:         model.TaskStatusRunning,
				Attempts:       1,
				InputJSON:      string(input),
				LeaseOwner:     "owner",
				LeaseExpiresAt: &expires,
			}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			attempt, err := svc.beginTaskRouteAttempt(&task)
			if err != nil {
				t.Fatal(err)
			}
			result, err := svc.routeExecutor().execute(context.Background(), &task, attempt)
			if err != nil || result.err == nil {
				t.Fatalf("expected generation error, got result=%#v err=%v", result, err)
			}
			if _, exists := seenBody["sequential_image_generation"]; exists {
				t.Fatalf("Seedream 5.0 Pro must not send sequential_image_generation: %#v", seenBody)
			}
			_ = svc.terminalCoordinator().HandleExecutionFailure(&task, result.err, false, false)

			stored, err := svc.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			latestID, _ := svc.repo.LatestProviderRequestIDForTask(task.ID)
			if stored.ProviderRequestID != "" || latestID != "" {
				t.Fatalf("failed create polluted provider_request_id: task=%q latest=%q", stored.ProviderRequestID, latestID)
			}
			storedAttempt, err := svc.repo.LatestRouteAttempt(task.ID)
			if err != nil || storedAttempt.DispatchState != "rejected_no_job" {
				t.Fatalf("dispatch_state = %+v, want rejected_no_job (err=%v)", storedAttempt, err)
			}
			out, err := svc.Task("user", task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if out.Outcome == nil || out.Outcome.Phase != "failed" || out.Outcome.Regenerate == "blocked" {
				t.Fatalf("outcome locked node into retrievable/blocked: %+v", out.Outcome)
			}
			if out.FailureDiagnostics == nil || out.FailureDiagnostics.Source == "" || out.FailureDiagnostics.Source == "unknown" {
				t.Fatalf("expected recorded failureDiagnostics source, got %+v", out.FailureDiagnostics)
			}
		})
	}
}
