package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/platform"
	"qisitv/backend/internal/protocol"
	localtask "qisitv/backend/internal/task"
)

func grokSourceRegistry(t *testing.T) *protocol.Registry {
	t.Helper()
	registry, err := protocol.NewRegistry(officialSourceProviderAdapter(t, "xai-grok-images", "grok-image"))
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

// These assertions replace the removed handwritten body helpers with actual
// requests from the installed source manifest and the channel-test entry point.
func captureGrokImageRequest(t *testing.T, input canvasGenerationInput) (map[string]any, string) {
	t.Helper()
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var posts atomic.Int32
	var body map[string]any
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		path = r.URL.Path
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Authorization") != "Bearer fixture-key" {
			t.Errorf("unexpected request: %s %s, headers=%v", r.Method, path, r.Header)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"url":"https://example.com/result.png"}]}`))
	}))
	t.Cleanup(server.Close)
	input.Mode, input.Config.BaseURL, input.Config.APIKey = "image", server.URL, "fixture-key"
	input.Config.InterfaceType = "grok-image"
	if input.Config.Model == "" {
		input.Config.Model = "grok-imagine-image"
	}
	if input.Prompt == "" {
		input.Prompt = "a cat"
	}
	result, err := runImageTask(withProtocolRegistry(context.Background(), grokSourceRegistry(t)), input)
	if err != nil {
		t.Fatal(err)
	}
	images, ok := result["images"].([]any)
	if !ok || len(images) != 1 || images[0].(map[string]any)["url"] != "https://example.com/result.png" || posts.Load() != 1 {
		t.Fatalf("posts=%d result=%#v", posts.Load(), result)
	}
	if _, exists := body["size"]; exists {
		t.Fatalf("Grok must send aspect_ratio, not size: %#v", body)
	}
	return body, path
}

func TestGrokImagePluginMapsAspectRatios(t *testing.T) {
	cases := map[string]string{
		"768x1152": "2:3", "1280x1920": "2:3", "1152x768": "3:2", "1920x1280": "3:2",
		"540x1080": "1:2", "1080x540": "2:1", "1280x720": "16:9", "720x1280": "9:16",
		"800x800": "1:1", "1200x900": "4:3", "900x1200": "3:4", "": "", "auto": "",
	}
	for _, ratio := range []string{"1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "9:19.5", "19.5:9", "1:2", "2:1"} {
		cases[ratio] = ratio
	}
	for size, want := range cases {
		t.Run(size, func(t *testing.T) {
			body, path := captureGrokImageRequest(t, canvasGenerationInput{Config: providerConfig{Size: size, Quality: "2k"}})
			got, _ := body["aspect_ratio"].(string)
			if path != "/v1/images/generations" || got != want || body["resolution"] != "2k" {
				t.Fatalf("path=%s body=%#v want ratio=%q", path, body, want)
			}
			if want == "" && body["aspect_ratio"] != nil {
				t.Fatalf("automatic/invalid ratio must be omitted: %#v", body)
			}
		})
	}
}

func TestGrokImagePluginMapsResolution(t *testing.T) {
	for quality, want := range map[string]string{"1k": "1k", "low": "1k", "standard": "1k", "2k": "2k", "medium": "2k", "hd": "2k", "high": "2k", "4k": "2k", "auto": "", "": "", "bad": ""} {
		t.Run(quality, func(t *testing.T) {
			body, _ := captureGrokImageRequest(t, canvasGenerationInput{Config: providerConfig{Quality: quality}})
			got, _ := body["resolution"].(string)
			if got != want || (want == "" && body["resolution"] != nil) {
				t.Fatalf("body=%#v want resolution=%q", body, want)
			}
		})
	}
}

func TestGrokImagePluginUsesJSONEditContract(t *testing.T) {
	for _, reference := range []providerMedia{
		{DataURL: tinyPNGDataURL},
		{URL: "https://example.com/reference.png", DataURL: tinyPNGDataURL},
	} {
		t.Run(reference.URL, func(t *testing.T) {
			body, path := captureGrokImageRequest(t, canvasGenerationInput{
				Prompt: "edit the reference", Config: providerConfig{Model: "grok-imagine-image-quality"},
				ReferenceImages: []providerMedia{reference},
			})
			want := reference.URL
			if want == "" {
				want = reference.DataURL
			}
			image, _ := body["image"].(map[string]any)
			if path != "/v1/images/edits" || image["url"] != want || body["model"] != "grok-imagine-image-quality" || body["n"] != float64(1) || body["response_format"] != "url" {
				t.Fatalf("path=%s body=%#v", path, body)
			}
		})
	}
}

func TestGrokImagePluginKeepsInstalledPromptCountAndOptions(t *testing.T) {
	body, _ := captureGrokImageRequest(t, canvasGenerationInput{
		Prompt: "user prompt", Config: providerConfig{SystemPrompt: "system instructions", Count: "3", VQuality: "1k", Quality: "high"},
		Metadata: map[string]any{"providerOptions": map[string]any{
			"grok-image": map[string]any{"response_format": "b64_json", "user": "fixture-user"},
			"other":      map[string]any{"user": "wrong-user"},
		}},
	})
	// The installed plugin uses prompt and configured n. The deleted fallback
	// merged system instructions into prompt and forced n=1 instead.
	if body["prompt"] != "user prompt" || body["n"] != float64(3) || body["response_format"] != "b64_json" || body["user"] != "fixture-user" || body["resolution"] != "1k" {
		t.Fatalf("installed plugin behavior changed: %#v", body)
	}
	for _, key := range []string{"system", "instructions", "providerOptions", "idempotencyKey"} {
		if _, exists := body[key]; exists {
			t.Fatalf("unexpected upstream field %s: %#v", key, body)
		}
	}
}

func TestGrokImageQueueDeliversPluginResults(t *testing.T) {
	for _, format := range []string{"url", "b64_json"} {
		t.Run(format, func(t *testing.T) {
			t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
			var posts, gets atomic.Int32
			png, _ := base64.StdEncoding.DecodeString(strings.SplitN(tinyPNGDataURL, ",", 2)[1])
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet && r.URL.Path == "/result.png" {
					gets.Add(1)
					w.Header().Set("Content-Type", "image/png")
					_, _ = w.Write(png)
					return
				}
				posts.Add(1)
				wantPath := "/v1/images/generations"
				if format == "b64_json" {
					wantPath = "/v1/images/edits"
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if r.Method != http.MethodPost || r.URL.Path != wantPath || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Authorization") != "Bearer fixture-key" || body["model"] != "unlisted-image-model" {
					t.Errorf("request=%s %s body=%#v", r.Method, r.URL.Path, body)
				}
				if format == "b64_json" && body["image"].(map[string]any)["url"] != tinyPNGDataURL {
					t.Errorf("edit reference=%#v", body["image"])
				}
				item := map[string]string{format: base64.StdEncoding.EncodeToString(png)}
				if format == "url" {
					item[format] = server.URL + "/result.png"
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{item}})
			}))
			t.Cleanup(server.Close)
			s, db, _, _ := creationTestService(t)
			s.coordinator = platform.NewLocalCoordinator()
			s.pluginRuntime = pluginRuntimeFromRecords(nil)
			if err := s.pluginRuntime.registrySnapshot().Register(officialSourceProviderAdapter(t, "xai-grok-images", "grok-image")); err != nil {
				t.Fatal(err)
			}
			input := canvasGenerationInput{Mode: "image", Prompt: "a cat", Config: providerConfig{BaseURL: server.URL, APIKey: "fixture-key", Model: "unlisted-image-model", InterfaceType: "grok-image"}}
			if format == "b64_json" {
				input.ReferenceImages = []providerMedia{{DataURL: tinyPNGDataURL}}
			}
			raw, _ := json.Marshal(input)
			task := model.Task{ID: "grok-queue", UserID: "user", Type: "canvas_image", Status: model.TaskStatusRunning, InputJSON: string(raw)}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			result, _, err := s.processTask(context.Background(), task)
			if err != nil {
				t.Fatal(err)
			}
			if posts.Load() != 1 || gets.Load() != 0 {
				t.Fatalf("create=%d download before persistence=%d", posts.Load(), gets.Load())
			}
			encoded, _ := json.Marshal(result)
			if err := s.saveTaskCompletionWithinStorageQuota(&task, encoded, nil, false); err != nil {
				t.Fatal(err)
			}
			stored, err := s.repo.Task(task.ID)
			if err != nil || stored.Status != model.TaskStatusSucceeded || !strings.Contains(stored.ResultJSON, "images") {
				t.Fatalf("persisted task=%+v err=%v", stored, err)
			}
			if err := s.DeliverSucceededTask(*stored); err != nil {
				t.Fatal(err)
			}
			delivered, err := s.Task(task.UserID, task.ID)
			if err != nil || delivered.ResultState != localtask.ResultStateReady || len(delivered.Outputs) != 1 || delivered.Outputs[0].ResourceID == "" || delivered.Outputs[0].MaterializedAssetID == "" {
				t.Fatalf("delivered task=%+v err=%v", delivered, err)
			}
			_, file, err := s.OpenResource(task.UserID, delivered.Outputs[0].ResourceID)
			if err != nil {
				t.Fatal(err)
			}
			saved, readErr := io.ReadAll(file)
			_ = file.Close()
			if readErr != nil || !bytes.Equal(saved, png) {
				t.Fatalf("delivered bytes differ: %v", readErr)
			}
			wantGets := int32(0)
			if format == "url" {
				wantGets = 1
			}
			if posts.Load() != 1 || gets.Load() != wantGets {
				t.Fatalf("delivery requests: posts=%d gets=%d", posts.Load(), gets.Load())
			}
		})
	}
}

func TestGrokImageQueueRejectsMaskAndMultipleReferences(t *testing.T) {
	for _, kind := range []string{"mask", "multiple"} {
		t.Run(kind, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests.Add(1) }))
			t.Cleanup(server.Close)
			s, _, _, _ := creationTestService(t)
			s.coordinator = platform.NewLocalCoordinator()
			s.pluginRuntime = pluginRuntimeFromRecords(nil)
			if err := s.pluginRuntime.registrySnapshot().Register(officialSourceProviderAdapter(t, "xai-grok-images", "grok-image")); err != nil {
				t.Fatal(err)
			}
			input := canvasGenerationInput{Mode: "image", Prompt: "edit", Config: providerConfig{BaseURL: server.URL, APIKey: "fixture", Model: "grok-imagine-image", InterfaceType: "grok-image"}, ReferenceImages: []providerMedia{{DataURL: tinyPNGDataURL}}}
			want := "蒙版"
			if kind == "mask" {
				input.Mask = &providerMedia{DataURL: tinyPNGDataURL}
			} else {
				input.ReferenceImages = append(input.ReferenceImages, providerMedia{DataURL: tinyPNGDataURL})
				want = "最多支持 1 张"
			}
			raw, _ := json.Marshal(input)
			_, err := s.processCanvasGenerationTask(withTaskExecutionID(context.Background(), "preflight"), "user", "", "canvas_image", "", string(raw))
			if err == nil || !strings.Contains(err.Error(), want) || requests.Load() != 0 {
				t.Fatalf("preflight err=%v requests=%d", err, requests.Load())
			}
		})
	}
}

func TestGrokImageMissingPluginPreservesSubmissionEvidence(t *testing.T) {
	for _, resumed := range []bool{false, true} {
		t.Run(map[bool]string{false: "new", true: "resumed"}[resumed], func(t *testing.T) {
			s, task, attempt := routeUnknownFixture(t)
			task.Type = "canvas_image"
			ctx := withProtocolRegistry(context.Background(), mustEmptyGrokRegistry(t))
			if resumed {
				task.ProviderRequestID = "original-provider-task"
				ctx = generation.WithCallMeta(ctx, generation.CallMeta{ProviderRequestID: task.ProviderRequestID})
			}
			_, err := runImageTask(ctx, canvasGenerationInput{Mode: "image", Config: providerConfig{InterfaceType: "grok-image"}})
			if err == nil {
				t.Fatal("missing plugin succeeded")
			}
			s.finishTaskRouteAttempt(attempt, &task, err)
			stored, loadErr := s.repo.LatestRouteAttempt(task.ID)
			if loadErr != nil {
				t.Fatal(loadErr)
			}
			if !resumed && stored.FailureCode != "request_not_sent" {
				t.Fatalf("new request failure=%+v", stored)
			}
			if resumed && (stored.FailureCode == "request_not_sent" || stored.DispatchState == "rejected_no_job" || task.ProviderRequestID != "original-provider-task") {
				t.Fatalf("resumed evidence lost: task=%+v attempt=%+v", task, stored)
			}
		})
	}
}

func TestGrokImageAdminChannelModelTestUsesInstalledPlugin(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var posts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/images/generations" || r.Header.Get("Authorization") != "Bearer channel-fixture" || body["model"] != "unlisted-provider-model" || body["n"] != float64(1) || body["response_format"] != "url" {
			t.Errorf("channel test request=%s %s body=%#v", r.Method, r.URL.Path, body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"iVBORw0KGgo="}]}`))
	}))
	t.Cleanup(server.Close)
	s, db, _, _ := creationTestService(t)
	s.coordinator = platform.NewLocalCoordinator()
	s.pluginRuntime = pluginRuntimeFromRecords(nil)
	if err := s.pluginRuntime.registrySnapshot().Register(officialSourceProviderAdapter(t, "xai-grok-images", "grok-image")); err != nil {
		t.Fatal(err)
	}
	channel := model.ModelChannel{ID: "grok-channel", Scope: model.ChannelScopeSystem, Name: "Grok fixture", Enabled: true, BaseURL: server.URL, APIKey: "channel-fixture", APIFormat: "openai"}
	if err := s.encryptSystemChannelSecrets(&channel); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	result, err := s.TestAdminChannelModel(context.Background(), &model.User{ID: "admin", Role: model.UserRoleAdmin}, channel.ID, ChannelModelRequest{
		ModelKey: "friendly-name", ProviderModelKey: "unlisted-provider-model", Capability: "image", Protocol: "grok-image",
		CapabilityConfig: DefaultModelCapabilityConfigForModel("grok-image", "unlisted-provider-model"),
	})
	if err != nil || result == nil || posts.Load() != 1 {
		t.Fatalf("channel test result=%+v err=%v posts=%d", result, err, posts.Load())
	}
}

func TestGrokImageDisabledPackageFailsBeforeSubmission(t *testing.T) {
	center, err := newPluginRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := center.setEnabled("xai-grok-images", false); err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests.Add(1) }))
	t.Cleanup(server.Close)
	s, _, _, _ := creationTestService(t)
	s.pluginRuntime = center
	input := canvasGenerationInput{Mode: "image", Prompt: "draw", Config: providerConfig{BaseURL: server.URL, APIKey: "fixture", InterfaceType: "grok-image", Model: "grok-imagine-image"}}
	raw, _ := json.Marshal(input)
	_, err = s.processCanvasGenerationTask(withTaskExecutionID(context.Background(), "disabled"), "user", "", "canvas_image", "", string(raw))
	if err == nil || requests.Load() != 0 || routeFailureCode(err) != "request_not_sent" {
		t.Fatalf("disabled plugin err=%v requests=%d route failure=%s", err, requests.Load(), routeFailureCode(err))
	}
}

func mustEmptyGrokRegistry(t *testing.T) *protocol.Registry {
	t.Helper()
	registry, err := protocol.NewRegistry()
	if err != nil {
		t.Fatal(err)
	}
	return registry
}
