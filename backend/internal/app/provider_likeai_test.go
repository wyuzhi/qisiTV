package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"qisitv/backend/internal/protocol"
)

func likeAIAdapter(t *testing.T, mode string) protocol.Adapter {
	t.Helper()
	body, err := os.ReadFile("../../../plugin-packages/likeai/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	adapters, err := protocol.LoadInstalledProviders(body, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, adapter := range adapters {
		if adapter.Metadata().ID == "likeai-"+mode {
			return adapter
		}
	}
	t.Fatal("missing LikeAI adapter")
	return nil
}

func TestLikeAIRequestMappingAndResponseStates(t *testing.T) {
	adapter := likeAIAdapter(t, "video")
	request := protocol.GenerationRequest{Model: "doubao_seedance_2_5", Prompt: "scene", Duration: -1, Resolution: "720p", AspectRatio: "adaptive", GenerateAudio: true,
		Images: []protocol.MediaReference{{URL: "https://media.example/first.png", Role: "first_frame"}, {URL: "https://media.example/last.png", Role: "last_frame"}, {URL: "https://media.example/ref.png", Role: "reference_image"}},
		Videos: []protocol.MediaReference{{URL: "https://media.example/ref.mp4"}}, Audios: []protocol.MediaReference{{URL: "https://media.example/ref.mp3"}},
		ProviderOptions: map[string]map[string]any{"likeai-video": {"kwargs": map[string]any{"off_peak": true}, "body": map[string]any{"api_name": "wrong-model", "temperature": 0.5}}}}
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	body := spec.Body.(map[string]any)
	if body["api_name"] != request.Model || body["first_image_url"] != "https://media.example/first.png" || body["last_image_url"] != "https://media.example/last.png" || body["duration"] != -1 {
		t.Fatalf("body = %#v", body)
	}
	if len(body["image_urls"].([]any)) != 1 || len(body["video_urls"].([]any)) != 1 || len(body["audio_urls"].([]any)) != 1 {
		t.Fatalf("references = %#v", body)
	}
	if body["kwargs"].(map[string]any)["off_peak"] != true || body["temperature"] != 0.5 {
		t.Fatalf("provider options lost: %#v", body)
	}
	if spec.Auth.Header != "X-API-Key" || spec.Auth.Type != "header" {
		t.Fatalf("auth = %#v", spec.Auth)
	}
	for _, test := range []struct {
		body string
		want protocol.Status
	}{
		{`{"code":200,"data":{"task_id":"t1"}}`, protocol.StatusPending},
		{`{"code":200,"data":{"status":"running"}}`, protocol.StatusProcessing},
		{`{"code":200,"data":{"status":"completed","result":{"videos":["https://media.example/v.mp4"]}}}`, protocol.StatusSucceeded},
		{`{"code":200,"data":{"status":"failed","message":"declined"}}`, protocol.StatusFailed},
		{`{"code":409,"error":"insufficient credit"}`, protocol.StatusFailed},
		{`{"code":200,"data":{"status":"cancelled"}}`, protocol.StatusCancelled},
	} {
		result, err := adapter.ParsePoll(context.Background(), protocol.PollContext{TaskID: "t1"}, []byte(test.body))
		if err != nil || result.Status != test.want {
			t.Fatalf("parse %s: %#v %v", test.body, result, err)
		}
	}
}

func TestLikeAIMockCatalogUploadGenerationAndRecovery(t *testing.T) {
	allowLoopbackProviderTest(t)
	var server *httptest.Server
	creates, uploads, polls := 0, 0, 0
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/task-api/") && (r.Header.Get("X-API-Key") != "test-secret" || r.Header.Get("Authorization") != "") {
			t.Errorf("unexpected authentication")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/task-api/task/models":
			io.WriteString(w, `{"code":200,"data":{"models":[{"api_name":"new_image_model","type":"image"},{"api_name":"new_chat_model","type":"chat"},{"api_name":"doubao_seedance_2_5","type":"video"}]}}`)
		case "/task-api/files":
			uploads++
			file, _, err := r.FormFile("file")
			if err != nil {
				t.Error(err)
			} else {
				file.Close()
			}
			io.WriteString(w, `{"url":"https://media.example/upload.png"}`)
		case "/task-api/task/create_task":
			creates++
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if body["api_name"] != "doubao_seedance_2_5" || body["resolution"] != "720p" {
				t.Errorf("payload %#v", body)
			}
			io.WriteString(w, `{"code":200,"data":{"task_id":"mock-task"}}`)
		case "/task-api/task/query_task/mock-task":
			polls++
			json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"status": "completed", "result": map[string]any{"videos": []string{server.URL + "/result.mp4"}}}})
		case "/result.mp4":
			if r.Header.Get("X-API-Key") != "" {
				t.Error("credential leaked to media URL")
			}
			w.Header().Set("Content-Type", "video/mp4")
			io.WriteString(w, "mock video")
		default:
			t.Errorf("unexpected URL %s", r.URL)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	base := server.URL + "/task-api"
	catalog, err := fetchLikeAIModelCatalog(context.Background(), ChannelModelsRequest{BaseURL: base, APIKey: "test-secret"})
	if err != nil || len(catalog) != 3 {
		t.Fatalf("catalog %#v: %v", catalog, err)
	}
	if catalog[1].ModelType != "text" || catalog[1].SupportedEndpointTypes[0] != "likeai-text" {
		t.Fatalf("chat classification %#v", catalog)
	}
	input := canvasGenerationInput{Mode: "video", Prompt: "test", Config: providerConfig{BaseURL: base, APIKey: "test-secret", Model: "doubao_seedance_2_5", InterfaceType: "likeai-video", VideoSeconds: "5", VQuality: "720p"}, ReferenceImages: []providerMedia{{Name: "ref.png", MimeType: "image/png", DataURL: "data:image/png;base64,dGVzdA=="}}}
	if err := prepareLikeAIReferences(context.Background(), &input); err != nil {
		t.Fatal(err)
	}
	if input.ReferenceImages[0].DataURL != "" || input.ReferenceImages[0].URL != "https://media.example/upload.png" {
		t.Fatal("upload not substituted")
	}
	adapter := likeAIAdapter(t, "video")
	result, err := runProtocolAdapterTaskWithPolicy(context.Background(), input, adapter, fastVideoPollPolicy())
	if err != nil || result["mode"] != "video" {
		t.Fatalf("generation %#v: %v", result, err)
	}
	resumeCtx := context.WithValue(context.Background(), providerAnalyticsKey{}, providerAnalyticsContext{ProviderRequestID: "mock-task"})
	_, err = runProtocolAdapterTaskWithPolicy(resumeCtx, input, adapter, fastVideoPollPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if creates != 1 || uploads != 1 || polls != 2 {
		t.Fatalf("calls create/upload/poll %d/%d/%d", creates, uploads, polls)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = runProtocolAdapterTaskWithPolicy(ctx, input, adapter, fastVideoPollPolicy())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel error %v", err)
	}
}

func TestLikeAIKnownCapabilities(t *testing.T) {
	for _, name := range []string{"doubao_seedance_2_5", "tongyi_wan_video_3_prime"} {
		profile := DefaultModelCapabilityConfigForModel("likeai-video", name)
		if _, err := NormalizeModelCapabilityConfigForModel("video", "likeai-video", name, profile); err != nil {
			t.Fatal(err)
		}
		input := canvasGenerationInput{Config: providerConfig{InterfaceType: "likeai-video", Model: name, VideoSeconds: "-1", VQuality: "720p", Size: "adaptive"}}
		if err := validateVideoTask(profile.Video, input); err != nil {
			t.Fatal(err)
		}
		if protocolRequestFromInput(input).Duration != -1 {
			t.Fatal("auto duration lost")
		}
	}
}

func TestLikeAIModelSpecificAudioAndVideoInputs(t *testing.T) {
	adapter := likeAIAdapter(t, "video")
	for _, test := range []struct {
		model, field string
		want         any
	}{
		{"vidu_q3_video_reference", "audio", true},
		{"like_lite_1", "bgm", true},
		{"baidu_vod_keling_v3_omni_video", "sound", "on"},
		{"doubao_seedance_2_5", "generate_audio", true},
	} {
		spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: protocol.GenerationRequest{Model: test.model, GenerateAudio: true}})
		if err != nil {
			t.Fatal(err)
		}
		if spec.Body.(map[string]any)["kwargs"].(map[string]any)[test.field] != test.want {
			t.Fatalf("audio mapping %s: %#v", test.model, spec.Body)
		}
	}
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: protocol.GenerationRequest{Model: "qianfan_vidu_q2_turbo_video_extend", Videos: []protocol.MediaReference{{URL: "https://media.example/source.mp4"}}}})
	if err != nil || spec.Body.(map[string]any)["video_url"] != "https://media.example/source.mp4" {
		t.Fatalf("video extend mapping %#v %v", spec, err)
	}
}

func TestLikeAITextAndImageResults(t *testing.T) {
	for _, mode := range []string{"text", "image", "audio"} {
		adapter := likeAIAdapter(t, mode)
		result, err := adapter.ParsePoll(context.Background(), protocol.PollContext{TaskID: "t1"}, []byte(`{"code":200,"data":{"status":"completed","result":{"text":"answer","images":["https://media.example/a.png"],"audios":["https://media.example/a.mp3"]}}}`))
		if err != nil || result.Status != protocol.StatusSucceeded || result.Result.Text != "answer" || len(result.Result.Images) != 1 || len(result.Result.Audios) != 1 {
			t.Fatalf("%s result %#v %v", mode, result, err)
		}
	}
}
