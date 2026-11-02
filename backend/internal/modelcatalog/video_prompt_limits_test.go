package modelcatalog

import (
	"encoding/json"
	"strings"
	"testing"

	"qisitv/backend/internal/model"
)

func TestVideoPromptDefaultsDoNotInventLocalCeilings(t *testing.T) {
	for _, tc := range []struct {
		protocol, name string
	}{
		{"full-video", "sd-native-full-2.5"},
		{"openai-videos", "sora-2-pro"},
		{"newapi", "custom-sora-2-pro"},
		{"minimax-video", "MiniMax-H3"},
		{"minimax-video", "MiniMax-Hailuo-2.3"},
		{"dashscope-wan-video", "wan3.0-t2v"},
		{"dashscope-wan-video", "wan2.7-i2v"},
		{"dashscope-wan-video", "wan2.6-t2v"},
		{"dashscope-wan-video", "wan2.1-t2v"},
		{"kling-video", "kling-v2"},
		{"luma-dream-machine", "ray-2"},
		{"pixverse-video", "v6-max"},
		{"zhipu-cogvideox", "cogvideox-3"},
		{"volcengine-jimeng-video", "jimeng_t2v_v30"},
		{"volcengine-jimeng-video", "jimeng_v30"},
		{"runway-video", "gen4_turbo"},
		{"runway-video", "veo3.1"},
		{"runway-video", "seedance2_5"},
		{"runway-video", "seedance2.5"},
		{"runway-video", "happyhorse_1_0"},
		{"runway-video", "gemini_omni_flash"},
		{"runway-video", "seedance2"},
		{"volcengine-ark-video", "seedance-2.5"},
		{"gemini-veo", "veo-3"},
		{"newapi", "minimax-h3"},
		{"runninghub-workflow-video", "wan2.1-t2v"},
	} {
		t.Run(tc.protocol+"/"+tc.name, func(t *testing.T) {
			refs := DefaultModelCapabilityConfigForModel(tc.protocol, tc.name).Video.References
			if refs.PromptMaxChars != 0 || refs.PromptMaxUTF16Units != 0 {
				t.Fatalf("got chars=%d units=%d, want 0/0", refs.PromptMaxChars, refs.PromptMaxUTF16Units)
			}
		})
	}
}

func TestConfiguredAndWorkflowVideoPathsDelegatePromptLengthToUpstream(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("runway-video", "gen4_turbo")
	profile.Video.References.PromptMaxUTF16Units = 4
	body, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	lookup := func(_, _ string) (*model.ChannelModel, error) {
		return &model.ChannelModel{ModelKey: "gen4_turbo", Protocol: "runway-video", CapabilityConfigJSON: string(body)}, nil
	}
	for name, validate := range map[string]func(TaskInput) error{
		"video":      func(input TaskInput) error { return ValidateVideoTask(profile.Video, input) },
		"parameters": func(input TaskInput) error { return ValidateVideoTaskParameters(profile.Video, input) },
		"stored-channel": func(input TaskInput) error {
			input.Config.ChannelID = "test-channel"
			_, err := ValidateConfiguredTask(input, lookup)
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			input := TaskInput{Mode: "video", Prompt: strings.Repeat("镜", 20000), Config: TaskConfig{
				InterfaceType: "runway-video", Model: "gen4_turbo", VideoSeconds: "6", CapabilityConfig: profile,
			}}
			if err := validate(input); err != nil {
				t.Fatalf("long prompt should be delegated to upstream: %v", err)
			}
		})
	}
}

func TestVideoNormalizationPreservesExplicitLimits(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("runway-video", "gen4_turbo")
	profile.Video.References.PromptMaxChars = 4096
	profile.Video.References.PromptMaxUTF16Units = 2048
	normalized, err := NormalizeModelCapabilityConfigForModel("video", "runway-video", "gen4_turbo", profile)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.Video.References.PromptMaxChars != 4096 || normalized.Video.References.PromptMaxUTF16Units != 2048 {
		t.Fatal("normalization overwrote a configured limit with a protocol default")
	}
	for _, limits := range [][2]int{{0, 0}, {0, 1000}} {
		profile.Video.References.PromptMaxChars, profile.Video.References.PromptMaxUTF16Units = limits[0], limits[1]
		if _, err := NormalizeModelCapabilityConfigForModel("video", "runway-video", "gen4_turbo", profile); err != nil {
			t.Fatalf("valid optional limit rejected: %v", err)
		}
	}
	for _, limits := range [][2]int{{-1, 0}, {0, -1}, {1000001, 0}, {0, 1000001}} {
		profile.Video.References.PromptMaxChars, profile.Video.References.PromptMaxUTF16Units = limits[0], limits[1]
		if _, err := NormalizeModelCapabilityConfigForModel("video", "runway-video", "gen4_turbo", profile); err == nil {
			t.Fatalf("invalid limits accepted: %v", limits)
		}
	}
	if refs := DefaultModelCapabilityConfig("newapi"); refs.Text.References.PromptMaxChars != 32000 || refs.Image.References.PromptMaxChars != 32000 {
		t.Fatal("video changes altered text/image defaults")
	}
}

func TestVideoPromptSerializationKeepsExplicitZeroUTF16(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("runway-video", "gen4_turbo")
	profile.Video.References.PromptMaxChars = 8000
	profile.Video.References.PromptMaxUTF16Units = 0
	body, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	var stored struct {
		Video struct {
			References map[string]json.RawMessage `json:"references"`
		} `json:"video"`
	}
	if err := json.Unmarshal(body, &stored); err != nil {
		t.Fatal(err)
	}
	if value, present := stored.Video.References["promptMaxUtf16Units"]; !present || string(value) != "0" {
		t.Fatalf("explicit zero must survive serialization: %s", body)
	}
	reloaded, err := DecodeModelCapabilityConfig(string(body))
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Video.References.PromptMaxChars != 8000 || reloaded.Video.References.PromptMaxUTF16Units != 0 {
		t.Fatalf("saved limits changed after decoding: %#v", reloaded.Video.References)
	}
	normalized, err := NormalizeModelCapabilityConfigForModel("video", "runway-video", "gen4_turbo", reloaded)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.Video.References.PromptMaxUTF16Units != 0 {
		t.Fatalf("disabled UTF-16 limit was restored from defaults: %d", normalized.Video.References.PromptMaxUTF16Units)
	}
}
