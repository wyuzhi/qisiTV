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

	"qisitv/backend/internal/beefapi"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
)

func TestManagedAudioUsesAdvertisedOperationAndPersistsOriginal(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, operation := range []string{"generate", "synthesize", "html", "expired"} {
		t.Run(operation, func(t *testing.T) {
			audio, err := os.ReadFile("testdata/managed-audio-fixture.mp3")
			if err != nil {
				t.Fatal(err)
			}
			selected := operation
			if selected == "html" || selected == "expired" {
				selected = "synthesize"
			}
			var posts, downloads, queries, expired atomic.Int32
			var originalRef atomic.Value
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/v1/models":
					w.Header().Set(beefapi.MediaProtocolHeader, beefapi.MediaProtocolVersion)
					_ = json.NewEncoder(w).Encode(map[string]any{"media_protocol": beefapi.MediaDiscovery{Version: beefapi.MediaProtocolVersion, SupportedMediaTypes: []string{"audio"}, TaskSubmitURL: "/v1/media/tasks", TaskQueryURLTemplate: "/v1/media/tasks/{task_ref}", UploadsURL: "/v1/media/uploads"}, "data": []any{map[string]any{"id": "opaque-audio-2030", "media_capabilities_version": "server-fixture-v1", "media_capabilities": map[string]any{"audio": beefapi.MediaCapability{Operations: []string{selected}, Options: []string{"voice", "speed", "lyrics", "is_instrumental", "lyrics_optimizer"}, MaxOutputs: 1}}}}})
				case r.URL.Path == "/v1/media/tasks":
					posts.Add(1)
					var request beefapi.MediaRequest
					if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
						t.Error(err)
					}
					originalRef.Store(request.TaskRef)
					if r.Method != http.MethodPost || request.MediaType != "audio" || request.Operation != selected || request.Model != "opaque-audio-2030" || request.Input.Prompt != "fixture" || len(request.Input.References) != 0 {
						t.Errorf("request=%+v", request)
					}
					if selected == "synthesize" && (request.Options["voice"] != "speaker" || request.Options["speed"] != 1.0) {
						t.Errorf("speech controls=%#v", request.Options)
					}
					if selected == "generate" && (request.Options["lyrics"] != "test lyrics" || request.Options["is_instrumental"] != false || request.Options["lyrics_optimizer"] != false) {
						t.Errorf("music controls=%#v", request.Options)
					}
					link := server.URL + "/original.mp3"
					if operation == "expired" {
						link = server.URL + "/expired.mp3"
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"task_ref": request.TaskRef, "media_type": "audio", "status": "completed", "outputs": []any{map[string]any{"kind": "audio", "url": link}}, "billing_state": "settled", "usage_state": "completed"})
				case strings.HasPrefix(r.URL.Path, "/v1/media/tasks/"):
					queries.Add(1)
					if r.Method != http.MethodGet || strings.TrimPrefix(r.URL.Path, "/v1/media/tasks/") != originalRef.Load().(string) || r.URL.Query().Get("media_type") != "audio" {
						t.Error("signature refresh changed original task")
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"task_ref": originalRef.Load().(string), "media_type": "audio", "status": "completed", "outputs": []any{map[string]any{"kind": "audio", "url": server.URL + "/original.mp3"}}})
				case r.URL.Path == "/expired.mp3":
					expired.Add(1)
					http.Error(w, "signature expired", http.StatusForbidden)
				case r.URL.Path == "/original.mp3":
					downloads.Add(1)
					if r.Header.Get("Authorization") != "" {
						t.Error("storage received API credential")
					}
					w.Header().Set("Content-Type", "audio/mpeg")
					if operation == "html" {
						_, _ = w.Write([]byte("<html>not audio</html>"))
					} else {
						_, _ = w.Write(audio)
					}
				default:
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			path, dir := filepath.Join(t.TempDir(), "workspace.db"), t.TempDir()
			svc, db := newManagedImageDirectService(t, path, dir)
			defer closeDB(t, db)
			input := generation.Input{Mode: "audio", Prompt: "fixture", Config: generation.Config{CredentialRef: beefapi.CredentialRef, MediaProtocolVersion: beefapi.MediaProtocolVersion, APIKey: "fixture", BaseURL: server.URL, Model: "opaque-audio-2030", InterfaceType: "stale-plugin", AudioVoice: "speaker", AudioSpeed: "1", AudioFormat: "mp3"}, Metadata: map[string]any{"audioLyrics": "test lyrics", "audioIsInstrumental": false, "audioLyricsOptimizer": false}}
			raw, _ := json.Marshal(input)
			expires := time.Now().Add(time.Hour)
			task := model.Task{ID: "audio-original", UserID: "user-1", Type: "canvas_audio", Status: model.TaskStatusRunning, InputJSON: string(raw), LeaseOwner: "worker", LeaseExpiresAt: &expires}
			attempt := &model.RouteAttempt{ID: "audio-attempt", TaskID: task.ID, ChannelID: beefapi.ChannelID, Status: "dispatching", DispatchState: "submission_unknown", StartedAt: time.Now()}
			for _, row := range []any{&task, attempt} {
				if err := db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: server.URL})
			ctx = svc.bindGenerationRuntime(ctx, generation.CallMeta{UserID: task.UserID, TaskID: task.ID, TaskType: task.Type})
			ctx = context.WithValue(withProviderSubmissionKey(ctx, attempt), imageTaskContext{}, task)
			result, err := generation.Execute(ctx, input)
			if err != nil || posts.Load() != 1 || result["mode"] != "audio" {
				t.Fatalf("result=%#v posts=%d err=%v", result, posts.Load(), err)
			}
			stored, err := svc.persistTaskGeneratedMediaResult(task, result)
			if err != nil {
				t.Fatal(err)
			}
			storedJSON, _ := json.Marshal(stored)
			if err := svc.saveTaskCompletionWithinStorageQuota(&task, storedJSON, nil, false); err != nil {
				t.Fatal(err)
			}
			completed, err := svc.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			err = svc.DeliverSucceededTask(*completed)
			if operation == "html" {
				if err == nil {
					t.Fatal("HTML audio was persisted")
				}
				if posts.Load() != 1 {
					t.Fatal("validation resubmitted generation")
				}
				return
			}
			if err != nil || downloads.Load() != 1 {
				t.Fatalf("downloads=%d err=%v", downloads.Load(), err)
			}
			if operation == "expired" && (queries.Load() != 1 || expired.Load() != 1 || posts.Load() != 1) {
				t.Fatalf("expired/query/post=%d/%d/%d", expired.Load(), queries.Load(), posts.Load())
			}
			var resources []model.Resource
			if err := db.Where("user_id = ? AND kind = ?", task.UserID, "audio").Find(&resources).Error; err != nil || len(resources) != 1 {
				t.Fatalf("resources=%d err=%v", len(resources), err)
			}
			resource := resources[0]
			actual, err := os.ReadFile(filepath.Join(dir, "resources", filepath.FromSlash(resource.ObjectKey)))
			if err != nil || !bytes.Equal(actual, audio) || resource.MimeType != "audio/mpeg" {
				t.Fatalf("mime=%s err=%v", resource.MimeType, err)
			}
		})
	}
}

// BeefAPI enables audio on the unified task endpoint separately; until it lists
// audio, a new speech task keeps using the existing speech endpoint.
func TestManagedAudioUsesSpeechEndpointUntilAPIListsAudio(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	audio, err := os.ReadFile("testdata/managed-audio-fixture.mp3")
	if err != nil {
		t.Fatal(err)
	}
	var speech, mediaTasks atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1/models":
			w.Header().Set(beefapi.MediaProtocolHeader, beefapi.MediaProtocolVersion)
			_ = json.NewEncoder(w).Encode(map[string]any{"media_protocol": beefapi.MediaDiscovery{Version: beefapi.MediaProtocolVersion, SupportedMediaTypes: []string{"image", "video"}, TaskSubmitURL: "/v1/media/tasks", TaskQueryURLTemplate: "/v1/media/tasks/{task_ref}", UploadsURL: "/v1/media/uploads"}, "data": []any{}})
		case r.URL.Path == "/v1/audio/speech":
			speech.Add(1)
			w.Header().Set("Content-Type", "audio/mpeg")
			_, _ = w.Write(audio)
		case strings.HasPrefix(r.URL.Path, "/v1/media/"):
			mediaTasks.Add(1)
			http.Error(w, "audio is not enabled", http.StatusBadRequest)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	path, dir := filepath.Join(t.TempDir(), "workspace.db"), t.TempDir()
	svc, db := newManagedImageDirectService(t, path, dir)
	defer closeDB(t, db)
	input := generation.Input{Mode: "audio", Prompt: "秋夜鱼灯映古巷", Config: generation.Config{CredentialRef: beefapi.CredentialRef, MediaProtocolVersion: beefapi.MediaProtocolVersion, APIKey: "fixture", BaseURL: server.URL, Model: "minimax-speech-2.8-turbo", AudioVoice: "speaker", AudioFormat: "mp3"}}
	raw, _ := json.Marshal(input)
	expires := time.Now().Add(time.Hour)
	task := model.Task{ID: "audio-speech", UserID: "user-1", Type: "canvas_audio", Status: model.TaskStatusRunning, InputJSON: string(raw), LeaseOwner: "worker", LeaseExpiresAt: &expires}
	attempt := &model.RouteAttempt{ID: "audio-speech-attempt", TaskID: task.ID, ChannelID: beefapi.ChannelID, Status: "dispatching", DispatchState: "not_sent", StartedAt: time.Now()}
	for _, row := range []any{&task, attempt} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: server.URL})
	ctx = svc.bindGenerationRuntime(ctx, generation.CallMeta{UserID: task.UserID, TaskID: task.ID, TaskType: task.Type})
	ctx = context.WithValue(withProviderSubmissionKey(ctx, attempt), imageTaskContext{}, task)
	result, err := generation.Execute(ctx, input)
	if err != nil || result["mode"] != "audio" || speech.Load() != 1 || mediaTasks.Load() != 0 {
		t.Fatalf("result=%#v err=%v speech=%d mediaTasks=%d", result, err, speech.Load(), mediaTasks.Load())
	}
}
