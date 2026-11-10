package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	beefapi "infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/operations"
)

type managedVideoCapabilityCounter struct {
	appConfigPort
	calls atomic.Int32
}

func (p *managedVideoCapabilityCounter) ApplyCapabilities(ctx context.Context, input *generation.Input) error {
	p.calls.Add(1)
	return p.appConfigPort.ApplyCapabilities(ctx, input)
}

func TestAssistantManagedVideoRestoresCapabilitiesBeforeEnvelope(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, direct := range []bool{false, true} {
		for _, supported := range []bool{false, true} {
			t.Run(fmt.Sprintf("direct=%v/audio=%v", direct, supported), func(t *testing.T) {
				var posts, queries atomic.Int32
				const modelName = "opaque-catalog-video"
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					switch {
					case r.URL.Path == "/v1/models":
						w.Header().Set(beefapi.MediaProtocolHeader, beefapi.MediaProtocolVersion)
						_ = json.NewEncoder(w).Encode(map[string]any{"media_protocol": beefapi.MediaDiscovery{Version: beefapi.MediaProtocolVersion, SupportedMediaTypes: []string{"video"}, TaskSubmitURL: "/v1/media/tasks", TaskQueryURLTemplate: "/v1/media/tasks/{task_ref}", UploadsURL: "/v1/media/uploads"}, "data": []any{map[string]any{"id": modelName}}})
					case r.Method == http.MethodPost && r.URL.Path == "/v1/media/tasks":
						posts.Add(1)
						var request beefapi.MediaRequest
						if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
							t.Error(err)
						}
						audio, present := request.Options["generate_audio"]
						if present != supported || (present && audio != false) {
							t.Errorf("catalog audio supported=%v, envelope generate_audio=%v present=%v", supported, audio, present)
						}
						if request.Model != modelName || request.Operation != "text_to_video" || request.Options["seconds"] != float64(5) || request.Options["aspect_ratio"] != "16:9" || request.Options["resolution"] != "480p" || len(request.Input.References) != 0 {
							t.Errorf("confirmed video settings changed: %+v", request)
						}
						_ = json.NewEncoder(w).Encode(beefapi.MediaTask{TaskRef: request.TaskRef, MediaType: "video", Status: "failed", Error: &beefapi.MediaTaskError{Code: "fixture_rejected", Message: "fixture stops before generation"}})
					case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/media/tasks/"):
						queries.Add(1)
						_ = json.NewEncoder(w).Encode(beefapi.MediaTask{TaskRef: strings.TrimPrefix(r.URL.Path, "/v1/media/tasks/"), MediaType: "video", Status: "failed", Error: &beefapi.MediaTaskError{Code: "fixture_rejected", Message: "fixture stops before generation"}})
					default:
						t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
						http.NotFound(w, r)
					}
				}))
				defer server.Close()
				svc, db, _, _ := creationTestService(t)
				defer closeDB(t, db)
				capability := modelcatalog.DefaultModelCapabilityConfigForModel("openai-videos", modelName)
				capability.Video.Ratios = []string{"16:9"}
				capability.Video.DefaultRatio = "16:9"
				capability.Video.Resolutions = []string{"480p"}
				capability.Video.DefaultResolution = "480p"
				capability.Video.GenerateAudio = modelcatalog.VideoBooleanConfig{Supported: supported, Default: true}
				body, _ := json.Marshal(map[string]any{"channels": []any{map[string]any{"id": beefapi.ChannelID, "baseUrl": server.URL, "apiKey": "synthetic-test-key", "credentialRef": beefapi.CredentialRef, "models": []string{modelName}, "modelProfiles": []any{map[string]any{"model": modelName, "capability": "video", "protocol": "openai-videos", "videoCapabilitiesVersion": "server-fixture-v1", "capabilityConfig": capability}}}}})
				if err := svc.SaveLocalModelConfig(body); err != nil {
					t.Fatal(err)
				}
				config, err := svc.assistantGenerationConfig(operations.GenerationTarget{Kind: "video", ModelKey: beefapi.ChannelID + "::" + modelName, Parameters: map[string]string{"size": "16:9", "vquality": "480p", "seconds": "5", "generateAudio": "false"}})
				if err != nil {
					t.Fatal(err)
				}
				created, err := svc.CreateTask("user", CreateTaskRequest{Type: "canvas_video", Prompt: "fixture", Model: modelName, Input: map[string]any{"mode": "video", "prompt": "fixture", "config": config}})
				if err != nil {
					t.Fatal(err)
				}
				stored, err := svc.repo.Task(created.ID)
				if err != nil {
					t.Fatal(err)
				}
				var input generation.Input
				if err := json.Unmarshal([]byte(stored.InputJSON), &input); err != nil {
					t.Fatal(err)
				}
				if input.VideoCapability != nil || input.Config.VideoCapabilitiesVersion == nil || input.Config.CapabilityConfig == nil || input.Config.CapabilityConfig.Video.GenerateAudio.Supported != supported {
					t.Fatalf("admission did not persist the authoritative capability for worker restoration: ref=%q version=%v capability=%+v resolved=%+v", input.Config.CredentialRef, input.Config.VideoCapabilitiesVersion, input.Config.CapabilityConfig, input.VideoCapability)
				}
				// Managed admission canonicalizes the account origin. Only dispatch to this local fixture.
				input.Config.BaseURL = server.URL
				expires := time.Now().Add(time.Hour)
				stored.Status, stored.LeaseOwner, stored.LeaseExpiresAt = model.TaskStatusRunning, "worker", &expires
				if err := db.Save(stored).Error; err != nil {
					t.Fatal(err)
				}
				attempt := &model.RouteAttempt{ID: "video-capability-attempt", TaskID: stored.ID, ChannelID: beefapi.ChannelID, DispatchState: "submission_unknown", StartedAt: time.Now()}
				if err := db.Create(attempt).Error; err != nil {
					t.Fatal(err)
				}
				ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefTVVideoBaseURL: server.URL})
				ctx = svc.bindGenerationRuntime(ctx, generation.CallMeta{UserID: stored.UserID, TaskID: stored.ID, TaskType: stored.Type})
				ctx = context.WithValue(withProviderSubmissionKey(ctx, attempt), imageTaskContext{}, *stored)
				runtime, _ := generation.RuntimeFromContext(ctx)
				counter := &managedVideoCapabilityCounter{appConfigPort: appConfigPort{service: svc}}
				runtime.Config = counter
				ctx = generation.WithRuntime(ctx, runtime)
				for run := 0; run < 2; run++ {
					var err error
					if direct {
						_, err = generation.RunVideoTaskWithPolicy(ctx, input, generation.DefaultVideoPollPolicy())
					} else {
						_, err = generation.Execute(ctx, input)
					}
					var rejection *beefapi.MediaTaskError
					if !errors.As(err, &rejection) || rejection.Code != "fixture_rejected" {
						t.Fatalf("run %d did not reach the local fixture: %v", run, err)
					}
					// Once sent, recovery must use the frozen request without reading a new catalog.
					if err := svc.SaveLocalModelConfig([]byte(`{"channels":[]}`)); err != nil {
						t.Fatal(err)
					}
				}
				if posts.Load() != 1 || queries.Load() != 1 || counter.calls.Load() != 1 {
					t.Fatalf("posts=%d queries=%d capability resolutions=%d, want 1 each", posts.Load(), queries.Load(), counter.calls.Load())
				}
			})
		}
	}
}
