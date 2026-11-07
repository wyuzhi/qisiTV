package generation

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"infinite-canvas/backend/internal/modelcatalog"
)

// 自建渠道的 seedance-videos-compatible 协议走手写 /videos 请求体。能力目录把声音
// 标成不支持时，节点上明确写入的 false 仍必须原样发出，不能退回上游默认开声音。
// 显式值优先；未设置时沿用能力判断的历史默认。
func TestSeedanceVideosBodyKeepsExplicitAndHistoricalAudioDefaults(t *testing.T) {
	for _, test := range []struct {
		name      string
		value     string
		supported bool
		want      *bool
	}{
		{name: "explicit false", value: "false", want: boolPtr(false)},
		{name: "explicit true", value: "true", want: boolPtr(true)},
		{name: "unset supported", supported: true, want: boolPtr(true)},
		{name: "unset unsupported"},
	} {
		t.Run(test.name, func(t *testing.T) {
			profile := &modelcatalog.VideoCapabilityConfig{GenerateAudio: modelcatalog.VideoBooleanConfig{Supported: test.supported}}
			body, err := SeedanceVideosRequestBody(Input{Mode: "video", Prompt: "move", Config: Config{Model: "seedance-2.0-fast", VideoGenerateAudio: test.value}, VideoCapability: profile})
			if err != nil {
				t.Fatal(err)
			}
			assertOptionalBool(t, body.GenerateAudio, test.want)
		})
	}
}

// Agent Plan 与 /videos 手写路径共用同一段声音默认逻辑。
func TestSeedanceAgentPlanBodyKeepsExplicitAndHistoricalAudioDefaults(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, test := range []struct {
		name      string
		value     string
		supported bool
		want      *bool
	}{
		{name: "explicit false", value: "false", want: boolPtr(false)},
		{name: "explicit true", value: "true", want: boolPtr(true)},
		{name: "unset supported", supported: true, want: boolPtr(true)},
		{name: "unset unsupported"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var posted map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodPost {
					if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
						t.Errorf("decode create body: %v", err)
					}
					_, _ = w.Write([]byte(`{"id":"task-1","status":"queued"}`))
					return
				}
				_, _ = w.Write([]byte(`{"id":"task-1","status":"failed","message":"stop"}`))
			}))
			defer server.Close()
			policy := DefaultVideoPollPolicy()
			policy.Sleep = func(context.Context, time.Duration) error { return nil }
			profile := &modelcatalog.VideoCapabilityConfig{GenerateAudio: modelcatalog.VideoBooleanConfig{Supported: test.supported}}
			input := Input{Mode: "video", Prompt: "move", Config: Config{
				BaseURL: server.URL + "/api/plan/v3", APIKey: "test-key", Model: "seedance-2.0-fast", VideoGenerateAudio: test.value,
			}, VideoCapability: profile}
			_, _ = RunSeedanceAgentPlanVideoTask(context.Background(), input, policy)
			got, ok := posted["generate_audio"]
			if test.want == nil {
				if ok {
					t.Fatalf("generate_audio should be omitted: %#v", posted)
				}
				return
			}
			if !ok || got != *test.want {
				t.Fatalf("generate_audio = %#v, want %v", got, *test.want)
			}
		})
	}
}

func boolPtr(value bool) *bool { return &value }

func assertOptionalBool(t *testing.T, got, want *bool) {
	t.Helper()
	if want == nil {
		if got != nil {
			t.Fatalf("field = %v, want omitted", *got)
		}
		return
	}
	if got == nil || *got != *want {
		t.Fatalf("field = %v, want %v", got, *want)
	}
}

func TestSeedanceVideosCompatibleAlwaysSendsExplicitGenerateAudio(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, value := range []string{"false", "true"} {
		t.Run(value, func(t *testing.T) {
			var posted map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodPost {
					if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
						t.Errorf("decode create body: %v", err)
					}
					_, _ = w.Write([]byte(`{"id":"task-1","status":"queued"}`))
					return
				}
				_, _ = w.Write([]byte(`{"id":"task-1","status":"failed","error":{"message":"stop"}}`))
			}))
			defer server.Close()

			policy := DefaultVideoPollPolicy()
			policy.Sleep = func(context.Context, time.Duration) error { return nil }
			input := Input{Mode: "video", Prompt: "move", Config: Config{
				BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "seedance-2.0-fast",
				InterfaceType: "seedance-videos-compatible", VideoGenerateAudio: value,
			}, VideoCapability: &modelcatalog.VideoCapabilityConfig{}}
			_, _ = RunSeedanceVideosTask(context.Background(), input, policy)
			got, ok := posted["generate_audio"]
			if !ok {
				t.Fatalf("explicit generateAudio=%s was omitted: %#v", value, posted)
			}
			want := value == "true"
			if got != want {
				t.Fatalf("generate_audio = %#v, want %v", got, want)
			}
		})
	}
}
