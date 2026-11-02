package providerpreset

import (
	"strings"
	"testing"
)

func TestSeedreamFamilyRecognizesDomesticPrefixAndModernModels(t *testing.T) {
	for model, want := range map[string]string{
		"doubao-seedream-5-0-pro-260628":   "pro",
		"doubao-seedream-5-0-flash-260915": "flash",
		"doubao-seedream-5-0-260128":       "lite",
		"doubao-seedream-4-5-251128":       "4.5",
		"doubao-seedream-4-0-250828":       "4.0",
		"dola-seedream-5-0-pro-260628":     "pro",
		"dola-seedream-5-0-flash-260915":   "flash",
		"seedream-5-0-pro-260628":          "pro",
		"seedream-5-0-flash-260915":        "flash",
		"seedream-5-0-260128":              "lite",
		"seedream-4-5-251128":              "4.5",
		"seedream-4-0-250828":              "4.0",
		"gpt-image-2":                      "",
		"":                                 "",
	} {
		if got := SeedreamFamily(model); got != want {
			t.Fatalf("SeedreamFamily(%q) = %q, want %q", model, got, want)
		}
	}
}

func TestResolveSeedreamSizeFollowsOfficialPerModelLimits(t *testing.T) {
	// 火山方舟图片生成 API 的 size 规则：档位按型号族区分，自定义宽x高按总像素
	// 区间与 [1/16, 16] 宽高比判断。表里的反例来自模型文档本身。
	for _, item := range []struct {
		family  string
		size    string
		layers  bool
		want    string
		wantErr bool
	}{
		{family: "4.0", size: "1600x600", want: "1600x600"},
		{family: "4.5", size: "5504x3040", want: "5504x3040"},
		{family: "4.5", size: "1500x1500", wantErr: true},
		{family: "4.5", size: "1K", wantErr: true},
		{family: "pro", size: "4K", wantErr: true},
		{family: "pro", size: "1.5K", want: "1.5K"},
		{family: "lite", size: "3K", want: "3K"},
		{family: "4.0", size: "1K", want: "1K"},
		{family: "4.0", size: "16:9", want: "2560x1440"},
		{family: "pro", size: "16:9", layers: true, want: SeedreamDefaultTier},
		{family: "lite", size: "9:16", want: "1440x2560"},
		{family: "pro", size: "", want: SeedreamDefaultTier},
		{family: "pro", size: "1:1", want: SeedreamDefaultTier},
		// 普通生图没有 auto：官方取值只有档位和宽x高，auto 按默认档位发出。
		{family: "pro", size: "auto", want: SeedreamDefaultTier},
		{family: "flash", size: "auto", want: SeedreamDefaultTier},
		{family: "4.5", size: "auto", want: SeedreamDefaultTier},
		{family: "4.0", size: "auto", want: SeedreamDefaultTier},
		// 图层拆分反过来：auto 合法，显式像素尺寸不合法，档位照旧。
		{family: "pro", size: "auto", layers: true, want: "auto"},
		{family: "flash", size: "auto", layers: true, want: "auto"},
		{family: "pro", size: "1.5K", layers: true, want: "1.5K"},
		{family: "pro", size: "2048x2048", layers: true, wantErr: true},
		{family: "flash", size: "1280x720", layers: true, wantErr: true},
		{family: "pro", size: "2048x2048", want: "2048x2048"},
		{family: "pro", size: "1080p", wantErr: true},
		{family: "pro", size: "512x512", wantErr: true},
		{family: "4.0", size: "800x800", wantErr: true},
		{family: "4.0", size: "4096x200", wantErr: true},
	} {
		got, err := ResolveSeedreamSize(item.family, item.size, item.layers)
		if item.wantErr {
			if err == nil {
				t.Fatalf("%s %q should be rejected, got %q", item.family, item.size, got)
			}
			if !strings.Contains(err.Error(), "Seedream") {
				t.Fatalf("%s %q error copy should name the model: %v", item.family, item.size, err)
			}
			// 这句话会原样显示在画布上，不能带像素区间、宽高比小数这类内部口径。
			for _, jargon := range []string{"总像素", "宽高比 0.", "区间"} {
				if strings.Contains(err.Error(), jargon) {
					t.Fatalf("%s %q error copy leaks %q: %v", item.family, item.size, jargon, err)
				}
			}
			continue
		}
		if err != nil || got != item.want {
			t.Fatalf("%s %q = %q, %v; want %q", item.family, item.size, got, err, item.want)
		}
	}
}

func TestResolveSeedreamSizeErrorsReadLikeUserCopy(t *testing.T) {
	// 画布上的报错就是这些话，改文案要连这里一起改，避免又退回内部口径。
	for _, item := range []struct {
		family string
		size   string
		layers bool
		want   string
	}{
		{
			family: "4.5", size: "1K",
			want: "Seedream 4.5 没有 1K 档位，请改选 2K、4K，或直接填宽x高像素（例如 2560x1440）",
		},
		{
			family: "pro", size: "4K",
			want: "Seedream 5.0 Pro 没有 4K 档位，请改选 1K、1.5K、2K，或直接填宽x高像素（例如 1280x720）",
		},
		{
			family: "4.5", size: "1500x1500",
			want: "Seedream 4.5 的图片至少要 2560x1440（369 万像素），1500x1500 只有 225 万像素",
		},
		{
			family: "pro", size: "512x512",
			want: "Seedream 5.0 Pro 的图片至少要 1280x720（92 万像素），512x512 只有 26 万像素",
		},
		{
			family: "4.0", size: "4096x200",
			want: "Seedream 4.0 支持最宽 16:1、最窄 1:16 的图片，4096x200 超出这个范围",
		},
		{
			family: "pro", size: "1080p",
			want: "Seedream 5.0 Pro 看不懂尺寸 1080p，请填 1K、1.5K、2K 档位、16:9 这类画布比例，或宽x高像素（例如 1280x720）",
		},
		{
			family: "pro", size: "2048x2048", layers: true,
			want: "Seedream 5.0 Pro 的图层拆分不支持 2048x2048，请改选 1K、1.5K、2K 档位，或选「跟随原图」",
		},
		{
			family: "pro", size: "4K", layers: true,
			want: "Seedream 5.0 Pro 的图层拆分不支持 4K，请改选 1K、1.5K、2K 档位，或选「跟随原图」",
		},
	} {
		_, err := ResolveSeedreamSize(item.family, item.size, item.layers)
		if err == nil || err.Error() != item.want {
			t.Fatalf("%s %q layers=%v error copy = %v, want %q", item.family, item.size, item.layers, err, item.want)
		}
	}
}

func TestResolveSeedreamSizeLeavesUnknownFamiliesAlone(t *testing.T) {
	// 自定义网关或没识别的型号不能被套上官方限制。
	if got, err := ResolveSeedreamSize("", "1600x600", false); err != nil || got != "1600x600" {
		t.Fatalf("unknown family = %q, %v", got, err)
	}
}
