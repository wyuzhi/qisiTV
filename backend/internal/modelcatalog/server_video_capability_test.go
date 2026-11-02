package modelcatalog

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestServerVideoCapabilityDoesNotApplyModelOrHostLimits(t *testing.T) {
	for _, name := range []string{"seedance-2.0", "seedance-2.5", "dreamina-seedance-2-5-260628", "agnes-video-2.5", "unseen-video"} {
		t.Run(name, func(t *testing.T) {
			version := "server-v2"
			profile := DefaultModelCapabilityConfigForModel("openai-videos", "unseen-video")
			profile.Video.References = VideoReferenceConfig{MaxImages: 12, MaxVideos: 5, MaxAudios: 5}
			profile.Video.GenerateAudio = VideoBooleanConfig{Supported: false, Default: false}
			profile.Video.Duration = VideoDurationConfig{Selection: "range", Min: 1, Max: 3, Step: 1, Default: 1}
			profile.Video.Operations = []string{"text_to_video", "image_to_video", "reference_to_video", "audio_to_video"}
			draft, err := NormalizeModelCapabilityDraft(ModelCapabilityDraft{ChannelID: "beefapi", BaseURL: "https://enterprise.beefapi.com", Protocol: "newapi", Model: name, Capability: "video", CapabilityConfig: profile, VideoCapabilitiesVersion: &version})
			if err != nil {
				t.Fatal(err)
			}
			if draft.Video.References != profile.Video.References || draft.Video.Duration.Min != 1 || draft.Video.GenerateAudio.Supported {
				t.Fatal("server declaration was overwritten")
			}
			input := TaskInput{Config: TaskConfig{ChannelID: "beefapi", BaseURL: "https://enterprise.beefapi.com", InterfaceType: "newapi", Model: name, VideoCapabilitiesVersion: &version, VideoSeconds: "1"}, ReferenceImages: []MediaRef{{Width: 64, Height: 64, Bytes: 100 << 20}}}
			if err := ValidateVideoTask(draft.Video, input); err != nil {
				t.Fatalf("invented a size or duration restriction: %v", err)
			}
			input.Mode = "video"
			input.Config.ChannelID = ""
			input.Config.CapabilityConfig = draft
			if name == "agnes-video-2.5" {
				input.Config.InterfaceType = "agnes-video"
			}
			if _, err := ValidateConfiguredTask(input, nil); err != nil {
				t.Fatalf("admission rewrote the server declaration: %v", err)
			}
			// Explicit zero is authoritative even for previously supported inputs.
			draft.Video.References.MaxImages = 0
			if err := ValidateVideoTask(draft.Video, input); err == nil {
				t.Fatal("explicit zero reference count was ignored")
			}
		})
	}
}

func TestUnversionedBYOKVideoRetainsItsDocumentedLimits(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("newapi", "seedance-2.0").Video
	input := TaskInput{Config: TaskConfig{BaseURL: "https://example.com", InterfaceType: "newapi", Model: "seedance-2.0", VideoSeconds: "1"}}
	if err := ValidateVideoTask(profile, input); err == nil {
		t.Fatal("BYOK duration validation changed")
	}
}

func TestServerVideoOperationReferencesUseExplicitOperation(t *testing.T) {
	body, err := os.ReadFile("../beefapi/testdata/managed-video-catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Data []struct {
			ID      string                 `json:"id"`
			Video   *VideoCapabilityConfig `json:"video_capabilities"`
			Version string                 `json:"video_capabilities_version"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &catalog); err != nil {
		t.Fatal(err)
	}
	for _, row := range catalog.Data {
		if row.ID != "wan3.0-video" {
			continue
		}
		profile := row.Video
		if err := ValidateVideoCapabilityConfig(profile); err != nil {
			t.Fatal(err)
		}
		input := TaskInput{Config: TaskConfig{Model: "unknown-video", VideoCapabilitiesVersion: &row.Version, VideoSeconds: "5"}, ReferenceImages: make([]MediaRef, 3), Metadata: map[string]any{"videoEditOperation": "image_to_video"}}
		for _, validate := range []func(*VideoCapabilityConfig, TaskInput) error{ValidateVideoTask, ValidateVideoTaskParameters} {
			if err := validate(profile, input); err == nil || !strings.Contains(err.Error(), "2 张参考图") {
				t.Fatalf("operation image cap ignored: %v", err)
			}
			input.Metadata["videoEditOperation"] = "reference_to_video"
			input.ReferenceImages = make([]MediaRef, 10)
			if err := validate(profile, input); err != nil {
				t.Fatal(err)
			}
			input.Metadata["videoEditOperation"] = "image_to_video"
			input.ReferenceImages = make([]MediaRef, 2)
			input.ReferenceVideos = []MediaRef{{}}
			if err := validate(profile, input); err == nil || !strings.Contains(err.Error(), "0 个参考视频") {
				t.Fatalf("operation zero ignored: %v", err)
			}
			input.ReferenceVideos = nil
			input.ReferenceImages = make([]MediaRef, 3)
			delete(input.Metadata, "videoEditOperation")
			if err := validate(profile, input); err != nil {
				t.Fatalf("legacy request must use global limits: %v", err)
			}
			input.Metadata["videoEditOperation"] = "image_to_video"
		}
		if profile.References.MaxImages != 10 {
			t.Fatal("operation validation mutated global attachment capacity")
		}
		return
	}
	t.Fatal("Wan fixture missing")
}

func TestWan30VideoAndMossImageDefaultCapabilitiesAndQualityAliases(t *testing.T) {
	for _, modelName := range []string{"wan3.0-video", "wan3.0", "wan3"} {
		wan := DefaultModelCapabilityConfigForModel("newapi-channel-2", modelName).Video
		if wan == nil || len(wan.Operations) != 2 || wan.Operations[0] != "text_to_video" || wan.Operations[1] != "image_to_video" || wan.References.MaxImages != 1 || wan.References.MaxVideos != 0 || wan.References.MaxAudios != 0 {
			t.Fatalf("%s default capability = %#v", modelName, wan)
		}
	}
	kling := DefaultModelCapabilityConfigForModel("newapi-channel-2", "kling-video-v3").Video
	if kling == nil || kling.References.MaxImages != 9 || kling.References.MaxVideos != 3 || kling.References.MaxAudios != 3 || !containsCapabilityString(kling.Operations, "reference_to_video") {
		t.Fatalf("kling-video-v3 on newapi-channel-2 should retain generic channel-2 limits, got %#v", kling)
	}
	moss := DefaultImageCapabilityConfig("openai-image", "moss-image-sft-1.0")
	if moss == nil || moss.Quality.Supported || moss.OutputFormat.Supported || !moss.ResponseFormat.Supported || moss.ResponseFormat.Value != ImageResponseFormatURL || moss.MaxOutputs != 1 || moss.References.MaxImages != 0 || moss.References.MaskSupported {
		t.Fatalf("moss-image-sft-1.0 default capability = %#v", moss)
	}
	if err := ValidateImageTask(moss, TaskInput{Config: TaskConfig{InterfaceType: "openai-image", Model: "moss-image-sft-1.0", Size: "1024x1024", Count: "1"}}); err != nil {
		t.Fatalf("moss-image valid size rejected: %v", err)
	}
	if err := ValidateImageTask(moss, TaskInput{Config: TaskConfig{InterfaceType: "openai-image", Model: "moss-image-sft-1.0", Size: "4096x4096", Count: "1"}}); err == nil {
		t.Fatal("moss-image oversized dimension should be rejected")
	}
	gptImage := DefaultImageCapabilityConfig("openai-image", "gpt-image-2")
	if err := ValidateImageTask(gptImage, TaskInput{Config: TaskConfig{InterfaceType: "openai-image", Model: "gpt-image-2", Size: "1024x1024", Quality: "2k", Count: "1"}}); err != nil {
		t.Fatalf("gpt-image-2 should accept 2k quality alias: %v", err)
	}
}
