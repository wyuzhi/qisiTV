package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"qisitv/backend/internal/protocol"
)

type likeAITestRequestPort func(*http.Request) (bool, []byte, string, error)

func (p likeAITestRequestPort) Intercept(req *http.Request) (bool, []byte, string, error) {
	return p(req)
}

func TestLikeAIUpscaleExecutesUploadSubmitPollDownloadAndResumesOriginal(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, model := range []string{"huoshan_image_super_resolution", "tengxun_video_super_resolution"} {
		t.Run(model, func(t *testing.T) {
			bounded, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			kind := UpscaleMediaType(model)
			payload, mime := upscalePNG(t, 128, 96), "image/png"
			if kind == "video" {
				payload, mime = unifiedVideoPayload(t), "video/mp4"
			}
			downloads, uploads, creates, polls := 0, 0, 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.Header.Get("X-API-Key") != "" || req.Header.Get("Authorization") != "" {
					t.Error("provider secret reached result download")
				}
				downloads++
				w.Header().Set("Content-Type", mime)
				_, _ = w.Write(payload)
			}))
			defer server.Close()
			port := likeAITestRequestPort(func(req *http.Request) (bool, []byte, string, error) {
				if req.URL.Host != "task.likeai.pro" {
					return false, nil, "", nil
				}
				if req.Header.Get("X-API-Key") != "synthetic-upscale" || req.Header.Get("Authorization") != "" {
					t.Fatal("wrong LikeAI credential")
				}
				response := ""
				switch req.URL.Path {
				case "/task-api/files":
					uploads++
					file, _, err := req.FormFile("file")
					if err != nil {
						t.Fatal(err)
					}
					original, _ := io.ReadAll(file)
					_ = file.Close()
					if !bytes.Equal(original, payload) {
						t.Fatal("owned input bytes changed")
					}
					response = `{"url":"https://media.example/source"}`
				case "/task-api/task/create_task":
					creates++
					var body map[string]any
					if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
						t.Fatal(err)
					}
					if body["api_name"] != model || body["prompt"] != nil || body["duration"] != nil || body["aspect_ratio"] != nil {
						t.Fatalf("wrong upscale fields: %#v", body)
					}
					if kind == "image" && body["kwargs"].(map[string]any)["model_quality"] != "MQ" {
						t.Fatal("missing image quality")
					}
					if kind == "video" && body["resolution"] != "1440p" {
						t.Fatal("missing video resolution")
					}
					response = `{"code":200,"data":{"task_id":"original-upscale"}}`
				case "/task-api/task/query_task/original-upscale":
					polls++
					response = fmt.Sprintf(`{"code":200,"data":{"status":"completed","result":{"%ss":[%q]}}}`, kind, server.URL+"/result")
				default:
					t.Fatalf("unexpected API request %s", req.URL.Path)
				}
				return true, []byte(response), "application/json", nil
			})
			runtime := taskRuntime(func(runtime *Runtime) {
				runtime.Images = port
				runtime.Resources = upscaleResources{data: payload, kind: kind}
			})
			input := Input{Mode: kind, Prompt: "AI 超清", Config: Config{BaseURL: LikeAIBaseURL, APIKey: "synthetic-upscale", Model: model, InterfaceType: "likeai-" + kind}, Upscale: &UpscaleOptions{Factor: 1}}
			if kind == "image" {
				input.Upscale.ModelQuality = "MQ"
				input.ReferenceImages = []Media{{StorageKey: "resource:source"}}
			} else {
				input.Upscale.Resolution = "1440p"
				input.ReferenceVideos = []Media{{StorageKey: "resource:source"}}
			}
			ctx := WithProtocolRegistry(WithRuntime(bounded, runtime), LoadOfficialFallbackRegistry())
			result, err := Execute(ctx, input)
			if err != nil || result == nil {
				t.Fatalf("upscale result: %v", err)
			}
			// Image URLs are durably handed to the separate delivery worker;
			// video bytes are downloaded here by the unified video delivery path.
			wantDownloads := 2
			if kind == "image" {
				wantDownloads = 0
				if result["images"].([]any)[0].(map[string]any)["url"] != server.URL+"/result" {
					t.Fatal("lost image delivery URL")
				}
			}
			if err := ValidateUpscaleInput(input); err != nil {
				t.Fatalf("execution mutated original source: %v", err)
			}
			if _, _, err := RecoverUpscaleResult(ctx, input, "original-upscale"); err != nil {
				t.Fatal(err)
			}
			if uploads != 1 || creates != 1 || polls != 2 || downloads != wantDownloads {
				t.Fatalf("uploads=%d creates=%d polls=%d downloads=%d", uploads, creates, polls, downloads)
			}
		})
	}
}

type likeAICapturePort struct{ request *http.Request }

func (p *likeAICapturePort) Intercept(req *http.Request) (bool, []byte, string, error) {
	p.request = req
	return true, []byte(`{"code":200,"data":{"models":[]}}`), "application/json", nil
}

func TestLikeAICredentialsStayWithConfiguredService(t *testing.T) {
	for _, test := range []struct{ base, header, value string }{{LikeAIBaseURL, "X-API-Key", "fixture"}, {QisiAPIBaseURL, "Authorization", "Bearer fixture"}} {
		capture := &likeAICapturePort{}
		ctx := WithRuntime(context.Background(), Runtime{Images: capture})
		_, err := ExecuteProtocolRequest(ctx, Config{BaseURL: test.base, APIKey: "fixture", InterfaceType: "likeai-video"}, protocol.RequestSpec{Method: "GET", Path: "/task/models", Headers: map[string]string{"X-API-Key": "wrong", "Authorization": "wrong"}})
		if err != nil {
			t.Fatal(err)
		}
		if capture.request.URL.String() != test.base+"/task/models" || capture.request.Header.Get(test.header) != test.value {
			t.Fatal("service endpoint or auth mismatch")
		}
		if capture.request.Context().Value(binaryNoRedirectContext{}) != true {
			t.Fatal("fixed service request may redirect credential")
		}
		other := "Authorization"
		if test.header == "Authorization" {
			other = "X-API-Key"
		}
		if capture.request.Header.Get(other) != "" {
			t.Fatal("credential header crossed service boundary")
		}
	}
	for _, base := range []string{"https://task.likeai.pro.evil.example/task-api", "https://cheeser.link/api-service/likeai?x=1", "http://task.likeai.pro/task-api"} {
		capture := &likeAICapturePort{}
		_, err := ExecuteProtocolRequest(WithRuntime(context.Background(), Runtime{Images: capture}), Config{BaseURL: base, APIKey: "fixture", InterfaceType: "likeai-image"}, protocol.RequestSpec{Method: "GET", Path: "/task/models"})
		if err == nil || capture.request != nil {
			t.Fatal("untrusted service received credential")
		}
	}
}

func TestLikeAIUpscaleUsesDocumentedFieldsOnly(t *testing.T) {
	for _, model := range []string{"huoshan_image_super_resolution", "tengxun_video_super_resolution"} {
		reader, _, err := ProtocolRequestBody(context.Background(), Config{Model: model}, protocol.RequestSpec{Path: "/task/create_task", Body: map[string]any{"api_name": "wrong", "prompt": "must drop", "duration": 5, "aspect_ratio": "16:9", "resolution": "2160p", "image_urls": []string{"https://media.example/i.png"}, "video_urls": []string{"https://media.example/v.mp4"}, "kwargs": map[string]any{"model_quality": "HQ", "unexpected": true}}})
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(reader)
		var body map[string]any
		if err := json.Unmarshal(data, &body); err != nil {
			t.Fatal(err)
		}
		if body["api_name"] != model || body["duration"] != nil || body["aspect_ratio"] != nil || body["prompt"] != nil {
			t.Fatal("generic generation fields leaked into upscale")
		}
		if model == "huoshan_image_super_resolution" && (body["resolution"] != nil || body["video_urls"] != nil || len(body["kwargs"].(map[string]any)) != 1) {
			t.Fatal("wrong image upscale body")
		}
		if model == "tengxun_video_super_resolution" && (body["resolution"] != "2160p" || body["image_urls"] != nil || body["kwargs"] != nil) {
			t.Fatal("wrong video upscale body")
		}
	}
}

func TestLikeAIUpscaleRequiresOwnedResourceAndActualProvider(t *testing.T) {
	input := Input{Mode: "image", Config: Config{Model: "huoshan_image_super_resolution", BaseURL: LikeAIBaseURL, InterfaceType: "likeai-image"}, Upscale: &UpscaleOptions{Factor: 1, ModelQuality: "MQ"}, ReferenceImages: []Media{{StorageKey: "resource:owned"}}}
	if err := ValidateUpscaleInput(input); err != nil {
		t.Fatal(err)
	}
	input.Config.BaseURL = QisiAPIBaseURL
	if err := ValidateUpscaleInput(input); err == nil {
		t.Fatal("qisi does not offer these upscale models")
	}
	input.Config.BaseURL = LikeAIBaseURL
	input.ReferenceImages[0].URL = "https://media.example/not-owned.png"
	if err := ValidateUpscaleInput(input); err == nil {
		t.Fatal("ownership bypass accepted")
	}
	input.ReferenceImages[0].URL = ""
	input.Upscale.Factor = 4
	if err := ValidateUpscaleInput(input); err == nil {
		t.Fatal("invented scale parameter accepted")
	}
}
