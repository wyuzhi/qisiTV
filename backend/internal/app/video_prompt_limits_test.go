package app

import (
	"encoding/json"
	"strings"
	"testing"

	"qisitv/backend/internal/generation"
)

func TestVideoPromptLimitsUseEndpointContracts(t *testing.T) {
	cases := []struct {
		protocol, name string
		limit          int
	}{
		{"minimax-video", "MiniMax-H3", 7000},
		{"openai", "sora-2-pro", 32000},
		{"dashscope-wan-video", "wan2.6-t2v", 1500},
		{"dashscope-wan-video", "wan3.0-t2v", 20000},
		{"volcengine-jimeng-video", "jimeng_t2v_v30", 800},
		{"runway-video", "seedance2_5", 15000},
		{"runway-video", "wan3_prime", 20000},
		{"full-video", "custom", 4000},
	}
	for _, tc := range cases {
		t.Run(tc.protocol+"/"+tc.name, func(t *testing.T) {
			refs := DefaultModelCapabilityConfigForModel(tc.protocol, tc.name).Video.References
			if err := validateVideoPromptLength(strings.Repeat("镜", tc.limit), refs); err != nil {
				t.Fatalf("boundary rejected: %v", err)
			}
			prompt := strings.Repeat("镜", tc.limit+1)
			if err := validateVideoPromptLength(prompt, refs); err == nil {
				t.Fatal("expected over-limit prompt rejection")
			}
			if prompt != strings.Repeat("镜", tc.limit+1) {
				t.Fatal("prompt was truncated")
			}
		})
	}
}

func TestVideoPromptUTF16AndExplicitLimits(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("runway-video", "gen4.5")
	if err := validateVideoPromptLength(strings.Repeat("😀", 500), profile.Video.References); err != nil {
		t.Fatalf("1000 UTF-16 units rejected: %v", err)
	}
	if err := validateVideoPromptLength(strings.Repeat("😀", 501), profile.Video.References); err == nil || !strings.Contains(err.Error(), "1002") {
		t.Fatalf("expected 1002-unit error, got %v", err)
	}
	profile.Video.References.PromptMaxChars = 8000
	profile.Video.References.PromptMaxUTF16Units = 0
	normalized, err := NormalizeModelCapabilityConfigForModel("video", "runway-video", "gen4.5", profile)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateVideoPromptLength(strings.Repeat("😀", 8000), normalized.Video.References); err != nil {
		t.Fatalf("explicit legacy character limit not preserved: %v", err)
	}
	if err := validateVideoPromptLength(strings.Repeat("😀", 8001), normalized.Video.References); err == nil {
		t.Fatal("expected explicit character limit enforcement")
	}
}

func TestVideoPromptUnknownProvidersAndZeroConfig(t *testing.T) {
	for _, tc := range [][2]string{
		{"likeai-video", "doubao_seedance_2_5"},
		{"likeai-video", "wan_video_3_prime"},
		{"likeai-video", "sora-2"},
		{"custom-video", "wan3_prime"},
		{"volcengine-ark-video", "seedance-2.5"},
		{"gemini-veo", "veo-3.1"},
	} {
		profile := DefaultModelCapabilityConfigForModel(tc[0], tc[1])
		if _, err := NormalizeModelCapabilityConfigForModel("video", tc[0], tc[1], profile); err != nil {
			t.Fatalf("zero limit config rejected: %v", err)
		}
		if err := validateVideoPromptLength(strings.Repeat("镜", 32001), profile.Video.References); err != nil {
			t.Fatalf("%v borrowed a foreign limit: %v", tc, err)
		}
	}
}

func TestVideoPromptUTF16SurvivesGenerationBoundary(t *testing.T) {
	capability := DefaultModelCapabilityConfigForModel("runway-video", "gen4.5")
	raw, err := json.Marshal(capability)
	if err != nil {
		t.Fatal(err)
	}
	var converted generation.ModelCapabilityConfig
	if err := json.Unmarshal(raw, &converted); err != nil {
		t.Fatal(err)
	}
	if converted.Video.References.PromptMaxUTF16Units != 1000 {
		t.Fatalf("UTF-16 limit lost at generation boundary: %#v", converted.Video.References)
	}
}

func TestVideoPromptWithoutSavedCapabilityUsesDocumentedLimit(t *testing.T) {
	input := map[string]any{
		"mode": "video", "prompt": strings.Repeat("镜", 7001),
		"config": map[string]any{"interfaceType": "minimax-video", "model": "MiniMax-H3"},
	}
	if err := (&Service{}).ValidateTaskCapability(input); err == nil || !strings.Contains(err.Error(), "7001") {
		t.Fatalf("missing default prompt validation: %v", err)
	}
}
