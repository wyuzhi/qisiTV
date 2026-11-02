package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"qisitv/backend/internal/beefapi"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/mediatools"
	"qisitv/backend/internal/model"
)

func TestManagedUpscaleOpaqueModelOwnsSingleTicketAndSavedResult(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewNRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	data := encoded.Bytes()
	sum := sha256.Sum256(data)
	var posts, uploads, puts, downloads atomic.Int32
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			w.Header().Set(beefapi.MediaProtocolHeader, beefapi.MediaProtocolVersion)
			_ = json.NewEncoder(w).Encode(map[string]any{"media_protocol": beefapi.MediaDiscovery{Version: beefapi.MediaProtocolVersion, SupportedMediaTypes: []string{"upscale"}, TaskSubmitURL: "/v1/media/tasks", TaskQueryURLTemplate: "/v1/media/tasks/{task_ref}", UploadsURL: "/v1/media/uploads"}, "data": []any{map[string]any{"id": "opaque-upscale-2030", "media_capabilities_version": "fixture-v1", "media_capabilities": map[string]any{"upscale": beefapi.MediaCapability{Operations: []string{"upscale"}, Options: []string{"upscale_factor", "output_format", "face_enhancement"}, ReferenceKinds: []string{"image"}, MaxOutputs: 1}}}}})
		case "/v1/media/uploads":
			uploads.Add(1)
			_ = json.NewEncoder(w).Encode(beefapi.UploadSession{Ticket: "original", UploadURL: server.URL + "/put", UploadMethod: "PUT"})
		case "/put":
			puts.Add(1)
			actual, _ := io.ReadAll(r.Body)
			if r.Header.Get("Authorization") != "" || !bytes.Equal(actual, data) {
				t.Error("source changed or credential leaked")
			}
		case "/v1/media/uploads/complete":
			_ = json.NewEncoder(w).Encode(beefapi.UploadedMedia{URL: server.URL + "/source", Kind: "image", Mime: "image/png", Bytes: int64(len(data)), SHA256: hex.EncodeToString(sum[:])})
		case "/v1/media/tasks":
			posts.Add(1)
			var request beefapi.MediaRequest
			_ = json.NewDecoder(r.Body).Decode(&request)
			if request.MediaType != "upscale" || request.Model != "opaque-upscale-2030" || request.Operation != "upscale" || request.Input.Prompt != "" || len(request.Input.References) != 1 || request.Input.References[0].Role != "source" || request.Input.References[0].URL != server.URL+"/source" || request.Options["upscale_factor"] != float64(2) {
				t.Errorf("request=%+v", request)
			}
			_ = json.NewEncoder(w).Encode(beefapi.MediaTask{TaskRef: request.TaskRef, MediaType: "upscale", Status: "completed", Outputs: []beefapi.MediaOutput{{Kind: "image", URL: server.URL + "/result.png"}}})
		case "/result.png":
			downloads.Add(1)
			if r.Header.Get("Authorization") != "" {
				t.Error("result storage received key")
			}
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(data)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()
	dir := t.TempDir()
	svc, db := newManagedImageDirectService(t, filepath.Join(t.TempDir(), "workspace.db"), dir)
	defer closeDB(t, db)
	source := seedManagedImageLocalResource(t, svc, "source", data)
	input := generation.Input{Mode: "image", Prompt: "AI 超分", Upscale: &generation.UpscaleOptions{Factor: 2}, ReferenceImages: []generation.Media{source}, Config: generation.Config{CredentialRef: beefapi.CredentialRef, MediaProtocolVersion: beefapi.MediaProtocolVersion, BaseURL: server.URL, APIKey: "private", Model: "opaque-upscale-2030"}}
	raw, _ := json.Marshal(input)
	expires := time.Now().Add(time.Hour)
	task := model.Task{ID: "original-upscale", UserID: "user-1", Type: "canvas_image", Operation: "media.upscale.topaz", Status: model.TaskStatusRunning, InputJSON: string(raw), LeaseOwner: "worker", LeaseExpiresAt: &expires}
	attempt := &model.RouteAttempt{ID: "upscale-attempt", TaskID: task.ID, ChannelID: beefapi.ChannelID, DispatchState: "submission_unknown", StartedAt: time.Now()}
	for _, row := range []any{&task, attempt} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: server.URL})
	ctx = svc.bindGenerationRuntime(ctx, generation.CallMeta{UserID: task.UserID, TaskID: task.ID, TaskType: task.Type})
	ctx = context.WithValue(withProviderSubmissionKey(ctx, attempt), imageTaskContext{}, task)
	result, err := generation.Execute(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	resultJSON, _ := json.Marshal(result)
	if err := svc.saveTaskCompletionWithinStorageQuota(&task, resultJSON, []byte("[]"), false); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	var resources []model.Resource
	if err := db.Where("user_id = ? AND id <> ?", task.UserID, "source").Find(&resources).Error; err != nil || len(resources) != 1 {
		t.Fatalf("resources=%+v err=%v", resources, err)
	}
	saved, err := os.ReadFile(filepath.Join(dir, "resources", filepath.FromSlash(resources[0].ObjectKey)))
	if err != nil || !bytes.Equal(saved, data) || posts.Load() != 1 || uploads.Load() != 1 || puts.Load() != 1 || downloads.Load() != 1 {
		t.Fatalf("saved=%d err=%v counts=%d/%d/%d/%d", len(saved), err, posts.Load(), uploads.Load(), puts.Load(), downloads.Load())
	}
}

func TestManagedUpscaleDeliveryRestoresOriginalOwnedVideoAudio(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	ffmpeg, err := mediatools.ResolveFFmpeg()
	if err != nil {
		t.Skip("native ffmpeg unavailable")
	}
	if _, err := mediatools.ResolveFFprobe(); err != nil {
		t.Skip("native ffprobe unavailable")
	}
	const clip = "testdata/reference-fragmented-30fps.mp4"
	output, err := os.ReadFile(clip)
	if err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(t.TempDir(), "source.mp4")
	command := exec.Command(ffmpeg, "-nostdin", "-v", "error", "-i", clip, "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-shortest", sourcePath)
	mediatools.HideConsole(command)
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("source fixture: %s %v", out, err)
	}
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	svc, db := newManagedImageDirectService(t, filepath.Join(t.TempDir(), "workspace.db"), dir)
	defer closeDB(t, db)
	key := "users/user-1/video/source.mp4"
	path := filepath.Join(dir, "resources", filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, source, 0600); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: "source", UserID: "user-1", Kind: "video", Provider: "local", ObjectKey: key, MimeType: "video/mp4", Size: int64(len(source)), Status: model.ResourceStatusReady}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(generation.Input{Mode: "video", Config: generation.Config{CredentialRef: beefapi.CredentialRef, Model: "opaque-upscale"}, Upscale: &generation.UpscaleOptions{Factor: 2}, ReferenceVideos: []generation.Media{{StorageKey: "resource:source"}}})
	task := model.Task{ID: "video-upscale", UserID: "user-1", Type: "canvas_video", Operation: "media.upscale.topaz", Status: model.TaskStatusSucceeded, InputJSON: string(raw)}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	var downloads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downloads.Add(1)
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "" {
			t.Error("delivery performed a create or leaked credentials")
		}
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write(output)
	}))
	defer server.Close()
	adapter := generationDeliveryMediaAdapter{service: svc, allowManagedMediaHTTPForTest: true}
	saved, err := adapter.PersistRemoteArtifact(task.UserID, "video", server.URL+"/original.mp4", task.ID+":0")
	if err != nil {
		t.Fatal(err)
	}
	facts, err := mediatools.ProbeLocal(context.Background(), filepath.Join(dir, "resources", filepath.FromSlash(saved.ObjectKey)))
	if err != nil || !facts.HasAudio || !facts.HasVideo || downloads.Load() != 1 {
		t.Fatalf("saved result=%+v err=%v downloads=%d", facts, err, downloads.Load())
	}
}
