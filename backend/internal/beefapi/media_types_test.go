package beefapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestManagedMediaTypesResumeOnlyOriginalQuery(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, item := range []struct{ kind, output string }{{"video", "video"}, {"audio", "audio"}, {"upscale", "image"}, {"upscale", "video"}} {
		t.Run(item.kind+"/"+item.output, func(t *testing.T) {
			gets, projects := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gets++
				if r.Method != http.MethodGet || r.URL.Path != "/v1/media/tasks/original" || r.URL.Query().Get("media_type") != item.kind {
					t.Errorf("unexpected %s %s", r.Method, r.URL)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"task_ref": "original", "media_type": item.kind, "status": "completed", "outputs": []any{map[string]any{"kind": item.output, "url": "https://127.0.0.1/owned", "metadata": map[string]any{"dataUrl": "must-not-override", "storageKey": "must-not-override"}}}, "billing_state": "precharged", "usage_state": "reserved", "charged_quota": 0})
			}))
			defer server.Close()
			client := &MediaClient{BaseURL: server.URL, AllowHTTPTest: true, State: &mediaMemoryFence{sent: true}, Project: func(_ context.Context, task MediaTask) {
				projects++
				if task.BillingState == nil || *task.BillingState != "precharged" || task.ChargedQuota == nil || *task.ChargedQuota != 0 || task.UsageState == nil || *task.UsageState != "reserved" {
					t.Error("billing projection changed")
				}
			}}
			result, err := client.Execute(context.Background(), MediaRequest{TaskRef: "original", MediaType: item.kind}, []LocalMediaReference{{StorageKey: "deleted"}})
			if err != nil || result["mode"] != item.output || gets != 1 || projects != 1 {
				t.Fatalf("result=%#v err=%v gets=%d projects=%d", result, err, gets, projects)
			}
		})
	}
}

func TestManagedUpscaleResumeRejectsResultOfDifferentSourceKind(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Error("unexpected create")
		}
		_ = json.NewEncoder(w).Encode(MediaTask{TaskRef: "original", MediaType: "upscale", Status: "completed", Outputs: []MediaOutput{{Kind: "video", URL: "https://127.0.0.1/owned"}}})
	}))
	defer server.Close()
	client := &MediaClient{BaseURL: server.URL, AllowHTTPTest: true, State: &mediaMemoryFence{sent: true}, ExpectedOutputKind: "image"}
	if _, err := client.Execute(context.Background(), MediaRequest{TaskRef: "original", MediaType: "upscale"}, nil); err == nil || !strings.Contains(err.Error(), "原素材类型") {
		t.Fatalf("err=%v", err)
	}
}

func TestManagedMediaRejectsUnadvertisedTypeBeforePost(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, kind := range []string{"video", "upscale", "audio"} {
		t.Run(kind, func(t *testing.T) {
			posts := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/v1/models" {
					posts++
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
				}
				writeMediaDiscovery(w) // Only image is advertised.
			}))
			defer server.Close()
			fence := &mediaMemoryFence{}
			client := &MediaClient{BaseURL: server.URL, AllowHTTPTest: true, State: fence}
			if _, err := client.Execute(context.Background(), MediaRequest{TaskRef: "new", MediaType: kind}, nil); err == nil || posts != 0 || fence.sent {
				t.Fatalf("posts=%d sent=%v err=%v", posts, fence.sent, err)
			}
		})
	}
}
