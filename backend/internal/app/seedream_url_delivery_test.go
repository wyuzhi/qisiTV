package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
)

func TestSeedreamURLResultPersistsOriginalImageAndReopens(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var encoded bytes.Buffer
	pixels := image.NewNRGBA(image.Rect(0, 0, 1, 1))
	pixels.SetNRGBA(0, 0, color.NRGBA{R: 255, A: 64})
	if err := png.Encode(&encoded, pixels); err != nil {
		t.Fatal(err)
	}
	imageBytes := encoded.Bytes()
	for _, tc := range []struct {
		name, model, mode string
		transparent, b64  bool
	}{
		{name: "4.0", model: "seedream-4-0-250828"},
		{name: "4.5", model: "seedream-4-5-251128"},
		{name: "Lite", model: "seedream-5-0-260128"},
		{name: "Pro", model: "dola-seedream-5-0-pro-260628"},
		{name: "Flash", model: "dola-seedream-5-0-flash-260915"},
		{name: "Pro transparent", model: "doubao-seedream-5-0-pro-260628", transparent: true},
		{name: "Flash transparent", model: "doubao-seedream-5-0-flash-260915", transparent: true},
		{name: "Pro layers", model: "doubao-seedream-5-0-pro-260628", mode: "layers"},
		{name: "Flash layers", model: "doubao-seedream-5-0-flash-260915", mode: "layers"},
		{name: "old Base64 response", model: "seedream-5-0-260128", b64: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			posts, downloads := 0, 0
			cdn := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				downloads++
				if r.Header.Get("Authorization") != "" {
					t.Error("CDN received provider Authorization")
				}
				w.Header().Set("Content-Type", "image/png")
				_, _ = w.Write(imageBytes)
			}))
			defer cdn.Close()
			var provider *httptest.Server
			provider = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet && r.URL.Path == "/v1/images/proxy" {
					http.Redirect(w, r, cdn.URL+"/original.png?signature=synthetic", http.StatusFound)
					return
				}
				if r.Method != http.MethodPost || r.URL.Path != "/v1/images/generations" {
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
					return
				}
				posts++
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				if body["response_format"] != "url" || body["model"] != tc.model || body["stream"] != nil {
					t.Errorf("wrong Seedream request: %#v", body)
				}
				if tc.transparent && (body["background"] != "transparent" || body["output_format"] != "png") {
					t.Error("transparent PNG options lost")
				}
				if tc.mode == "layers" && body["layer_decomposition"] != true {
					t.Error("layer decomposition option lost")
				}
				item := map[string]any{"url": provider.URL + "/v1/images/proxy?t=synthetic"}
				if tc.b64 {
					item = map[string]any{"b64_json": base64.StdEncoding.EncodeToString(imageBytes)}
				}
				items := []map[string]any{item}
				if tc.mode == "layers" {
					item["z_index"], item["name"], item["bounding_box"] = 3, "foreground", []int{0, 0, 1, 1}
					items = append(items, map[string]any{"url": provider.URL + "/v1/images/proxy?t=second", "z_index": 1, "name": "background"})
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"data": items})
			}))
			defer provider.Close()
			input := generation.Input{Mode: "image", Prompt: "synthetic fixture", Config: generation.Config{
				BaseURL: provider.URL, APIKey: "synthetic-key", Model: tc.model, InterfaceType: "openai-image", Size: "2K", SeedreamMode: tc.mode,
			}}
			if tc.transparent || tc.mode == "layers" {
				input.ReferenceImages = []generation.Media{{URL: cdn.URL + "/reference.png"}}
			}
			if tc.transparent {
				input.Config.TransparentBackground = "true"
				input.Config.SeedreamOutputFormat = "jpeg"
			}
			result, err := generation.RunImageTask(context.Background(), input)
			if err != nil {
				t.Fatal(err)
			}
			wantImages := 1
			if tc.mode == "layers" {
				wantImages = 2
				layers := result["imageLayers"].([]map[string]any)
				if len(layers) != 2 || layers[0]["z_index"] != float64(3) || layers[0]["name"] != "foreground" || layers[1]["imageIndex"] != 1 {
					t.Fatalf("layer metadata lost: %#v", layers)
				}
			}
			if posts != 1 || (!tc.b64 && downloads != wantImages) || (tc.b64 && downloads != 0) {
				t.Fatalf("generation posts=%d, image downloads=%d", posts, downloads)
			}
			path, dataDir := filepath.Join(t.TempDir(), "workspace.db"), t.TempDir()
			svc, db := newGenerationDeliveryMediaService(t, path, dataDir)
			task := model.Task{ID: "original-seedream-task", UserID: "user-1"}
			stored, err := svc.persistTaskGeneratedMediaResult(task, result)
			if err != nil {
				closeDB(t, db)
				t.Fatal(err)
			}
			closeDB(t, db)
			svc, db = newGenerationDeliveryMediaService(t, path, dataDir)
			defer closeDB(t, db)
			items := stored["images"].([]interface{})
			if len(items) != wantImages {
				t.Fatalf("saved images=%d, want %d", len(items), wantImages)
			}
			for _, value := range items {
				item := value.(map[string]interface{})
				resource, err := svc.Resource(task.UserID, stringField(item, "resourceId"))
				if err != nil {
					t.Fatal(err)
				}
				actual, err := os.ReadFile(filepath.Join(dataDir, "resources", filepath.FromSlash(resource.ObjectKey)))
				if err != nil || !bytes.Equal(actual, imageBytes) || resource.MimeType != "image/png" {
					t.Fatalf("reopened image differs: bytes=%d mime=%q err=%v", len(actual), resource.MimeType, err)
				}
			}
		})
	}
}
