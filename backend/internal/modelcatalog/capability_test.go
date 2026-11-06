package modelcatalog

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestServerImageCapabilitiesOwnFileLimitWithoutModelOrHostExceptions(t *testing.T) {
	for _, name := range []string{"opaque-future-2030", "gpt-image-2", "gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"} {
		profile := DefaultImageCapabilityConfig("openai-image", name)
		for _, base := range []string{"https://beeftv.app", "https://enterprise.beefapi.com/v1", "https://beefapi.com", "https://third-party.example", "http://beeftv.app", "https://beeftv.app.evil.example"} {
			input := TaskInput{Mode: "image", Prompt: "edit", Config: TaskConfig{BaseURL: base, InterfaceType: "openai-image", Model: name, Size: "1024x1024"}, ReferenceImages: []MediaRef{{Bytes: 48 << 20}}}
			if err := validateImageTask(profile, input); err == nil {
				t.Fatal("hostname silently removed local limits")
			}
			server := *profile
			server.References.MaxImageBytes = 0
			version := "server-v1"
			input.Config.ImageCapabilitiesVersion = &version
			if err := validateImageTask(&server, input); err != nil {
				t.Fatalf("%s at %s rejected server capability: %v", name, base, err)
			}
		}
		if profile.References.MaxImageBytes != 30<<20 {
			t.Fatal("managed override mutated shared profile")
		}
	}
	profile := DefaultImageCapabilityConfig("openai-image", "dola-seedream-5-0-pro-260628")
	if err := validateImageTask(profile, TaskInput{Mode: "image", Prompt: "edit", Config: TaskConfig{BaseURL: "https://beeftv.app", InterfaceType: "openai-image", Model: "dola-seedream-5-0-pro-260628", Size: "2K"}, ReferenceImages: []MediaRef{{Bytes: 31 << 20}}}); err == nil {
		t.Fatal("Seedream's documented limit was removed")
	}
}

func TestDefaultPixelPresetsSatisfyImageGenerationConstraints(t *testing.T) {
	count := 0
	for _, size := range defaultImageSizeValues() {
		if !strings.Contains(size, "x") {
			continue
		}
		count++
		if err := validateGPTImage2CustomSize(size); err != nil {
			t.Errorf("default pixel preset %q: %v", size, err)
		}
	}
	if count != 30 {
		t.Fatalf("expected all 30 pixel presets, got %d", count)
	}
}

func TestGPTImageQualityTiersValidateAll39Selections(t *testing.T) {
	count := 0
	legacyProfile := DefaultImageCapabilityConfig("openai-image", "gpt-image-2")
	legacyProfile.Quality = ImageQualityConfig{Supported: true, Values: []string{"auto", "low", "medium", "high"}, Default: "auto"}
	legacyJSON, err := json.Marshal(&ModelCapabilityConfig{Version: 1, Image: legacyProfile})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"} {
		profile := DefaultImageCapabilityConfig("openai-image", name)
		for _, quality := range profile.Quality.Values {
			if quality == "auto" {
				continue
			}
			for _, size := range []string{"1024x1024", "2048x2048", "2880x2880"} {
				input := TaskInput{Prompt: "cat", Config: TaskConfig{Model: name, InterfaceType: "openai-image", Quality: quality, Size: size, Count: "1"}}
				if err := validateImageTask(profile, input); err != nil {
					t.Fatalf("%s/%s/%s: %v", name, quality, size, err)
				}
				input.Mode, input.Config.ChannelID = "image", "beefapi"
				_, err := ValidateConfiguredTask(input, func(_, _ string) (*model.ChannelModel, error) {
					return &model.ChannelModel{ModelKey: name, Protocol: "openai-image", CapabilityConfigJSON: string(legacyJSON)}, nil
				})
				if err != nil {
					t.Fatalf("stored legacy %s/%s/%s: %v", name, quality, size, err)
				}
				count++
			}
		}
	}
	if count != 84 {
		t.Fatalf("expected 84 quality/size combinations, got %d", count)
	}
	if containsCapabilityString(DefaultImageCapabilityConfig("openai-image", "gpt-image-2").Quality.Values, "max") || containsCapabilityString(DefaultImageCapabilityConfig("openai-image", "custom-doodle").Quality.Values, "xhigh") {
		t.Fatal("unverified models must not inherit the 2.5 quality tiers")
	}
}

func TestGPTImageLegacyUpgradePreservesCustomLimitsAndSource(t *testing.T) {
	legacy := DefaultImageCapabilityConfig("openai-image", "gpt-image-2")
	legacy.Quality = ImageQualityConfig{Supported: true, Values: []string{"auto", "low", "medium", "high"}, Default: "auto"}
	legacy.Size.Values = []string{"2048x878"}
	legacy.Size.Default = "2048x878"
	legacy.Size.Presets = []ImageSizePreset{{Tier: "1k", Ratio: "21:9", Size: "2048x878", Width: 2048, Height: 878}}
	upgraded := applyModelSpecificImageCapability(legacy, "openai-image", "gpt-image-2.5-flare", "")
	if !containsCapabilityString(upgraded.Quality.Values, "max") || upgraded.Size.Default != "2048x880" || upgraded.Size.Presets[0].Height != 880 {
		t.Fatal("legacy choices not upgraded")
	}
	if len(legacy.Quality.Values) != 4 || legacy.Size.Values[0] != "2048x878" || legacy.Size.Presets[0].Height != 878 {
		t.Fatal("upgrade mutated original profile")
	}
	legacy.Quality.Values, legacy.Quality.Default = []string{"low"}, "low"
	limited := applyModelSpecificImageCapability(legacy, "openai-image", "gpt-image-2.5-flare", "")
	if len(limited.Quality.Values) != 1 || limited.Quality.Default != "low" {
		t.Fatal("explicit custom quality restriction changed")
	}
}

func TestImage2DefaultAndLegacyAutoResolveLowWithoutChangingExplicitTiers(t *testing.T) {
	profile := DefaultImageCapabilityConfig("openai-image", "gpt-image-2")
	if profile.Quality.Default != "low" || containsCapabilityString(profile.Quality.Values, "auto") {
		t.Fatal("image2 must show low as its default")
	}
	legacy := *profile
	legacy.Quality = ImageQualityConfig{Supported: true, Values: []string{"auto", "low", "medium", "high"}, Default: "auto"}
	upgraded := applyModelSpecificImageCapability(&legacy, "openai-image", "gpt-image-2", "")
	if upgraded.Quality.Default != "low" || legacy.Quality.Default != "auto" {
		t.Fatal("legacy migration must not mutate the source")
	}
	for _, quality := range []string{"", "auto", "medium", "high"} {
		config := map[string]any{"quality": quality, "size": "2880x2880"}
		ApplyChannelCapabilityDefaults(config, "image", &ModelCapabilityConfig{Image: upgraded})
		want := quality
		if quality == "" || quality == "auto" {
			want = "low"
		}
		if config["quality"] != want || config["size"] != "2880x2880" {
			t.Fatalf("selection changed: %#v", config)
		}
	}
	if DefaultImageCapabilityConfig("openai-image", "gpt-image-2.5-flare").Quality.Default != "auto" {
		t.Fatal("2.5 default changed")
	}
}

func TestNormalizeCustomImageModelWithoutGuessedLimits(t *testing.T) {
	input := &ModelCapabilityConfig{Version: 1, Image: DefaultImageCapabilityConfig("openai-image", "my-custom-doodle")}
	normalized, err := NormalizeModelCapabilityConfigForModel("image", "openai-image", "my-custom-doodle", input)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.Image == nil || normalized.Image.References.MaxImages != 16 {
		t.Fatalf("custom image model should keep stored defaults, got %#v", normalized.Image)
	}
}

func TestDisabledAndUnavailableModelsAreNotPublic(t *testing.T) {
	channels := []model.ModelChannel{
		{ID: "sys", Name: "系统", Enabled: true, SortOrder: 1},
		{ID: "off", Name: "停用", Enabled: false},
	}
	models := map[string][]model.ChannelModel{
		"sys": {
			{ID: "ok", ChannelID: "sys", ModelKey: "ok", DisplayName: "可用", Capability: "audio", Protocol: "openai-audio", Enabled: true},
			{ID: "disabled", ChannelID: "sys", ModelKey: "disabled", DisplayName: "停用模型", Capability: "audio", Protocol: "openai-audio", Enabled: false},
		},
		"off": {
			{ID: "hidden", ChannelID: "off", ModelKey: "hidden", DisplayName: "渠道停用", Capability: "audio", Protocol: "openai-audio", Enabled: true},
		},
	}
	catalog, err := PublicSystemChannelCatalog(channels, func(channelID string) ([]model.ChannelModel, error) {
		return models[channelID], nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog) != 1 || catalog[0].ID != "sys" || len(catalog[0].Models) != 1 || catalog[0].Models[0].ModelKey != "ok" {
		t.Fatalf("catalog should publish only enabled models on enabled channels: %#v", catalog)
	}
	if catalog[0].Models[0].CapabilityConfig != nil {
		t.Fatal("audio models must not leak a capability JSON object")
	}
}

func TestSeedanceDoesNotInventACharacterCeiling(t *testing.T) {
	for _, protocol := range []string{"newapi", "volcengine-ark-video"} {
		profile := DefaultModelCapabilityConfigForModel(protocol, "seedance-2.0").Video
		if profile.References.PromptMaxChars != 0 {
			t.Fatalf("%s prompt ceiling = %d", protocol, profile.References.PromptMaxChars)
		}
		for _, length := range []int{8101, 32001} {
			if err := ValidateVideoTask(profile, TaskInput{Mode: "video", Prompt: strings.Repeat("镜", length), Config: TaskConfig{InterfaceType: protocol, Model: "seedance-2.0", VideoSeconds: "6", Size: "16:9", VQuality: "720p"}}); err != nil {
				t.Fatalf("%s rejected %d characters: %v", protocol, length, err)
			}
		}
	}
	if got := DefaultModelCapabilityConfigForModel("newapi", "other-video").Video.References.PromptMaxChars; got != 0 {
		t.Fatalf("unrelated video default changed to %d", got)
	}
}

func TestSanitizeChannelModelOmitsSecrets(t *testing.T) {
	cfg := DefaultModelCapabilityConfigForModel("newapi-channel-2", "seedance-2.0")
	encoded, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	public, err := SanitizeChannelModel(&model.ChannelModel{
		ID: "m1", ChannelID: "sys", ModelKey: "seed", DisplayName: "Seed",
		Capability: "video", Protocol: "newapi-channel-2", Enabled: true,
		CapabilityConfigJSON: string(encoded),
	})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(public)
	if err != nil {
		t.Fatal(err)
	}
	lower := strings.ToLower(string(body))
	if strings.Contains(lower, "apikey") || strings.Contains(lower, "secret") || strings.Contains(lower, "baseurl") {
		t.Fatalf("public model leaked credential-shaped fields: %s", body)
	}
}

func TestCorruptCapabilityJSONFailsClosedOnSanitize(t *testing.T) {
	_, err := SanitizeChannelModel(&model.ChannelModel{
		ID: "bad", ModelKey: "bad", Capability: "video", Protocol: "newapi", Enabled: true,
		CapabilityConfigJSON: "{not-json",
	})
	if err == nil {
		t.Fatal("corrupt capability JSON must fail closed")
	}
}

func TestValidateImageCapabilityConfigRestrictsResponseFormat(t *testing.T) {
	for _, tc := range []struct {
		name    string
		value   string
		wantVal string
		wantErr bool
	}{
		{"empty stays empty", "", "", false},
		{"url is kept", "url", ImageResponseFormatURL, false},
		{"b64_json is kept", "b64_json", ImageResponseFormatBase64, false},
		{"case is normalized", " URL ", ImageResponseFormatURL, false},
		{"unknown value is rejected", "webp", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			profile := DefaultImageCapabilityConfig("openai-image", "third-party-image")
			profile.ResponseFormat = ImageResponseFormat{Supported: true, Value: tc.value}
			err := ValidateImageCapabilityConfig(profile)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected an error for response_format %q", tc.value)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if profile.ResponseFormat.Value != tc.wantVal {
				t.Fatalf("response_format value = %q, want %q", profile.ResponseFormat.Value, tc.wantVal)
			}
		})
	}
}

func TestNormalizeModelCapabilityDraftAndSeedreamValidationTable(t *testing.T) {
	t.Run("draft normalization covers text thinking and agnes-image", func(t *testing.T) {
		wantTrue, wantFalse := true, false
		cases := []struct {
			name         string
			draft        ModelCapabilityDraft
			wantThinking *bool
			wantMaxOut   int
		}{
			{
				name:         "openai-response defaults thinking to true",
				draft:        ModelCapabilityDraft{Capability: "text", Protocol: "openai-response", Model: "gpt-5.4"},
				wantThinking: &wantTrue,
			},
			{
				name:         "chat-completion defaults thinking to false",
				draft:        ModelCapabilityDraft{Capability: "text", Protocol: "chat-completion", Model: "gpt-4o"},
				wantThinking: &wantFalse,
			},
			{
				name:       "agnes-image sets aspect_ratio and 4 max outputs",
				draft:      ModelCapabilityDraft{Capability: "image", Protocol: "agnes-image", Model: "agnes-image-1"},
				wantMaxOut: 4,
			},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				got, err := NormalizeModelCapabilityDraft(tc.draft)
				if err != nil {
					t.Fatalf("NormalizeModelCapabilityDraft() error = %v", err)
				}
				if tc.wantThinking != nil {
					if got.Text == nil || got.Text.Thinking == nil || *got.Text.Thinking != *tc.wantThinking {
						t.Fatalf("thinking = %#v, want %v", got.Text, *tc.wantThinking)
					}
				}
				if tc.wantMaxOut > 0 {
					if got.Image == nil || got.Image.MaxOutputs != tc.wantMaxOut || got.Image.Size.Parameter != "aspect_ratio" {
						t.Fatalf("image = %#v, want maxOutputs=%d parameter=aspect_ratio", got.Image, tc.wantMaxOut)
					}
				}
			})
		}
	})

	t.Run("issue 273 Seedream model family and size validation table", func(t *testing.T) {
		cases := []struct {
			name      string
			model     string
			baseURL   string
			size      string
			quality   string
			refCount  int
			wantError string
		}{
			{
				name:     "seedream 5.0 lite accepts 2K tier and 14 reference images",
				model:    "doubao-seedream-5-0-260128",
				size:     "2K",
				refCount: 14,
			},
			{
				name:      "seedream 5.0 lite rejects 15 reference images",
				model:     "doubao-seedream-5-0-260128",
				size:      "2K",
				refCount:  15,
				wantError: "最多支持 14 张参考图",
			},
			{
				name:     "seedream 5.0 pro accepts 1.5K tier and caps at 10 reference images",
				model:    "doubao-seedream-5-0-pro-260128",
				size:     "1.5K",
				refCount: 10,
			},
			{
				name:      "seedream 5.0 pro rejects 4K tier",
				model:     "doubao-seedream-5-0-pro-260128",
				size:      "4K",
				wantError: "没有 4K 档位",
			},
			{
				name:      "seedream 5.0 lite rejects 1K tier",
				model:     "doubao-seedream-5-0-260128",
				size:      "1K",
				wantError: "没有 1K 档位",
			},
			{
				name:      "seedream 5.0 pro rejects undersized custom pixel dimensions",
				model:     "doubao-seedream-5-0-pro-260128",
				size:      "800x600",
				wantError: "至少要 1280x720",
			},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				profile := DefaultImageCapabilityConfig("openai-image", tc.model)
				refs := make([]MediaRef, tc.refCount)
				for i := range refs {
					refs[i] = MediaRef{URL: "https://example.com/ref.png"}
				}
				err := validateImageTask(profile, TaskInput{
					Prompt:          "mountain sunrise",
					ReferenceImages: refs,
					Config: TaskConfig{
						InterfaceType: "openai-image",
						Model:         tc.model,
						BaseURL:       tc.baseURL,
						Size:          tc.size,
						Quality:       tc.quality,
						Count:         "1",
					},
				})
				if tc.wantError == "" && err != nil {
					t.Fatalf("validateImageTask() unexpected error = %v", err)
				}
				if tc.wantError != "" && (err == nil || !strings.Contains(err.Error(), tc.wantError)) {
					t.Fatalf("validateImageTask() error = %v, want substring %q", err, tc.wantError)
				}
			})
		}
	})
}
