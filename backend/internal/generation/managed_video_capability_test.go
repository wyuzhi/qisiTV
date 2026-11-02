package generation

import (
	"testing"

	"qisitv/backend/internal/modelcatalog"
)

func TestManagedVideoOnlySendsControlsDeclaredByServer(t *testing.T) {
	version := "server-v2"
	durationSupported := false
	profile := modelcatalog.DefaultModelCapabilityConfigForModel("openai-videos", "unseen-model").Video
	profile.Ratios, profile.Resolutions = nil, nil
	profile.DurationSupported = &durationSupported
	profile.GenerateAudio.Supported, profile.Watermark.Supported, profile.Draft.Supported = false, false, false
	input := Input{Config: Config{Model: "seedance-2.5", VideoCapabilitiesVersion: &version, VideoSeconds: "8", Size: "16:9", VQuality: "1080p", VideoGenerateAudio: "true", VideoWatermark: "true", VideoDraft: "true"}, VideoCapability: profile}
	got := managedLegacyVideoInput(input)
	if got.GenerateAudio != nil || got.Watermark != nil || got.Draft != nil || got.Seconds != "" || got.AspectRatio != "" || got.Resolution != "" {
		t.Fatal("stale client settings restored unsupported server controls")
	}
	profile.GenerateAudio.Supported, profile.Watermark.Supported, profile.Draft.Supported = true, true, true
	input.Config.VideoGenerateAudio, input.Config.VideoWatermark, input.Config.VideoDraft = "false", "false", "true"
	got = managedLegacyVideoInput(input)
	if got.GenerateAudio == nil || *got.GenerateAudio || got.Watermark == nil || *got.Watermark || got.Draft == nil || !*got.Draft || got.Resolution != "480p" {
		t.Fatal("explicit false/draft settings were discarded")
	}
	if taskInputFromCanvas(input).Config.VideoCapabilitiesVersion == nil {
		t.Fatal("generation validator lost the server capability version")
	}
}
