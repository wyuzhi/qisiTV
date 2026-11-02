package generation

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBYOKAsyncAudioPluginUsesOriginalTaskAndValidatesResult(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, invalid := range []bool{false, true} {
		t.Run(map[bool]string{false: "audio", true: "html"}[invalid], func(t *testing.T) {
			creates, queries, downloads := 0, 0, 0
			storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				downloads++
				if req.Header.Get("Authorization") != "" {
					t.Error("provider credential reached result storage")
				}
				if invalid {
					w.Header().Set("Content-Type", "text/html")
					_, _ = w.Write([]byte("<html>not audio</html>"))
				} else {
					w.Header().Set("Content-Type", "audio/mpeg")
					_, _ = w.Write([]byte("ID3fixture-audio"))
				}
			}))
			defer storage.Close()
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				switch req.URL.Path {
				case "/v1/audio/tasks":
					creates++
					var body map[string]any
					if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if body["model"] != "opaque-audio-fixture" || body["voice"] != "native-voice" || body["speed"] != 1.25 || body["instructions"] != "calm" {
						t.Errorf("controls changed: %#v", body)
					}
					_, _ = w.Write([]byte(`{"data":{"id":"original-audio","status":"pending"}}`))
				case "/v1/audio/tasks/original-audio":
					queries++
					_ = json.NewEncoder(w).Encode(map[string]any{"status": "completed", "result": map[string]any{"output_url": storage.URL + "/result"}})
				default:
					http.NotFound(w, req)
				}
			}))
			defer server.Close()
			input := Input{Mode: "audio", Prompt: "Fixture text", Config: Config{InterfaceType: "async-audio", BaseURL: server.URL, Model: "opaque-audio-fixture", APIKey: "synthetic", AudioVoice: "native-voice", AudioSpeed: "1.25", AudioInstructions: "calm"}}
			for _, resume := range []bool{false, true} {
				ctx := context.Background()
				if resume {
					ctx = WithRuntime(ctx, Runtime{Call: CallMeta{ProviderRequestID: "original-audio"}})
				}
				result, err := RunAudioTask(ctx, input)
				if invalid {
					if err == nil {
						t.Fatal("HTML accepted as audio")
					}
				} else if err != nil || !strings.HasPrefix(result["audio"].(map[string]any)["dataUrl"].(string), "data:audio/mpeg;base64,") {
					t.Fatalf("result=%#v err=%v", result, err)
				}
			}
			if creates != 1 || queries != 2 || downloads != 2 {
				t.Fatalf("create/query/download = %d/%d/%d; resume must only read original", creates, queries, downloads)
			}
		})
	}
}

func TestBYOKAudioMissingPluginNeverSubmits(t *testing.T) {
	_, err := RunAudioTask(WithProtocolRegistry(context.Background(), emptyProtocolRegistry), Input{Mode: "audio", Prompt: "Fixture", Config: Config{InterfaceType: "async-audio", BaseURL: "https://fixture.invalid", Model: "opaque"}})
	var preparation RequestPreparationError
	if !errors.As(err, &preparation) {
		t.Fatalf("missing plugin is not a local preparation failure: %v", err)
	}
}
