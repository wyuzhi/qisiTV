package generation

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/protocol"
)

func grokPluginRegistry(t *testing.T, packaged bool) *protocol.Registry {
	t.Helper()
	path := filepath.Join("..", "..", "..", "plugin-packages", "xai-grok-images", "manifest.json")
	if packaged {
		path = filepath.Join("..", "..", "..", "plugin-packages", "xai-grok-images.beeftv-plugin")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if packaged {
		pkg, err := protocol.ParsePluginPackage(raw)
		if err != nil {
			t.Fatal(err)
		}
		raw = pkg.ManifestRaw
	}
	adapters, err := protocol.LoadInstalledProviders(raw)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := protocol.NewRegistry(adapters...)
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func TestGrokImageSourcePackageAndStandaloneExecute(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, kind := range []string{"source", "package", "standalone"} {
		t.Run(kind, func(t *testing.T) {
			var posts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				posts.Add(1)
				if r.Method != http.MethodPost || r.URL.Path != "/v1/images/generations" || r.Header.Get("Authorization") != "Bearer fixture" {
					t.Errorf("request = %s %s", r.Method, r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"data":[{"b64_json":"iVBORw0KGgo="}]}`))
			}))
			t.Cleanup(server.Close)
			ctx := WithRuntime(context.Background(), taskRuntime())
			if kind != "standalone" {
				ctx = WithProtocolRegistry(ctx, grokPluginRegistry(t, kind == "package"))
			}
			input := Input{Mode: "image", Prompt: "draw", Config: Config{InterfaceType: "grok-image", Model: "unknown-future-model", BaseURL: server.URL, APIKey: "fixture"}}
			result, err := Execute(ctx, input)
			if err != nil || posts.Load() != 1 || result["mode"] != "image" {
				t.Fatalf("posts=%d result=%#v err=%v", posts.Load(), result, err)
			}
			images := result["images"].([]any)
			if len(images) != 1 || images[0].(map[string]any)["dataUrl"] != "data:image/png;base64,iVBORw0KGgo=" {
				t.Fatalf("image result=%#v", result)
			}
		})
	}
}

func TestGrokImageUnavailableRegistryNeverFallsBack(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, kind := range []string{"empty", "disabled", "host"} {
		for _, resumed := range []bool{false, true} {
			t.Run(kind+map[bool]string{false: "/new", true: "/resumed"}[resumed], func(t *testing.T) {
				registry, _ := protocol.NewRegistry()
				if kind != "empty" {
					adapter, _ := grokPluginRegistry(t, false).Resolve("grok-image")
					info := adapter.Metadata()
					if kind == "disabled" {
						info.Enabled = false
					} else {
						info.Execution = "host"
					}
					if err := registry.Register(protocol.UnavailableAdapter{Info: info}); err != nil {
						t.Fatal(err)
					}
				}
				var posts atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { posts.Add(1) }))
				t.Cleanup(server.Close)
				runtime := taskRuntime()
				if resumed {
					runtime.Call.ProviderRequestID = "original-task"
				}
				ctx := WithProtocolRegistry(WithRuntime(context.Background(), runtime), registry)
				input := Input{Mode: "image", Prompt: "draw", Config: Config{InterfaceType: "grok-image", Model: "unknown", BaseURL: server.URL, APIKey: "fixture"}}
				for _, run := range []func(context.Context, Input) (map[string]any, error){RunImageTask, Execute} {
					result, err := run(ctx, input)
					if err == nil || result != nil || posts.Load() != 0 {
						t.Fatalf("posts=%d result=%#v err=%v", posts.Load(), result, err)
					}
					var preparation RequestPreparationError
					if errors.As(err, &preparation) == resumed {
						t.Fatalf("wrong submission evidence: resumed=%v err=%v", resumed, err)
					}
				}
			})
		}
	}
}

func TestGrokImageInstalledResumeNeverCreatesAgain(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests.Add(1) }))
	t.Cleanup(server.Close)
	runtime := taskRuntime()
	runtime.Call.ProviderRequestID = "original-task"
	ctx := WithProtocolRegistry(WithRuntime(context.Background(), runtime), grokPluginRegistry(t, false))
	result, err := Execute(ctx, Input{Mode: "image", Prompt: "draw", Config: Config{InterfaceType: "grok-image", Model: "unknown", BaseURL: server.URL, APIKey: "fixture"}})
	var preparation RequestPreparationError
	if err == nil || result != nil || requests.Load() != 0 || errors.As(err, &preparation) || ResumedProviderRequestID(ctx) != "original-task" {
		t.Fatalf("resume: requests=%d result=%#v err=%v", requests.Load(), result, err)
	}
}

func TestGrokImagePluginFailuresRemainFailures(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, kind := range []string{"http-rejection", "business-rejection", "empty-output", "cancelled", "deadline", "invalid-ratio", "blocked-outbound"} {
		t.Run(kind, func(t *testing.T) {
			var posts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				posts.Add(1)
				w.Header().Set("Content-Type", "application/json")
				if kind == "http-rejection" {
					w.WriteHeader(http.StatusForbidden)
				}
				body := `{"data":[]}`
				if kind == "http-rejection" || kind == "business-rejection" {
					body = `{"error":{"code":"invalid_request","message":"fixture rejection"}}`
				}
				_, _ = w.Write([]byte(body))
			}))
			t.Cleanup(server.Close)
			ctx := WithProtocolRegistry(WithRuntime(context.Background(), taskRuntime()), grokPluginRegistry(t, false))
			input := Input{Mode: "image", Prompt: "draw", Config: Config{InterfaceType: "grok-image", Model: "unknown", BaseURL: server.URL, APIKey: "fixture"}}
			wantPosts := int32(1)
			if kind == "cancelled" || kind == "deadline" {
				var cancel context.CancelFunc
				if kind == "cancelled" {
					ctx, cancel = context.WithCancel(ctx)
				} else {
					ctx, cancel = context.WithTimeout(ctx, 0)
				}
				cancel()
				wantPosts = 0
			}
			if kind == "invalid-ratio" {
				// Preserve the installed plugin's error for malformed dimensions;
				// changing its expression evaluator is outside this migration.
				input.Config.Size, wantPosts = "bad", 0
			}
			if kind == "blocked-outbound" {
				input.Config.BaseURL, wantPosts = "http://169.254.169.254", 0
			}
			result, err := Execute(ctx, input)
			if err == nil || result != nil || posts.Load() != wantPosts {
				t.Fatalf("posts=%d result=%#v err=%v", posts.Load(), result, err)
			}
			if kind == "cancelled" && !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation lost: %v", err)
			}
			if kind == "deadline" && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("deadline lost: %v", err)
			}
			if kind == "http-rejection" {
				var upstream HTTPError
				if !errors.As(err, &upstream) || upstream.StatusCode != http.StatusForbidden {
					t.Fatalf("upstream evidence lost: %v", err)
				}
			}
		})
	}
}

func TestGrokImageManagedConnectionRetainsPriority(t *testing.T) {
	registry, _ := protocol.NewRegistry()
	ctx := WithProtocolRegistry(context.Background(), registry)
	_, err := RunImageTask(ctx, Input{Mode: "image", Config: Config{CredentialRef: beeftv.CredentialRef, InterfaceType: "grok-image", Model: "grok-imagine-image"}})
	if err == nil || !strings.Contains(err.Error(), "持久化提交标识") {
		t.Fatalf("managed image must reach its own persistence guard before Grok routing: %v", err)
	}
}
