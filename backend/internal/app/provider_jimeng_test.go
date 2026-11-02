package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestVolcengineJiMengImageTaskUsesSignedAsyncProtocol(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Authorization"), "Credential=AKID/") {
			t.Fatalf("Authorization = %q", r.Header.Get("Authorization"))
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		switch r.URL.Query().Get("Action") {
		case "CVSync2AsyncSubmitTask":
			if body["req_key"] != "jimeng_seedream46_cvtob" || body["width"] != float64(1024) || body["height"] != float64(1024) {
				t.Fatalf("submit body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"code":10000,"message":"Success","data":{"task_id":"task-1"}}`))
		case "CVSync2AsyncGetResult":
			if body["task_id"] != "task-1" || body["req_json"] == "" {
				t.Fatalf("poll body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"code":10000,"message":"Success","data":{"status":"done","binary_data_base64":["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="]}}`))
		default:
			http.Error(w, "unexpected action", http.StatusBadRequest)
		}
	}))
	defer server.Close()

	result, err := runImageTask(context.Background(), canvasGenerationInput{
		Mode:   "image",
		Prompt: "一张测试图片",
		Config: providerConfig{BaseURL: server.URL, APIKey: "AKID", SecretKey: "SECRET", Model: "jimeng_seedream46_cvtob", InterfaceType: "volcengine-jimeng-image", Size: "1024x1024"},
	})
	if err != nil {
		t.Fatalf("runVolcengineJiMengImageTask() error = %v", err)
	}
	images, ok := result["images"].([]interface{})
	if !ok || len(images) != 1 || !strings.HasPrefix(images[0].(map[string]interface{})["dataUrl"].(string), "data:image/png;base64,") {
		t.Fatalf("result = %#v", result)
	}
}
