package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

func TestManagedMediaRestartQueriesAndPersistsOriginal(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, kind := range []string{"video", "audio"} {
		for _, failure := range []string{"lost-response", "429"} {
			t.Run(kind+"/"+failure, func(t *testing.T) {
				fixture, mime := "reference-fragmented-30fps.mp4", "video/mp4"
				if kind == "audio" {
					fixture, mime = "managed-audio-fixture.mp3", "audio/mpeg"
				}
				video, err := os.ReadFile("testdata/" + fixture)
				if err != nil {
					t.Fatal(err)
				}
				var posts, queries, models, downloads atomic.Int32
				var ready atomic.Bool
				firstCtx, cancel := context.WithCancel(context.Background())
				defer cancel()
				var taskRef atomic.Value
				var server *httptest.Server
				server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					switch {
					case r.URL.Path == "/result.mp4":
						downloads.Add(1)
						if r.Header.Get("Authorization") != "" {
							t.Error("storage received account credential")
						}
						w.Header().Set("Content-Type", mime)
						_, _ = w.Write(video)
					case r.URL.Path == "/v1/models":
						models.Add(1)
						w.Header().Set(beeftv.MediaProtocolHeader, beeftv.MediaProtocolVersion)
						_ = json.NewEncoder(w).Encode(map[string]any{"media_protocol": beeftv.MediaDiscovery{Version: beeftv.MediaProtocolVersion, SupportedMediaTypes: []string{kind}, TaskSubmitURL: "/v1/media/tasks", TaskQueryURLTemplate: "/v1/media/tasks/{task_ref}", UploadsURL: "/v1/media/uploads"}, "data": []any{map[string]any{"id": "opaque-" + kind + "-2030", "media_capabilities_version": "fixture-v1", "media_capabilities": map[string]any{"audio": beeftv.MediaCapability{Operations: []string{"synthesize"}, Options: []string{"voice", "speed"}, MaxOutputs: 1}}}}})
					case r.Method == http.MethodPost && r.URL.Path == "/v1/media/tasks":
						posts.Add(1)
						var req beeftv.MediaRequest
						if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
							t.Error(err)
						}
						taskRef.Store(req.TaskRef)
						if req.MediaType != kind || req.Model != "opaque-"+kind+"-2030" || req.TaskRef != r.Header.Get("Idempotency-Key") {
							t.Errorf("request = %+v", req)
						}
						if kind == "video" && (req.Operation != "image_to_video" || req.Options["generate_audio"] != false || req.Options["seconds"] != float64(4) || len(req.Input.References) != 1 || req.Input.References[0].Role != "first_frame") {
							t.Errorf("video controls=%+v", req)
						}
						if kind == "audio" && (req.Operation != "synthesize" || req.Options["voice"] != "speaker" || req.Options["speed"] != float64(1) || len(req.Input.References) != 0) {
							t.Errorf("audio controls=%+v", req)
						}
						if failure == "lost-response" {
							conn, _, _ := w.(http.Hijacker).Hijack()
							_ = conn.Close()
							return
						}
						w.WriteHeader(http.StatusTooManyRequests)
					case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/media/tasks/"):
						queries.Add(1)
						if strings.TrimPrefix(r.URL.Path, "/v1/media/tasks/") != taskRef.Load() || r.URL.Query().Get("media_type") != kind {
							t.Error("queried a different identity/type")
						}
						if !ready.Load() {
							http.NotFound(w, r)
							cancel()
							return
						}
						_ = json.NewEncoder(w).Encode(map[string]any{"task_ref": taskRef.Load(), "media_type": kind, "status": "completed", "outputs": []any{map[string]any{"kind": kind, "url": server.URL + "/result.mp4"}}, "billing_state": "settled", "usage_state": "completed"})
					default:
						t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
						http.NotFound(w, r)
					}
				}))
				defer server.Close()
				path, dir := filepath.Join(t.TempDir(), "workspace.db"), t.TempDir()
				svc, db := newManagedImageDirectService(t, path, dir)
				input := generation.Input{Mode: kind, Prompt: "fixture", Config: generation.Config{CredentialRef: beeftv.CredentialRef, MediaProtocolVersion: beeftv.MediaProtocolVersion, APIKey: "fixture", BaseURL: server.URL, Model: "opaque-" + kind + "-2030", InterfaceType: "stale-plugin", VideoSeconds: "4", VideoGenerateAudio: "false", AudioVoice: "speaker", AudioSpeed: "1", AudioFormat: "mp3"}}
				if kind == "video" {
					input.ReferenceImages = []generation.Media{{ID: "frame", URL: "https://93.184.216.34/frame.png"}}
					input.Metadata = map[string]any{"videoStartFrameNodeId": "frame"}
				}
				raw, _ := json.Marshal(input)
				expires := time.Now().Add(time.Hour)
				task := model.Task{ID: "video-original", UserID: "user-1", Type: "canvas_" + kind, Status: model.TaskStatusRunning, InputJSON: string(raw), LeaseOwner: "worker", LeaseExpiresAt: &expires}
				attempt := &model.RouteAttempt{ID: "video-attempt", TaskID: task.ID, ChannelID: beeftv.ChannelID, Status: "dispatching", DispatchState: "submission_unknown", StartedAt: time.Now()}
				for _, row := range []any{&task, attempt} {
					if err := db.Create(row).Error; err != nil {
						t.Fatal(err)
					}
				}
				ctx := generation.WithEndpoints(firstCtx, generation.Endpoints{BeefTVVideoBaseURL: server.URL})
				ctx = svc.bindGenerationRuntime(ctx, generation.CallMeta{UserID: task.UserID, TaskID: task.ID, TaskType: task.Type})
				ctx = context.WithValue(withProviderSubmissionKey(ctx, attempt), imageTaskContext{}, task)
				if _, err := generation.Execute(ctx, input); err == nil || posts.Load() != 1 {
					t.Fatalf("posts=%d err=%v", posts.Load(), err)
				}
				receipt, err := svc.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
				if err != nil || receipt.SendCount != 1 || receipt.QueryCipher == "" {
					t.Fatalf("receipt=%+v err=%v", receipt, err)
				}
				task.Status, task.LeaseOwner, task.LeaseExpiresAt, task.Stage = model.TaskStatusFailed, "", nil, "调用失败"
				attempt.DispatchState = "accepted"
				if err := svc.repo.SaveRouteAttempt(attempt); err != nil {
					t.Fatal(err)
				}
				pending, reserved := "pending", "reserved"
				task.BeefUsageState, task.BeefBillingState = &pending, &reserved
				if err := db.Save(&task).Error; err != nil {
					t.Fatal(err)
				}
				candidates, err := svc.repo.FailedVideosForRecovery("", 8)
				if err != nil || len(candidates) != 1 || candidates[0].ID != task.ID {
					t.Fatalf("modern task without provider ID omitted: %v %d", err, len(candidates))
				}
				closeDB(t, db)
				svc, db = newManagedImageDirectService(t, path, dir)
				defer closeDB(t, db)
				if resumed, err := svc.beginTaskRouteAttempt(&task); err != nil || resumed == nil || resumed.ID != attempt.ID {
					t.Fatalf("resume original attempt = %+v, %v", resumed, err)
				}
				ready.Store(true)
				result, err := svc.QueryFailedVideoTask(generation.WithEndpoints(context.Background(), generation.Endpoints{BeefTVVideoBaseURL: server.URL}), task.UserID, task.ID)
				if err != nil || result == nil || !result.Recovered || posts.Load() != 1 || models.Load() != 1 || downloads.Load() != 1 {
					t.Fatalf("result=%+v err=%v posts/models/queries/downloads=%d/%d/%d/%d", result, err, posts.Load(), models.Load(), queries.Load(), downloads.Load())
				}
				stored, err := svc.repo.Task(task.ID)
				if err != nil || stored.BeefBillingState == nil || *stored.BeefBillingState != "settled" {
					t.Fatalf("task=%+v err=%v", stored, err)
				}
				var resources []model.Resource
				if err := db.Where("user_id = ? AND kind = ?", task.UserID, kind).Find(&resources).Error; err != nil || len(resources) != 1 {
					t.Fatalf("resources=%d err=%v", len(resources), err)
				}
				actual, err := os.ReadFile(filepath.Join(dir, "resources", filepath.FromSlash(resources[0].ObjectKey)))
				if err != nil || !bytes.Equal(actual, video) {
					t.Fatal("persisted video differs from original")
				}
			})
		}
	}
}
