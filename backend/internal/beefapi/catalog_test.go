package beefapi

import (
	"testing"

	"qisitv/backend/internal/workspace"
)

func TestCatalogCapabilityMapsBeefAPIEndpointTypes(t *testing.T) {
	cases := []struct {
		id        string
		modelType string
		endpoints []string
		wantCap   string
		wantProto string
	}{
		{endpoints: []string{"openai"}, wantCap: "text", wantProto: "chat-completion"},
		{endpoints: []string{"openai-response"}, wantCap: "text", wantProto: "openai-response"},
		{endpoints: []string{"openai-response-compact"}, wantCap: "text", wantProto: "openai-response"},
		{endpoints: []string{"anthropic"}, wantCap: "text", wantProto: "claude-api"},
		{endpoints: []string{"gemini"}, wantCap: "text", wantProto: "google-gemini-generate-content"},
		{endpoints: []string{"image-generation"}, wantCap: "image", wantProto: "openai-image"},
		{endpoints: []string{"openai-video"}, wantCap: "video", wantProto: "openai-videos"},
		{endpoints: []string{"openai", "image-generation"}, wantCap: "image", wantProto: "openai-image"},
		{id: "gpt-5.6-sol", endpoints: []string{"openai"}, wantCap: "text", wantProto: "chat-completion"},
		{id: "minimax-speech-2.8-hd", endpoints: []string{"openai"}, wantCap: "audio", wantProto: "openai-audio"},
		{id: "minimax-speech-2.8-turbo", endpoints: []string{"openai"}, wantCap: "audio", wantProto: "openai-audio"},
		{id: "minimax-music-v3.0", endpoints: []string{"openai"}, wantCap: "audio", wantProto: "openai-audio"},
		{id: "minimax-speech-2.8-hd", endpoints: []string{"audio.speech"}, wantCap: "audio", wantProto: "openai-audio"},
		{id: "hy-asr-3.0-preview", endpoints: []string{"openai"}, wantCap: "", wantProto: ""},
		{id: "hy-asr-3.0-preview", endpoints: []string{"audio.transcriptions"}, wantCap: "", wantProto: ""},
		{id: "gpt-image-2", endpoints: []string{"image-generation"}, wantCap: "image", wantProto: "openai-image"},
		{id: "seedance-2.0", endpoints: []string{"openai-video"}, wantCap: "video", wantProto: "openai-videos"},
		{id: "explicit-image", modelType: "image", endpoints: []string{"openai"}, wantCap: "image", wantProto: "openai-image"},
		{id: "explicit-video", modelType: "video", endpoints: []string{"openai"}, wantCap: "video", wantProto: "openai-videos"},
		{id: "speech-chat", modelType: "text", endpoints: []string{"openai"}, wantCap: "text", wantProto: "chat-completion"},
		{id: "speech-image", modelType: "image", endpoints: []string{"openai"}, wantCap: "image", wantProto: "openai-image"},
		{id: "classr-model", endpoints: []string{"openai"}, wantCap: "text", wantProto: "chat-completion"},
		{id: "speechify-bot", endpoints: []string{"openai"}, wantCap: "text", wantProto: "chat-completion"},
	}
	for _, test := range cases {
		capability, protocol := catalogCapabilityAndProtocol(CatalogModel{ID: test.id, ModelType: test.modelType, SupportedEndpointTypes: test.endpoints})
		if capability != test.wantCap || protocol != test.wantProto {
			t.Fatalf("%s %v -> capability=%q protocol=%q, want %q %q", test.id, test.endpoints, capability, protocol, test.wantCap, test.wantProto)
		}
	}
}

func TestApplyCatalogReplacesModelsOnAccountSwitch(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first := []CatalogModel{{ID: "model-a", SupportedEndpointTypes: []string{"image-generation"}}, {ID: "model-b", SupportedEndpointTypes: []string{"openai-video"}}}
	if err := applyCatalog(store, first, "", "42"); err != nil {
		t.Fatal(err)
	}
	second := []CatalogModel{{ID: "model-b", SupportedEndpointTypes: []string{"openai-video"}}, {ID: "model-c", SupportedEndpointTypes: []string{"openai"}}}
	if err := applyCatalog(store, second, "42", "99"); err != nil {
		t.Fatal(err)
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	channel := findChannel(effective.Config["channels"].([]any), ChannelID)
	ids := map[string]bool{}
	switch models := channel["models"].(type) {
	case []any:
		for _, item := range models {
			ids[item.(string)] = true
		}
	case []string:
		for _, item := range models {
			ids[item] = true
		}
	}
	if ids["model-a"] || !ids["model-b"] || !ids["model-c"] {
		t.Fatalf("account switch merged stale models: %#v", channel["models"])
	}
	profiles, _ := channel["modelProfiles"].([]any)
	foundProtocol := false
	for _, raw := range profiles {
		profile, _ := raw.(map[string]any)
		if profile["model"] == "model-c" && profile["capability"] == "text" && profile["protocol"] == "chat-completion" {
			foundProtocol = true
		}
	}
	if !foundProtocol {
		t.Fatalf("missing mapped protocol: %#v", profiles)
	}
}
