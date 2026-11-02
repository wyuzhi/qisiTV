package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 官方成功响应曾经被解析成「成功、零个视频」：Runway 的成片地址在 output[]，
// Luma 在 assets.video，xAI 在 video.url。这三个用例跑完整条视频取回链路，
// 断言成片真的落进结果，同时锁定创建请求只发官方字段。

func TestRunVideoTaskReadsRunwayTaskOutput(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	paths := make([]string, 0, 3)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			if version := r.Header.Get("X-Runway-Version"); version != "2024-11-06" {
				t.Errorf("%s X-Runway-Version = %q, want 2024-11-06", r.URL.Path, version)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/image_to_video":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode request: %v", err)
			}
			if body["model"] != "gen4.5" || body["promptText"] != "make it move" || body["ratio"] != "1280:720" || body["duration"] != float64(5) {
				t.Errorf("runway body = %#v", body)
			}
			frames, _ := body["promptImage"].([]any)
			if len(frames) != 1 {
				t.Fatalf("promptImage = %#v", body["promptImage"])
			}
			frame, _ := frames[0].(map[string]any)
			if frame["uri"] != testReferenceImageDataURL || frame["position"] != "first" {
				t.Errorf("promptImage frame = %#v", frame)
			}
			for _, legacy := range []string{"prompt", "images", "aspect_ratio", "resolution"} {
				if _, exists := body[legacy]; exists {
					t.Errorf("runway body still carries %q: %#v", legacy, body)
				}
			}
			_, _ = w.Write([]byte(`{"id":"task-1"}`))
		case "GET /v1/tasks/task-1":
			_, _ = w.Write([]byte(`{"id":"task-1","status":"SUCCEEDED","completedAt":"2025-11-11T21:50:15.123Z","output":["` + server.URL + `/files/video.mp4"],"progress":100}`))
		case "GET /files/video.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("video"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	result, err := runVideoTaskForTest(context.Background(), canvasGenerationInput{
		Prompt: "make it move",
		Config: providerConfig{
			BaseURL:       server.URL,
			APIKey:        "test-key",
			Model:         "gen4.5",
			InterfaceType: "runway-video",
			VideoSeconds:  "5",
			Size:          "16:9",
		},
		ReferenceImages: []providerMedia{{ID: "image-1", DataURL: testReferenceImageDataURL}},
	})
	if err != nil {
		t.Fatalf("runVideoTask() error = %v", err)
	}
	video, ok := result["video"].(map[string]interface{})
	if !ok || video["dataUrl"] != "data:video/mp4;base64,dmlkZW8=" {
		t.Fatalf("runway result = %#v", result)
	}
	if want := "POST /v1/image_to_video,GET /v1/tasks/task-1,GET /files/video.mp4"; strings.Join(paths, ",") != want {
		t.Fatalf("paths = %q, want %q", strings.Join(paths, ","), want)
	}
}

func TestRunVideoTaskReadsLumaGenerationAssets(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	t.Setenv("BEEFTV_PUBLIC_ASSET_ORIGIN", "")
	paths := make([]string, 0, 3)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /dream-machine/v1/generations":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode request: %v", err)
			}
			if body["model"] != "ray-2" || body["duration"] != "5s" || body["aspect_ratio"] != "16:9" {
				t.Errorf("luma body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"id":"gen-1","state":"queued","assets":{"video":null}}`))
		case "GET /dream-machine/v1/generations/gen-1":
			_, _ = w.Write([]byte(`{"id":"gen-1","state":"completed","failure_reason":null,"assets":{"video":"` + server.URL + `/files/video.mp4"}}`))
		case "GET /files/video.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("video"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	result, err := runVideoTaskForTest(context.Background(), canvasGenerationInput{
		Prompt: "make it move",
		Config: providerConfig{
			BaseURL:       server.URL,
			APIKey:        "test-key",
			Model:         "ray-2",
			InterfaceType: "luma-dream-machine",
			VideoSeconds:  "5",
			Size:          "16:9",
			VQuality:      "720p",
		},
	})
	if err != nil {
		t.Fatalf("runVideoTask() error = %v", err)
	}
	video, ok := result["video"].(map[string]interface{})
	if !ok || video["dataUrl"] != "data:video/mp4;base64,dmlkZW8=" {
		t.Fatalf("luma result = %#v", result)
	}
	if want := "POST /dream-machine/v1/generations,GET /dream-machine/v1/generations/gen-1,GET /files/video.mp4"; strings.Join(paths, ",") != want {
		t.Fatalf("paths = %q, want %q", strings.Join(paths, ","), want)
	}
}

func TestRunVideoTaskReadsXAIVideoURL(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	paths := make([]string, 0, 3)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/videos/generations":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode request: %v", err)
			}
			if body["model"] != "grok-imagine-video-1.5" || body["duration"] != float64(8) {
				t.Errorf("xAI body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"request_id":"video-1"}`))
		case "GET /v1/videos/video-1":
			_, _ = w.Write([]byte(`{"status":"done","video":{"url":"` + server.URL + `/files/video.mp4","duration":8,"respect_moderation":true},"model":"grok-imagine-video-1.5"}`))
		case "GET /files/video.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("video"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	result, err := runVideoTaskForTest(context.Background(), canvasGenerationInput{
		Prompt: "make it move",
		Config: providerConfig{
			BaseURL:       server.URL,
			APIKey:        "test-key",
			Model:         "grok-imagine-video-1.5",
			InterfaceType: "xai-video",
			Size:          "16:9",
		},
	})
	if err != nil {
		t.Fatalf("runVideoTask() error = %v", err)
	}
	video, ok := result["video"].(map[string]interface{})
	if !ok || video["dataUrl"] != "data:video/mp4;base64,dmlkZW8=" {
		t.Fatalf("xAI result = %#v", result)
	}
	if want := "POST /v1/videos/generations,GET /v1/videos/video-1,GET /files/video.mp4"; strings.Join(paths, ",") != want {
		t.Fatalf("paths = %q, want %q", strings.Join(paths, ","), want)
	}
}
