package modelcatalog

import (
	"reflect"
	"testing"
)

func TestLikeAICapabilitiesSurviveProviderModuleSplit(t *testing.T) {
	image := DefaultImageCapabilityConfig("likeai-image", "doubao_seedream_5_pro")
	if image.Size.Parameter != "aspect_ratio" || image.Quality.Default != "1440p" || !reflect.DeepEqual(image.Quality.Values, []string{"720p", "1080p", "1440p"}) || image.References.MaskSupported || image.MaxOutputs != 1 {
		t.Fatalf("LikeAI image inherited another provider's size or quality contract: %+v", image)
	}
	text := DefaultModelCapabilityConfigForModel("likeai-text", "text-model").Text
	if text.Streaming == nil || *text.Streaming {
		t.Fatal("LikeAI synchronous text model advertised streaming")
	}
	for _, item := range []struct {
		model                 string
		images, videos, start int
		resolutions           []string
	}{
		{"doubao_seedance_2_5", 30, 10, 4, []string{"480p", "720p"}},
		{"wan_video_3_prime", 10, 5, 2, []string{"480p", "720p", "1080p"}},
		{"tongyi_wan_video_3_prime", 10, 5, 2, []string{"480p", "720p", "1080p"}},
	} {
		t.Run(item.model, func(t *testing.T) {
			video := DefaultModelCapabilityConfigForModel("likeai-video", item.model).Video
			if video.References.MaxImages != item.images || video.References.MaxVideos != item.videos || !reflect.DeepEqual(video.Resolutions, item.resolutions) || video.DefaultRatio != "adaptive" {
				t.Fatalf("wrong LikeAI video contract: %+v", video)
			}
			if video.Duration.Selection != "enum" || len(video.Duration.Values) != 32-item.start || video.Duration.Values[0] != -1 || video.Duration.Values[1] != item.start || video.Duration.Values[len(video.Duration.Values)-1] != 30 {
				t.Fatalf("lost Auto or documented duration values: %+v", video.Duration)
			}
		})
	}
	upscale := DefaultImageCapabilityConfig("likeai-image", "huoshan_image_super_resolution")
	if upscale.References.MaxImages != 1 || upscale.Quality.Supported || upscale.Size.AllowCustom || len(upscale.Size.Values) > 0 {
		t.Fatalf("upscale advertised image generation parameters: %+v", upscale)
	}
}
