package pricing

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// testdata/enterprise-catalog.json holds the media rows BeefTV 官方算力 published at
// /api/enterprise/catalog on 2026-11-03.
func catalogTable(t *testing.T, model string) *Table {
	t.Helper()
	body, err := os.ReadFile("testdata/enterprise-catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	rows, ok := ParseCatalog(body)
	if !ok {
		t.Fatal("catalog fixture did not parse")
	}
	table, ok := Normalize(rows[model])
	if !ok {
		t.Fatalf("catalog row %s did not normalize", model)
	}
	return table
}

func TestQuoteUsesCatalogPrices(t *testing.T) {
	cases := []struct {
		name   string
		model  string
		target Target
		amount float64
		approx bool
		basis  string
	}{
		{"per-second video with paid references", "minimax-h3", Target{Kind: "video", Resolution: "768p", Seconds: 6, ReferenceImages: 7}, 5.2895, false, "768p ¥0.6103/秒 × 6 秒 + 参考图 2 张 × ¥0.8138"},
		{"resolution without p suffix", "minimax-h3-max-turbo", Target{Kind: "video", Resolution: "1080", Seconds: 10}, 4.8826, false, "1080p ¥0.4883/秒 × 10 秒"},
		{"token video converted per second", "seedance-2.0", Target{Kind: "video", Resolution: "720p", Seconds: 5}, 4.968, true, "720p ¥0.9936/秒 × 5 秒，按 Token 折算"},
		{"token video several outputs", "seedance-2.0-fast", Target{Kind: "video", Resolution: "480p", Seconds: 10, Count: 2}, 4.4194, true, "每个 480p ¥0.221/秒 × 10 秒，共 2 个，按 Token 折算"},
		{"video billed on combined seconds without references", "wan3.0-video", Target{Kind: "video", Resolution: "720p", Seconds: 5}, 4.05, false, "720p ¥0.81/秒 × 5 秒"},
		{"gpt image tier from size", "gpt-image-2", Target{Kind: "image", Size: "1024x1024", Quality: "low", Count: 4, ReferenceImages: 2}, 1.7, false, "1K 低质量 ¥0.35/张 × 4 张 + 参考图 2 张 × ¥0.15"},
		{"gpt image 2K tier", "gpt-image-2", Target{Kind: "image", Size: "2048x2048", Quality: "high"}, 4.4, false, "2K 高质量 ¥4.4/张 × 1 张"},
		{"gpt image auto quality", "gpt-image-2.5", Target{Kind: "image", Size: "1536x1024", Quality: "auto"}, 0.4, false, "1K 中质量 ¥0.4/张 × 1 张"},
		{"gpt image default size", "gpt-image-2.5-sunburst", Target{Kind: "image", Quality: "xhigh"}, 1.1, false, "1K 超高质量 ¥1.1/张 × 1 张"},
		{"seedream first reference included", "dola-seedream-5-0-pro-260628", Target{Kind: "image", Size: "2K", ReferenceImages: 3}, 0.1953, false, "2K ¥0.1831/张 × 1 张 + 参考图 2 张 × ¥0.0061"},
		{"seedream pixel area tier", "dola-seedream-5-0-pro-260628", Target{Kind: "image", Size: "1536x1536"}, 0.0915, false, "1K ¥0.0915/张 × 1 张"},
		{"seedream larger sizes share the 2K price", "seedream-5-0-260128", Target{Kind: "image", Size: "4K", Count: 3}, 0.2136, false, "2K ¥0.0712/张 × 3 张"},
		{"flat image price", "midjourney-v8.2", Target{Kind: "image", Count: 4}, 1.62, false, "¥0.405/张 × 4 张"},
		{"speech by characters", "minimax-speech-2.8-hd", Target{Kind: "audio", Characters: 100}, 0.035, true, "100 字 × ¥350/百万字"},
		{"music per request", "minimax-music-v3.0", Target{Kind: "audio", Count: 2}, 2, false, "¥1/次 × 2 次"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Quote(catalogTable(t, tc.model), tc.target)
			if got.Amount == nil {
				t.Fatalf("amount unknown: %s", got.Basis)
			}
			if *got.Amount != tc.amount || got.Approx != tc.approx || got.Basis != tc.basis {
				t.Fatalf("got %v approx=%v %q, want %v approx=%v %q", *got.Amount, got.Approx, got.Basis, tc.amount, tc.approx, tc.basis)
			}
			if !strings.HasSuffix(got.Text, "（"+tc.basis+"）") {
				t.Fatalf("text %q does not show its basis", got.Text)
			}
		})
	}
}

func TestQuoteLeavesUndeterminedPricesUnknown(t *testing.T) {
	cases := []struct {
		name   string
		model  string
		target Target
		basis  string
	}{
		{"token video with reference video", "seedance-2.0", Target{Kind: "video", Resolution: "720p", Seconds: 5, ReferenceVideos: 1}, "含参考视频，按实际视频 Token 结算（720p ¥28/百万 Token）"},
		{"token video without per-second conversion", "seedance-2.0-portrait", Target{Kind: "video", Resolution: "720p", Seconds: 5}, "720p 按实际视频 Token 结算（¥47.4698/百万 Token）"},
		{"reference video seconds are billed", "wan3.0-video", Target{Kind: "video", Resolution: "720p", Seconds: 5, ReferenceVideos: 1}, "含参考视频，按生成和参考视频的实际秒数结算（720p ¥0.81/秒）"},
		{"unlisted resolution", "kling-video-v3", Target{Kind: "video", Resolution: "1080p", Seconds: 5}, "1080p 暂无价格"},
		{"model-chosen duration", "minimax-h3", Target{Kind: "video", Resolution: "768p"}, "时长由模型决定，按实际时长结算"},
		{"layer decomposition", "dola-seedream-5-0-flash-260915", Target{Kind: "image", Layers: true}, "图层拆分按实际拆出的图层数计费，每层 ¥0.0366"},
		{"unlisted image tier", "gpt-image-2", Target{Kind: "image", Size: "auto-ish", Quality: "low"}, "低质量 暂无价格"},
		{"empty speech", "minimax-speech-2.8-turbo", Target{Kind: "audio"}, "台词为空，暂无价格"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Quote(catalogTable(t, tc.model), tc.target)
			if got.Amount != nil || got.Basis != tc.basis || got.Text != tc.basis {
				t.Fatalf("got amount=%v %q, want unknown %q", got.Amount, got.Basis, tc.basis)
			}
		})
	}
}

func TestQuoteKeepsUpfrontChargeOutOfAmount(t *testing.T) {
	got := Quote(catalogTable(t, "topaz-proteus"), Target{Kind: "video"})
	if got.Amount != nil || got.Reserve == nil || *got.Reserve != 27.1256 || got.Basis != "先扣 ¥27.13，账单核对后按实际结算" {
		t.Fatalf("got %+v", got)
	}
	if summary := Summarize([]Estimate{got}); summary.Amount != 0 || summary.Unknown != 1 {
		t.Fatalf("an upfront charge joined the total: %+v", summary)
	}
}

func TestEstimateTextShowsAmountWithBasis(t *testing.T) {
	exact := Quote(catalogTable(t, "gpt-image-2"), Target{Kind: "image", Size: "2048x2048", Quality: "high", Count: 3})
	token := Quote(catalogTable(t, "seedance-2.0"), Target{Kind: "video", Resolution: "1080p", Seconds: 10})
	if exact.Text != "预计 ¥13.2（2K 高质量 ¥4.4/张 × 3 张）" || token.Text != "约 ¥24.79（1080p ¥2.4786/秒 × 10 秒，按 Token 折算）" {
		t.Fatalf("got %q / %q", exact.Text, token.Text)
	}
}

func TestSummarizeNamesUnknownItems(t *testing.T) {
	video := Quote(catalogTable(t, "seedance-2.0"), Target{Kind: "video", Resolution: "720p", Seconds: 5})
	image := Quote(catalogTable(t, "gpt-image-2"), Target{Kind: "image", Size: "1024x1024", Quality: "low"})
	missing := Quote(nil, Target{Kind: "image"})
	cases := []struct {
		items []Estimate
		text  string
	}{
		{[]Estimate{image}, "预计费用：¥0.35"},
		{[]Estimate{video, image}, "预计费用：约 ¥5.32"},
		{[]Estimate{video, image, missing}, "预计费用：已知部分约 ¥5.32，另有 1 项暂无价格"},
		{[]Estimate{missing}, "预计费用：暂无价格，按所选渠道实际计费"},
	}
	for _, tc := range cases {
		if got := Summarize(tc.items).Text; got != tc.text {
			t.Fatalf("got %q, want %q", got, tc.text)
		}
	}
}

func TestFromVideoQuoteReadsModelListQuote(t *testing.T) {
	var seconds, tokens map[string]any
	_ = json.Unmarshal([]byte(`{"currency":"CNY","mode":"seconds","free_reference_images":5,"reference_image":0.813768,"rates":{"768p":{"output":0.610326,"reference_video":0}}}`), &seconds)
	_ = json.Unmarshal([]byte(`{"currency":"CNY","mode":"tokens","rates":{"720p":{"output":46,"reference_video":28}}}`), &tokens)
	got := Quote(FromVideoQuote(seconds), Target{Kind: "video", Resolution: "768p", Seconds: 6, ReferenceImages: 7})
	if got.Amount == nil || *got.Amount != 5.2895 {
		t.Fatalf("seconds quote: %+v", got)
	}
	got = Quote(FromVideoQuote(tokens), Target{Kind: "video", Resolution: "720p", Seconds: 5})
	if got.Amount != nil || !strings.Contains(got.Basis, "¥46/百万 Token") {
		t.Fatalf("token quote without conversion must stay unknown: %+v", got)
	}
}

func TestNormalizeRejectsMalformedRows(t *testing.T) {
	for _, raw := range []string{
		`{"mode":"per_request","per_request_cny":-1}`,
		`{"mode":"per_request","per_second_cny":{"720p":"x"}}`,
		`{"mode":"subscription","per_request_cny":1}`,
		`{"mode":"per_request"}`,
		`{"mode":"per_request","image_price_table":{"output":{"low":{"1K":0}}}}`,
	} {
		if _, ok := Normalize(json.RawMessage(raw)); ok {
			t.Fatalf("accepted %s", raw)
		}
	}
}
