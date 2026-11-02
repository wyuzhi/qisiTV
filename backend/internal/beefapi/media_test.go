package beefapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	_ "golang.org/x/image/webp"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type mediaMemoryFence struct {
	mu   sync.Mutex
	sent bool
}

func (f *mediaMemoryFence) Sent(context.Context) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sent, nil
}
func (f *mediaMemoryFence) Begin(*http.Request) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	previous := f.sent
	f.sent = true
	return previous, nil
}
func writeMediaDiscovery(w http.ResponseWriter) {
	w.Header().Set(MediaProtocolHeader, MediaProtocolVersion)
	_ = json.NewEncoder(w).Encode(map[string]any{"media_protocol": MediaDiscovery{Version: MediaProtocolVersion, SupportedMediaTypes: []string{"image"}, TaskSubmitURL: "/v1/media/tasks", TaskQueryURLTemplate: "/v1/media/tasks/{task_ref}", UploadsURL: "/v1/media/uploads"}})
}

func TestMediaQueryEscapesHistoricalKeyExactlyOnce(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	const ref = "old/key%value+tail?query"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/v1/media/tasks/old%2Fkey%25value+tail%3Fquery" || strings.TrimPrefix(r.URL.Path, "/v1/media/tasks/") != ref {
			t.Errorf("path=%s escaped=%s", r.URL.Path, r.URL.EscapedPath())
		}
		_ = json.NewEncoder(w).Encode(MediaTask{TaskRef: ref, MediaType: "image", Status: "unknown", Outputs: []MediaOutput{}})
	}))
	defer server.Close()
	_, err := (&MediaClient{BaseURL: server.URL, AllowHTTPTest: true}).Query(context.Background(), ref, "image")
	if err != nil {
		t.Fatal(err)
	}
}
func TestMediaDispatchedTaskNeverPostsAgain(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, mode := range []string{"429", "lost-response", "restart-deleted-reference"} {
		t.Run(mode, func(t *testing.T) {
			posts, gets, models, opened := 0, 0, 0, 0
			fence := &mediaMemoryFence{sent: mode == "restart-deleted-reference"}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer fixture" || r.Header.Get(MediaProtocolHeader) != MediaProtocolVersion {
					t.Error("API credential/protocol missing")
				}
				switch {
				case r.URL.Path == "/v1/models":
					models++
					writeMediaDiscovery(w)
				case r.Method == http.MethodPost:
					posts++
					if r.Header.Get("Idempotency-Key") != "stable-attempt" {
						t.Error("identity changed")
					}
					if mode == "lost-response" {
						connection, _, _ := w.(http.Hijacker).Hijack()
						_ = connection.Close()
						return
					}
					w.WriteHeader(429)
				case r.Method == http.MethodGet && r.URL.Path == "/v1/media/tasks/stable-attempt":
					gets++
					if gets == 1 {
						http.NotFound(w, r)
						return
					}
					_ = json.NewEncoder(w).Encode(MediaTask{TaskRef: "stable-attempt", MediaType: "image", Status: "completed", Outputs: []MediaOutput{{Kind: "image", URL: "https://127.0.0.1/image.png"}}})
				default:
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
				}
			}))
			defer server.Close()
			client := &MediaClient{BaseURL: server.URL, APIKey: "fixture", AllowHTTPTest: true, State: fence, Poll: func(context.Context) error { return nil }, Open: func(context.Context, string) (io.ReadCloser, string, int64, error) {
				opened++
				return nil, "", 0, errors.New("original file deleted")
			}}
			request := MediaRequest{TaskRef: "stable-attempt", MediaType: "image", Model: "unknown-model", Operation: "generate", Options: map[string]any{"response_format": "b64_json"}}
			refs := []LocalMediaReference(nil)
			if mode == "restart-deleted-reference" {
				refs = append(refs, LocalMediaReference{StorageKey: "resource:deleted"})
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			result, err := client.Execute(ctx, request, refs)
			wantPosts, wantModels := 1, 1
			if mode == "restart-deleted-reference" {
				wantPosts, wantModels = 0, 0
			}
			if err != nil || result == nil || posts != wantPosts || models != wantModels || gets != 2 || opened != 0 {
				t.Fatalf("err=%v posts=%d models=%d gets=%d opened=%d", err, posts, models, gets, opened)
			}
		})
	}
}
func TestMediaRequiresMatchingDiscoveryBeforeAnyWrite(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, header := range []string{"", "managed-media-v99"} {
		t.Run(header, func(t *testing.T) {
			writes, opens := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					writes++
				}
				w.Header().Set(MediaProtocolHeader, header)
				_ = json.NewEncoder(w).Encode(map[string]any{"media_protocol": MediaDiscovery{Version: MediaProtocolVersion}})
			}))
			defer server.Close()
			client := &MediaClient{BaseURL: server.URL, AllowHTTPTest: true, State: &mediaMemoryFence{}, Open: func(context.Context, string) (io.ReadCloser, string, int64, error) {
				opens++
				return nil, "", 0, errors.New("must not open")
			}}
			_, err := client.Execute(context.Background(), MediaRequest{TaskRef: "new", MediaType: "image"}, []LocalMediaReference{{StorageKey: "resource:x"}})
			if err == nil || writes != 0 || opens != 0 {
				t.Fatalf("err=%v writes=%d opens=%d", err, writes, opens)
			}
		})
	}
}
func TestHistoricalMediaReceiptPreservesMIMEOrderLayersUsageAndNoCredentials(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var jpegBytes bytes.Buffer
	if err := jpeg.Encode(&jpegBytes, image.NewRGBA(image.Rect(0, 0, 1, 1)), nil); err != nil {
		t.Fatal(err)
	}
	webp, err := os.ReadFile("testdata/managed-media/receipt.webp")
	if err != nil {
		t.Fatal(err)
	}
	if _, format, err := image.DecodeConfig(bytes.NewReader(webp)); err != nil || format != "webp" {
		t.Fatalf("invalid real WebP fixture: %v %s", err, format)
	}
	items := []map[string]any{{"b64_json": base64.StdEncoding.EncodeToString(jpegBytes.Bytes()), "z_index": 2, "bounding_box": []int{1, 2, 3, 4}, "name": "first", "description": "kept", "size": "1x1", "output_format": "jpeg"}, {"b64_json": base64.StdEncoding.EncodeToString(webp), "z_index": 3, "name": "second"}}
	storageGets := 0
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		storageGets++
		for _, key := range []string{"Authorization", "Cookie", "X-Private-Provider", "X-Api-Key"} {
			if r.Header.Get(key) != "" {
				t.Errorf("storage leaked %s", key)
			}
		}
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "/receipt", 302)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": items, "usage": map[string]any{"tokens": 9}, "created": 17})
	}))
	defer storage.Close()
	client := &MediaClient{APIKey: "secret", Headers: http.Header{"X-Private-Provider": []string{"private"}, "Cookie": []string{"secret"}}, AllowHTTPTest: true}
	task := MediaTask{TaskRef: "legacy-key", MediaType: "image", Status: "completed", ResultReceipt: &MediaReceipt{Format: "openai-image-response", URL: storage.URL + "/redirect", ExpiresAt: time.Now().Add(time.Minute).Unix()}}
	result, err := client.Result(context.Background(), task, true)
	if err != nil {
		t.Fatal(err)
	}
	images := result["images"].([]map[string]string)
	if len(images) != 2 || !strings.HasPrefix(images[0]["dataUrl"], "data:image/jpeg;") || !strings.HasPrefix(images[1]["dataUrl"], "data:image/webp;") {
		t.Fatalf("wrong MIME/order: %#v", images)
	}
	layers := result["imageLayers"].([]map[string]any)
	if layers[0]["name"] != "first" || layers[1]["imageIndex"] != 1 || layers[0]["description"] != "kept" || result["usage"].(map[string]any)["tokens"] != float64(9) || storageGets != 2 {
		t.Fatalf("metadata lost: %#v", result)
	}
	if _, err := client.Result(context.Background(), task, false); err == nil {
		t.Fatal("new task accepted legacy receipt")
	}
	if storageGets != 2 {
		t.Fatal("new task fetched historical receipt")
	}
}

func TestDetectMediaContentTypeSupportsTIFFAndISOImages(t *testing.T) {
	if got := detectMediaContentType([]byte{'I', 'I', '*', 0, 8, 0, 0, 0}); got != "image/tiff" {
		t.Fatalf("little-endian TIFF = %q, want image/tiff", got)
	}
	if got := detectMediaContentType([]byte{'M', 'M', 0, '*', 0, 0, 0, 8}); got != "image/tiff" {
		t.Fatalf("big-endian TIFF = %q, want image/tiff", got)
	}
	if got := detectMediaContentType([]byte{0, 0, 0, 28, 'f', 't', 'y', 'p', 'a', 'v', 'i', 'f'}); got != "image/avif" {
		t.Fatalf("AVIF = %q, want image/avif", got)
	}
	if got := detectMediaContentType([]byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 'h', 'e', 'i', 'c'}); got != "image/heic" {
		t.Fatalf("HEIC = %q, want image/heic", got)
	}
}

func TestConfirmUploadRetriesStalledControlAttempt(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	previousControl := uploadControlTimeout
	previousComplete := uploadCompleteTimeout
	uploadControlTimeout = 10 * time.Millisecond
	uploadCompleteTimeout = 120 * time.Millisecond
	defer func() {
		uploadControlTimeout = previousControl
		uploadCompleteTimeout = previousComplete
	}()

	var mu sync.Mutex
	attempts := 0
	unblock := make(chan struct{})
	var serverURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/media/uploads/complete" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		attempts++
		current := attempts
		mu.Unlock()
		if current == 1 {
			<-unblock
			return
		}
		time.Sleep(25 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(UploadedMedia{URL: serverURL + "/completed.png", Kind: "image", Mime: "image/png", Bytes: 4, SHA256: "deadbeef"})
	}))
	defer server.Close()
	defer close(unblock)
	serverURL = server.URL

	client := &MediaClient{BaseURL: server.URL, APIKey: "fixture", AllowHTTPTest: true}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	uploaded, err := client.confirmUpload(ctx, "ticket-1")
	if err != nil {
		t.Fatalf("confirmUpload failed: %v", err)
	}
	if uploaded.URL != server.URL+"/completed.png" || attempts != 2 {
		t.Fatalf("uploaded=%+v attempts=%d", uploaded, attempts)
	}
}
