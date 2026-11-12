package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"qisitv/backend/internal/protocol"
)

type protocolUploadTestResources struct {
	ResourcePort
	files map[string][]byte
}

func (r protocolUploadTestResources) Lookup(_ string, resourceID string) (ResourceInfo, error) {
	data := r.files[resourceID]
	return ResourceInfo{
		ID:       resourceID,
		Status:   "ready",
		MimeType: "image/png",
		Size:     int64(len(data)),
	}, nil
}

func (r protocolUploadTestResources) LocalMode() bool {
	return true
}

func (r protocolUploadTestResources) Open(_ string, resourceID string) (ResourceInfo, io.ReadCloser, error) {
	data := r.files[resourceID]
	return ResourceInfo{
		ID:       resourceID,
		Status:   "ready",
		MimeType: "image/png",
		Size:     int64(len(data)),
	}, io.NopCloser(bytes.NewReader(data)), nil
}

func TestProtocolMediaUploadTargetUsesManifestUploadURLForConfiguredVendor(t *testing.T) {
	if !useManifestUploadURL("https://tokenhub.ysdui.cn", "https://tokenhub.ysdui.cn", "https://ysdui.cn/api/file/v1/upload") {
		t.Fatal("expected tokenhub.ysdui.cn to route uploads to ysdui.cn")
	}
	if !useManifestUploadURL("https://ysdui.cn", "https://tokenhub.ysdui.cn", "https://ysdui.cn/api/file/v1/upload") {
		t.Fatal("expected ysdui.cn to route uploads to ysdui.cn")
	}
	if useManifestUploadURL("http://127.0.0.1:18080", "https://tokenhub.ysdui.cn", "https://ysdui.cn/api/file/v1/upload") {
		t.Fatal("expected local test server to keep its own origin")
	}
	if useManifestUploadURL("https://tokenhub.ysdui.cn", "https://tokenhub.ysdui.cn", "https://127.0.0.1:8443/api/file/v1/upload") {
		t.Fatal("expected loopback upload URL to be rejected even when config matches manifest base")
	}
	if useManifestUploadURL("https://tokenhub.ysdui.cn", "https://tokenhub.ysdui.cn", "https://evil.example.com/api/file/v1/upload") {
		t.Fatal("expected unrelated upload domain to be rejected even when config matches manifest base")
	}
}

func TestYSDUIMediaUploadRejectsCorruptImageAndOversizeMediaBeforeUpload(t *testing.T) {
	ctx := context.Background()
	input := Input{
		Mode:   "image",
		Prompt: "图生图",
		Config: Config{
			InterfaceType: "ysdui-image",
			BaseURL:       "http://127.0.0.1:18080",
			APIKey:        "sk-ysdui-test",
			Model:         "doubao-seedream-5-0-260128",
		},
		ReferenceImages: []Media{
			{DataURL: DataURL("image/png", []byte("not-a-valid-png"))},
		},
	}
	err := prepareProtocolMediaUploads(ctx, "user-1", &input)
	if err == nil {
		t.Fatal("expected invalid image bytes to fail before upload")
	}
	var prepErr RequestPreparationError
	if !errors.As(err, &prepErr) {
		t.Fatalf("expected RequestPreparationError, got %T: %v", err, err)
	}

	oversizeInput := input
	oversizeInput.ReferenceImages = []Media{
		{DataURL: "data:image/png;base64,iVBORw0KGgo=", Bytes: 25 << 20},
	}
	if err := prepareProtocolMediaUploads(ctx, "user-1", &oversizeInput); err == nil || !strings.Contains(err.Error(), "大小限制") {
		t.Fatalf("expected oversize media error, got %v", err)
	}
}

func TestYSDUIMediaUploadPreuploadsLocalAndInlineReferencesBeforeCreate(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	pngBytes := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde")

	var uploadCalls int
	var createPath string
	var createBody map[string]any

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer sk-ysdui-test" {
			t.Errorf("Authorization = %q, want Bearer sk-ysdui-test", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/file/v1/upload":
			uploadCalls++
			if err := r.ParseMultipartForm(4 << 20); err != nil {
				t.Fatalf("ParseMultipartForm failed: %v", err)
			}
			file, _, err := r.FormFile("file")
			if err != nil {
				t.Fatalf("missing multipart field file: %v", err)
			}
			defer file.Close()
			gotBytes, _ := io.ReadAll(file)
			if !bytes.Equal(gotBytes, pngBytes) {
				t.Fatalf("uploaded bytes mismatch: got %d bytes, want %d", len(gotBytes), len(pngBytes))
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":    200,
				"message": "success",
				"data":    "https://temp-1449236305.cos.ap-guangzhou.myqcloud.com/2026/11/10/uploaded-" + strings.Repeat("a", uploadCalls) + ".png",
			})
		case "/v1/images/generations":
			createPath = r.URL.Path
			_ = json.NewDecoder(r.Body).Decode(&createBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{"b64_json": DataURL("image/png", pngBytes)},
				},
			})
		case "/v1/video/generations":
			createPath = r.URL.Path
			_ = json.NewDecoder(r.Body).Decode(&createBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": "success",
				"data": map[string]any{
					"task_id": "cgt-ysdui-video-1",
					"status":  "succeeded",
					"content": map[string]any{
						"video_url": server.URL + "/output.mp4",
					},
				},
			})
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	ctx := WithRuntime(context.Background(), Runtime{
		Resources: protocolUploadTestResources{
			files: map[string][]byte{"owned-1": pngBytes},
		},
	})

	imageInput := Input{
		Mode:   "image",
		Prompt: "把参考图改成水彩风格",
		Config: Config{
			InterfaceType: "ysdui-image",
			BaseURL:       server.URL,
			APIKey:        "sk-ysdui-test",
			Model:         "doubao-seedream-5-0-260128",
			Size:          "1:1",
		},
		ReferenceImages: []Media{
			{StorageKey: "resource:owned-1"},
			{DataURL: DataURL("image/png", pngBytes)},
		},
	}
	policy := MediaHydrationPolicyFor(ctx, imageInput)
	if !policy.KeepLocal {
		t.Fatal("expected MediaHydrationPolicyFor(ysdui-image) to set KeepLocal=true")
	}
	if err := HydrateMedia(ctx, "user-1", &imageInput, policy); err != nil {
		t.Fatalf("HydrateMedia failed: %v", err)
	}
	if err := prepareProtocolMediaUploads(ctx, "user-1", &imageInput); err != nil {
		t.Fatalf("prepareProtocolMediaUploads failed: %v", err)
	}
	if uploadCalls != 2 {
		t.Fatalf("uploadCalls = %d, want 2", uploadCalls)
	}
	imageAdapter, ok := ProtocolAdapterForContext(EnsureOfficialProtocolAdapter(ctx, "ysdui-image"), "ysdui-image")
	if !ok {
		t.Fatal("ysdui-image adapter not registered")
	}
	if _, err := RunProtocolAdapterTask(ctx, imageInput, imageAdapter); err != nil {
		t.Fatalf("RunProtocolAdapterTask(ysdui-image) failed: %v", err)
	}
	if createPath != "/v1/images/generations" {
		t.Fatalf("createPath = %q, want /v1/images/generations", createPath)
	}
	images, _ := createBody["images"].([]any)
	if len(images) != 2 {
		t.Fatalf("images = %#v, want 2 uploaded URLs", createBody["images"])
	}
	for i, item := range images {
		str, _ := item.(string)
		if !strings.HasPrefix(str, "https://temp-1449236305.cos.ap-guangzhou.myqcloud.com/") {
			t.Fatalf("images[%d] = %q, want uploaded ysdui COS URL", i, str)
		}
	}

	uploadCalls = 0
	createBody = nil
	videoInput := Input{
		Mode:   "video",
		Prompt: "让画面动起来",
		Config: Config{
			InterfaceType: "ysdui-video",
			BaseURL:       server.URL,
			APIKey:        "sk-ysdui-test",
			Model:         "wan3.0-video",
			Size:          "16:9",
			VQuality:      "720P",
			VideoSeconds:  "5",
		},
		ReferenceImages: []Media{
			{DataURL: DataURL("image/png", pngBytes)},
		},
	}
	if err := prepareProtocolMediaUploads(ctx, "user-1", &videoInput); err != nil {
		t.Fatalf("prepareProtocolMediaUploads(ysdui-video) failed: %v", err)
	}
	if uploadCalls != 1 {
		t.Fatalf("video uploadCalls = %d, want 1", uploadCalls)
	}
	adapter, ok := ProtocolAdapterForContext(EnsureOfficialProtocolAdapter(ctx, "ysdui-video"), "ysdui-video")
	if !ok {
		t.Fatal("ysdui-video adapter not registered")
	}
	spec, err := adapter.BuildCreate(ctx, protocol.RequestContext{BaseURL: videoInput.Config.BaseURL, Request: ProtocolRequestFor(videoInput, adapter)})
	if err != nil {
		t.Fatalf("BuildCreate(ysdui-video) failed: %v", err)
	}
	bodyMap, _ := spec.Body.(map[string]any)
	content, _ := bodyMap["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("content = %#v, want 1 item", bodyMap["content"])
	}
	firstItem, _ := content[0].(map[string]any)
	if firstItem["role"] != "first_frame" {
		t.Fatalf("content[0].role = %v, want first_frame", firstItem["role"])
	}
	imgURL, _ := firstItem["image_url"].(map[string]any)
	if !strings.HasPrefix(imgURL["url"].(string), "https://temp-1449236305.cos.ap-guangzhou.myqcloud.com/") {
		t.Fatalf("content[0].image_url.url = %v, want uploaded ysdui COS URL", imgURL["url"])
	}
}

func TestYSDUIMediaUploadFailureStopsInPreparationBeforeCreate(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	pngBytes := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde")

	createCalled := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/file/v1/upload" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":    500,
				"message": "文件服务暂不可用",
			})
			return
		}
		createCalled = true
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	input := Input{
		Mode:   "image",
		Prompt: "图生图测试",
		Config: Config{
			InterfaceType: "ysdui-image-task",
			BaseURL:       server.URL,
			APIKey:        "sk-ysdui-test",
			Model:         "wand-vega-image-flash",
		},
		ReferenceImages: []Media{
			{DataURL: DataURL("image/png", pngBytes)},
		},
	}
	ctx := EnsureOfficialProtocolAdapter(context.Background(), "ysdui-image-task")
	_, err := RunDeclarativeProtocolTask(ctx, input)
	if err == nil {
		t.Fatal("expected upload error to stop execution")
	}
	var prepErr RequestPreparationError
	if !errors.As(err, &prepErr) {
		t.Fatalf("expected RequestPreparationError, got %T: %v", err, err)
	}
	if createCalled {
		t.Fatal("generation create endpoint must not be called when reference upload fails")
	}
}
