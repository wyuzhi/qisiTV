package topaz

import "testing"

func TestOfficialUpscaleParameters(t *testing.T) {
	for _, mode := range Modes() {
		if mode.Provider != "topaz" {
			continue
		}
		r := Request{ResourceID: "owned", ChannelID: "beefapi", Mode: mode.Mode, Model: mode.Models[0], Scale: 2, OutputFormat: mode.OutputFormats[0]}
		if err := Validate(r, mode.MediaType); err != nil {
			t.Fatal(err)
		}
		if ModelID(r.Model) == "" {
			t.Fatal("missing official model mapping")
		}
		r.ChannelID = "fal"
		if Validate(r, mode.MediaType) == nil {
			t.Fatal("direct provider credential accepted")
		}
		r.ChannelID, r.Scale = "beefapi", 1.5
		if Validate(r, mode.MediaType) == nil {
			t.Fatal("unsupported fractional scale accepted")
		}
	}
}

func TestLikeAIEnhancementParametersRemainSeparateFromTopaz(t *testing.T) {
	image := Request{ResourceID: "owned", ChannelID: "likeai", Mode: "likeai", Model: "huoshan_image_super_resolution", Scale: 1, ModelQuality: "MQ"}
	if err := Validate(image, "image"); err != nil {
		t.Fatal(err)
	}
	video := Request{ResourceID: "owned", ChannelID: "likeai", Mode: "likeai", Model: "tengxun_video_super_resolution", Scale: 1, Resolution: "2160p"}
	if err := Validate(video, "video"); err != nil {
		t.Fatal(err)
	}
	if ModelID(image.Model) != "" || ModelID(video.Model) != "" {
		t.Fatal("LikeAI must never be labelled as Topaz")
	}
	image.Scale = 4
	if err := Validate(image, "image"); err == nil {
		t.Fatal("undocumented scale accepted")
	}
	video.Resolution = "4K"
	if err := Validate(video, "video"); err == nil {
		t.Fatal("unsupported wire resolution accepted")
	}
}
