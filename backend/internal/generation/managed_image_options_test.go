package generation

import (
	"encoding/json"
	"os"
	"testing"

	"qisitv/backend/internal/beeftv"
)

func mustNormalizeImageProfile(t *testing.T, raw string) *ImageCapabilityConfig {
	t.Helper()
	normalized, ok := beeftv.NormalizeCatalogImageCapability(json.RawMessage(raw))
	if !ok {
		t.Fatalf("NormalizeCatalogImageCapability rejected %s", raw)
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		t.Fatal(err)
	}
	var profile ImageCapabilityConfig
	if err := json.Unmarshal(encoded, &profile); err != nil {
		t.Fatal(err)
	}
	return &profile
}

// 能力直接经由 beeftv.NormalizeCatalogImageCapability 解析自服务端 /v1/models 录制快照与线上目录声明。
func TestManagedImageOptionsFollowCatalogCapability(t *testing.T) {
	fixtureBytes, err := os.ReadFile("../beeftv/testdata/managed-media/models-enterprise-priced-authenticated.json")
	if err != nil {
		t.Fatal(err)
	}
	var recorded struct {
		Data []struct {
			ID    string          `json:"id"`
			Image json.RawMessage `json:"image_capabilities"`
		} `json:"data"`
	}
	if err := json.Unmarshal(fixtureBytes, &recorded); err != nil {
		t.Fatal(err)
	}
	recordedByID := map[string]*ImageCapabilityConfig{}
	for _, item := range recorded.Data {
		recordedByID[item.ID] = mustNormalizeImageProfile(t, string(item.Image))
	}
	seedreamFlash := recordedByID["dola-seedream-5-0-flash-260915"]
	seedreamLite := recordedByID["seedream-5-0-260128"]
	if seedreamFlash == nil || seedreamLite == nil {
		t.Fatalf("missing recorded seedream profiles: %#v", recordedByID)
	}
	// BeefTV service/image_catalog_capability.go nativeImageCatalogCapability for vod/OG/v2.5 (gpt-image-2.5).
	gptImage25 := mustNormalizeImageProfile(t, `{"references":{"promptMaxChars":32000,"maxImages":16,"maxImageBytes":0,"maskSupported":true},"size":{"parameter":"size","values":["1024x1024","1536x1024","1024x1536","2048x2048","2880x2880"],"default":"1024x1024","allowCustom":true},"quality":{"supported":true,"values":["low","medium","high","xhigh","max"],"default":"medium"},"transparentBackground":{"supported":true,"default":false},"responseFormat":{"supported":false},"outputFormat":{"supported":true},"maxOutputs":8}`)
	fixedPixelModel := mustNormalizeImageProfile(t, `{"references":{"promptMaxChars":32000,"maxImages":1,"maxImageBytes":0,"maskSupported":false},"size":{"parameter":"size","values":["1024x1024"],"default":"1024x1024","allowCustom":false},"quality":{"supported":false,"values":[],"default":"auto"},"transparentBackground":{"supported":false,"default":false},"responseFormat":{"supported":false},"outputFormat":{"supported":false},"maxOutputs":4}`)
	tierOnlyFixedModel := mustNormalizeImageProfile(t, `{"references":{"promptMaxChars":32000,"maxImages":0,"maxImageBytes":0,"maskSupported":false},"size":{"parameter":"size","values":["1K","2K"],"default":"2K","allowCustom":false},"quality":{"supported":false,"values":[],"default":"auto"},"transparentBackground":{"supported":false,"default":false},"responseFormat":{"supported":false},"outputFormat":{"supported":false},"maxOutputs":1}`)
	fallbackPixelProfile := &ImageCapabilityConfig{
		Size: ImageSizeConfig{
			Parameter:   "size",
			Values:      []string{"1:1", "16:9", "9:16", "1024x1024", "1536x1024", "1024x1536"},
			Default:     "1:1",
			AllowCustom: true,
		},
		Quality: ImageQualityConfig{Supported: true, Values: []string{"auto", "low", "medium", "high"}, Default: "auto"},
	}

	cases := []struct {
		name          string
		profile       *ImageCapabilityConfig
		size, quality string
		wantSize      string
		wantQuality   string
	}{
		{"canvas ratio on gpt-image-2.5 keeps established 16:9 size", gptImage25, "16:9", "low", "1824x1024", "low"},
		{"fallback pixel profile converts 16:9 ratio instead of sending raw ratio", fallbackPixelProfile, "16:9", "low", "1824x1024", "low"},
		{"listed pixel size on gpt-image-2.5 is sent as is", gptImage25, "1536x1024", "high", "1536x1024", "high"},
		{"unknown quality on gpt-image-2.5 is left to the server", gptImage25, "1:1", "standard", "1024x1024", ""},
		{"canvas ratio on recorded seedream flash uses 2K tier area", seedreamFlash, "16:9", "auto", "2736x1536", ""},
		{"canvas ratio on recorded seedream-5-0-260128 uses 2K tier area", seedreamLite, "16:9", "standard", "2736x1536", ""},
		{"listed tier on recorded seedream is sent as is", seedreamLite, "2K", "auto", "2K", ""},
		{"unsupported quality on seedream is dropped", seedreamFlash, "1.5K", "high", "1.5K", ""},
		{"fixed pixel model picks closest listed value", fixedPixelModel, "16:9", "", "1024x1024", ""},
		{"valid tier-only fixed model returns catalog default tier", tierOnlyFixedModel, "16:9", "", "2K", ""},
		{"auto size is omitted", gptImage25, "auto", "", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			options := managedImageOptions(Input{Config: Config{Size: tc.size, Quality: tc.quality}, ImageCapability: tc.profile})
			gotSize, _ := options["size"].(string)
			gotQuality, _ := options["quality"].(string)
			if gotSize != tc.wantSize || gotQuality != tc.wantQuality {
				t.Fatalf("size=%q quality=%q, want size=%q quality=%q", gotSize, gotQuality, tc.wantSize, tc.wantQuality)
			}
		})
	}
	if got := closestImageSize([]string{"1K", "2K"}, 16, 9, ""); got != "1K" {
		t.Fatalf("closestImageSize without pixel candidates or default = %q, want 1K", got)
	}
	if got := managedImageOptions(Input{Config: Config{Model: "dola-seedream-5-0-pro-260628"}})["watermark"]; got != false {
		t.Fatalf("Seedream default watermark = %#v, want false", got)
	}
	if got := managedImageOptions(Input{Config: Config{Model: "dola-seedream-5-0-pro-260628", SeedreamWatermark: "true"}})["watermark"]; got != true {
		t.Fatalf("Seedream explicit watermark = %#v, want true", got)
	}
	if _, exists := managedImageOptions(Input{Config: Config{Model: "gpt-image-2.5", SeedreamWatermark: "false"}, ImageCapability: gptImage25})["watermark"]; exists {
		t.Fatal("non-Seedream managed image options must not send watermark=false")
	}
	if _, exists := managedImageOptions(Input{Config: Config{Model: "gpt-image-2.5", SeedreamWatermark: "true"}, ImageCapability: gptImage25})["watermark"]; exists {
		t.Fatal("non-Seedream managed image options must not leak residual seedreamWatermark=true")
	}
}
