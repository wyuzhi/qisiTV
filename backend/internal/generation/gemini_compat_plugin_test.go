package generation

import (
	"context"
	"encoding/json"
	"testing"

	"qisitv/backend/internal/protocol"
)

// Gemini 的 OpenAI 兼容接口在 /v1beta/openai 下，而共用拼址只会补 /v1；
// 插件把版本与 /openai 一起写进请求路径，填光域名或填到 /v1beta 都要得到同一个地址。
func TestGeminiOpenAICompatPluginRequestsVersionedPath(t *testing.T) {
	registry := LoadOfficialFallbackRegistry()
	if registry == nil {
		t.Fatal("LoadOfficialFallbackRegistry returned nil")
	}
	adapter, ok := registry.Resolve("gemini-openai-compat")
	if !ok {
		t.Fatal("gemini-openai-compat plugin is not installed")
	}
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: protocol.GenerationRequest{
		Capability: protocol.CapabilityText, Model: "gemini-2.5-flash", Prompt: "一句话故事",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Path != "/openai/chat/completions" || spec.DefaultPathPrefix != "/v1beta" {
		t.Fatalf("path = %q, prefix = %q", spec.Path, spec.DefaultPathPrefix)
	}
	// 参数按当前接口格式的 ID 命名空间传入；插件要读自己的那一份，否则设置里的参数会被悄悄丢掉。
	withOptions, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: protocol.GenerationRequest{
		Capability: protocol.CapabilityText, Model: "gemini-2.5-flash", Prompt: "一句话故事",
		ProviderOptions: map[string]map[string]any{"gemini-openai-compat": {"temperature": 0.7, "top_p": 0.9}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(withOptions.Body)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(encoded, &body); err != nil {
		t.Fatal(err)
	}
	if body["temperature"] != 0.7 || body["top_p"] != 0.9 {
		t.Fatalf("provider options were dropped: %s", encoded)
	}
	for _, base := range []string{"https://generativelanguage.googleapis.com", "https://generativelanguage.googleapis.com/v1beta", "https://generativelanguage.googleapis.com/", "https://generativelanguage.googleapis.com/v1beta/openai"} {
		url, err := ProtocolRequestURL(base, spec)
		if err != nil {
			t.Fatal(err)
		}
		if want := "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"; url != want {
			t.Fatalf("ProtocolRequestURL(%q) = %q, want %q", base, url, want)
		}
	}
}
