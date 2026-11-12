package generation

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// 文本任务只打一个地址：按接口格式选好路径，不再先试 Responses、失败再换 Chat Completions。
func TestRunTextTaskSendsOneRequestPerInterface(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var mu sync.Mutex
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/chat/completions"):
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"chat"}}]}`)
		case strings.HasSuffix(r.URL.Path, "/responses"):
			_, _ = io.WriteString(w, `{"output_text":"responses"}`)
		case strings.HasSuffix(r.URL.Path, "/messages"):
			_, _ = io.WriteString(w, `{"content":[{"type":"text","text":"claude"}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	cases := []struct {
		name, interfaceType, apiFormat, wantPath, wantText string
	}{
		{"saved without an interface runs chat completions", "", "openai", "/v1/chat/completions", "chat"},
		{"claude channel without an interface runs messages", "", "claude", "/v1/messages", "claude"},
		{"responses", "openai-response", "openai", "/v1/responses", "responses"},
		{"claude alias runs the claude interface", "anthropic-messages", "claude", "/v1/messages", "claude"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mu.Lock()
			paths = nil
			mu.Unlock()
			result, err := RunTextTask(context.Background(), Input{
				Mode: "text", Prompt: "hello",
				Config: Config{BaseURL: server.URL, APIKey: "key", Model: "m", InterfaceType: tc.interfaceType, APIFormat: tc.apiFormat},
			})
			if err != nil {
				t.Fatal(err)
			}
			if result["text"] != tc.wantText {
				t.Fatalf("text = %#v", result["text"])
			}
			mu.Lock()
			defer mu.Unlock()
			if len(paths) != 1 || paths[0] != tc.wantPath {
				t.Fatalf("requests = %v, want exactly %s", paths, tc.wantPath)
			}
		})
	}
}

func TestRunTextTaskRejectsUnknownInterfaceWithoutCallingUpstream(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	for _, id := range []string{"no-such-interface", "openai-image"} {
		_, err := RunTextTask(context.Background(), Input{
			Mode: "text", Prompt: "hello",
			Config: Config{BaseURL: server.URL, APIKey: "key", Model: "m", InterfaceType: id},
		})
		if err == nil || !strings.Contains(err.Error(), "接口类型 "+id+" 未安装") {
			t.Fatalf("%s: err = %v", id, err)
		}
	}
	if called {
		t.Fatal("an unknown interface still reached the upstream")
	}
}
