package generation

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"qisitv/backend/internal/beefapi"
)

func TestManagedUnknownVideoSendsCatalogResolutionAndExplicitBusinessSwitches(t *testing.T) {
	for index, tc := range []struct {
		quality, want string
		profile       *VideoCapabilityConfig
	}{
		{quality: "480", want: "480p"},
		{quality: "720", want: "720p"},
		{quality: "1080", want: "1080p"},
		{quality: "720", want: "720p", profile: &VideoCapabilityConfig{Resolutions: []string{"480p", "720p", "1080p"}}},
		{quality: "2160", want: "4k", profile: &VideoCapabilityConfig{Resolutions: []string{"4k"}}},
		{quality: "server-native", want: "server-native", profile: &VideoCapabilityConfig{Resolutions: []string{"server-native"}}},
	} {
		t.Run(tc.quality+"/"+tc.want, func(t *testing.T) {
			creates := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/v1/videos" {
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
					w.WriteHeader(500)
					return
				}
				creates++
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body["model"] != "unseen-catalog-video" || body["resolution"] != tc.want || body["enable_safety_checker"] != true || body["seed"] != float64(0) {
					t.Errorf("wrong declared token/options: %#v", body)
				}
				if _, present := body["sync_mode"]; present {
					t.Errorf("historical result transport override leaked: %#v", body)
				}
				_ = json.NewEncoder(w).Encode(map[string]string{"id": "same-task"})
			}))
			defer server.Close()
			input := Input{Mode: "video", Prompt: "free wire fixture", Config: Config{CredentialRef: beefapi.CredentialRef, Model: "unseen-catalog-video", BaseURL: server.URL, APIKey: "fixture", VQuality: tc.quality}, VideoCapability: tc.profile, Metadata: map[string]any{"videoH3Options": map[string]any{"seed": float64(0), "enable_safety_checker": true, "sync_mode": index%2 == 0}}}
			ctx := WithSubmissionKey(WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: server.URL}), "same-attempt")
			policy := DefaultVideoPollPolicy()
			policy.Sleep = func(context.Context, time.Duration) error { return context.Canceled }
			if _, err := RunVideoTaskWithPolicy(ctx, input, policy); !errors.Is(err, context.Canceled) || creates != 1 {
				t.Fatalf("creates=%d err=%v", creates, err)
			}
		})
	}
}

func TestManagedVideoCanonicalIntentHasNoModelTransportRules(t *testing.T) {
	for _, id := range []string{"opaque-future-video", "minimax-h3-max", "seedance-2.5", "grok-imagine-video-1.5", "kling-video-v3"} {
		input := Input{Prompt: "scene", Config: Config{Model: id, Size: "9:16", VideoSeconds: "0.925", VQuality: "768", VideoGenerateAudio: "false", VideoWatermark: "false"}, ReferenceImages: []Media{{ID: "first", URL: "https://example.com/first.png"}, {ID: "middle", URL: "https://example.com/middle.png"}, {ID: "last", URL: "https://example.com/last.png"}}, ReferenceVideos: []Media{{ID: "video", URL: "https://example.com/video.mp4"}}, ReferenceAudios: []Media{{ID: "audio", URL: "https://example.com/audio.wav"}}, Metadata: map[string]any{"videoEditOperation": "reference_to_video", "videoStartFrameNodeId": "first", "videoMiddleFrameNodeId": "middle", "videoEndFrameNodeId": "last", "videoMiddleFrameTime": 2.5, "videoReferenceOrder": []string{"audio", "first", "video", "middle", "last"}, "videoH3Options": map[string]any{"seed": float64(0), "prompt_expansion_mode": "quality", "damage_level": "heavy", "sync_mode": true, "enable_safety_checker": false}}}
		body, err := BeefAPIVideoRequestBody(input)
		if err != nil {
			t.Fatal(err)
		}
		meta := body["metadata"].(map[string]any)
		if body["model"] != id || body["resolution"] != "768p" || body["seconds"] != "0.925" || body["aspect_ratio"] != "9:16" || meta["operation"] != "reference_to_video" || meta["generate_audio"] != false || meta["watermark"] != false || body["seed"] != float64(0) || body["middle_frame_time"] != 2.5 || body["prompt_expansion_mode"] != "quality" || body["damage_level"] != "heavy" || body["enable_safety_checker"] != false {
			t.Fatalf("lost user controls: %#v", body)
		}
		content := body["content"].([]map[string]any)
		var roles []any
		for _, item := range content {
			roles = append(roles, item["role"])
		}
		if !reflect.DeepEqual(roles, []any{"reference_audio", "first_frame", "reference_video", "middle_frame", "last_frame"}) {
			t.Fatalf("order/roles: %#v", content)
		}
		for _, key := range []string{"operation", "first_frame_url", "reference_conditions", "response_format", "sync_mode"} {
			if _, present := body[key]; present {
				t.Fatalf("supplier field %s leaked", key)
			}
		}
	}
}

func TestManagedUnknownVideoCreatesOnceAndResumesOnlyGET(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	creates, queries, contentCalls, storageCalls := 0, 0, 0, 0
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		storageCalls++
		if r.Header.Get("Authorization") != "" {
			t.Error("gateway credential leaked to object storage on redirect")
		}
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write([]byte("original video"))
	}))
	defer storage.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture" {
			t.Error("missing API credential")
		}
		switch r.URL.Path {
		case "/v1/videos":
			creates++
			if r.Method != "POST" || r.Header.Get("Idempotency-Key") != "stable-attempt" {
				t.Error("unstable create")
			}
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["model"] != "opaque-future-video" || body["resolution"] != "768p" || body["seconds"] != "5" {
				t.Errorf("changed user values: %#v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "original"})
		case "/v1/videos/original":
			queries++
			if r.Method != "GET" {
				t.Error("recovery mutated task")
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "original", "status": "completed"})
		case "/v1/videos/original/content":
			contentCalls++
			if contentCalls == 1 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"error":{"message":"Video is being saved; retry later","type":"video_delivery_pending"}}`))
				return
			}
			http.Redirect(w, r, storage.URL+"/video.mp4", http.StatusFound)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	ctx := WithSubmissionKey(WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: server.URL}), "stable-attempt")
	policy := DefaultVideoPollPolicy()
	policy.Sleep = func(context.Context, time.Duration) error { return nil }
	input := Input{Mode: "video", Prompt: "scene", Config: Config{CredentialRef: beefapi.CredentialRef, BaseURL: server.URL, APIKey: "fixture", Model: "opaque-future-video", InterfaceType: "stale-unknown-plugin", VQuality: "768", VideoSeconds: "5"}}
	for _, call := range []context.Context{ctx, EnrichCallMeta(ctx, CallMeta{ProviderRequestID: "original"})} {
		result, err := RunVideoTaskWithPolicy(call, input, policy)
		if err != nil || result["mode"] != "video" {
			t.Fatalf("result=%v err=%v", result, err)
		}
	}
	if creates != 1 || queries != 2 || contentCalls != 3 || storageCalls != 2 {
		t.Fatalf("calls=%d/%d/%d/%d", creates, queries, contentCalls, storageCalls)
	}
}

func TestManagedUnknownVideoKeepsSameImageFirstAndLastAndRejectsMissingSelection(t *testing.T) {
	input := Input{Config: Config{Model: "opaque-future"}, ReferenceImages: []Media{{ID: "same", URL: "https://example.com/same.png"}}, Metadata: map[string]any{"videoStartFrameNodeId": "same", "videoEndFrameNodeId": "same"}}
	for i := 0; i < 5; i++ {
		body, err := BeefAPIVideoRequestBody(input)
		if err != nil {
			t.Fatal(err)
		}
		content := body["content"].([]map[string]any)
		if len(content) != 2 || content[0]["role"] != "first_frame" || content[1]["role"] != "last_frame" || !reflect.DeepEqual(content[0]["image_url"], content[1]["image_url"]) {
			t.Fatalf("same-image roles lost: %#v", content)
		}
	}
	input.Metadata["videoEndFrameNodeId"] = "missing"
	if _, err := BeefAPIVideoRequestBody(input); err == nil {
		t.Fatal("missing selection ignored")
	}
	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { posts++; w.WriteHeader(500) }))
	defer server.Close()
	input.Config.BaseURL, input.Config.CredentialRef = server.URL, beefapi.CredentialRef
	ctx := WithSubmissionKey(WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: server.URL}), "stable-invalid-frame")
	if _, err := RunVideoTaskWithPolicy(ctx, input, DefaultVideoPollPolicy()); err == nil || posts != 0 {
		t.Fatalf("invalid frame reached create: %v posts=%d", err, posts)
	}
}
