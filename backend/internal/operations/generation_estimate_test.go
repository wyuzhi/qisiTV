package operations

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/pricing"
)

type estimateProbe struct {
	proposeProbe
	catalog *modelcatalog.CatalogResponse
}

func (p *estimateProbe) AgentModelCatalog() (*modelcatalog.CatalogResponse, error) {
	return p.catalog, nil
}

func priceRow(t *testing.T, raw string) *pricing.Table {
	t.Helper()
	table, ok := pricing.Normalize(json.RawMessage(raw))
	if !ok {
		t.Fatalf("invalid price row %s", raw)
	}
	return table
}

// The rows are copied from BeefAPI's 2026-11-03 price catalog.
func estimateCatalog(t *testing.T) *modelcatalog.CatalogResponse {
	t.Helper()
	var h3Quote map[string]any
	_ = json.Unmarshal([]byte(`{"currency":"CNY","mode":"seconds","free_reference_images":5,"reference_image":0.813768,"rates":{"768p":{"output":0.610326,"reference_video":0}}}`), &h3Quote)
	image := map[string]any{"image": map[string]any{
		"size":    map[string]any{"parameter": "size", "values": []any{"1024x1024", "2048x2048"}, "default": "1024x1024", "allowCustom": true},
		"quality": map[string]any{"supported": true, "values": []any{"low", "medium", "high"}, "default": "low"},
	}}
	video := map[string]any{"video": map[string]any{"defaultResolution": "720p", "duration": map[string]any{"selection": "list", "values": []any{5, 10}, "default": 5}}}
	response := modelcatalog.NewCatalogResponse(modelcatalog.CatalogSourceSystem, nil, []modelcatalog.PublicChannelCatalog{
		{ID: "beefapi", Models: []modelcatalog.PublicChannelModel{
			{ID: "gpt-image-2", ModelKey: "gpt-image-2", Capability: "image", CapabilityConfig: image,
				Pricing: priceRow(t, `{"mode":"per_request","per_request_cny":0.35,"display_kind":"image","image_price_table":{"output":{"low":{"1K":0.35,"2K":0.7},"high":{"1K":2.2,"2K":4.4}},"reference":0.15,"default_quality":"low","default_size":"1K"}}`)},
			{ID: "seedance-2.0", ModelKey: "seedance-2.0", Capability: "video", CapabilityConfig: video,
				Pricing: priceRow(t, `{"mode":"video_tokens","display_kind":"video","video_token_rates":[{"resolution":"720p","output_cny":46,"input_cny":28}],"video_official":[{"resolution":"720p","output_per_second_cny":0.9936,"input_per_second_cny":0.6048}]}`)},
			{ID: "minimax-h3", ModelKey: "minimax-h3", Capability: "video", VideoPricing: h3Quote},
			{ID: "minimax-speech-2.8-hd", ModelKey: "minimax-speech-2.8-hd", Capability: "audio",
				Pricing: priceRow(t, `{"mode":"tokens","input_cny":350,"output_cny":0,"display_kind":"audio"}`)},
		}},
		{ID: "custom", Models: []modelcatalog.PublicChannelModel{{ID: "my-video", ModelKey: "my-video", Capability: "video"}}},
	})
	return &response
}

func TestGenerationEstimatePricesTargetsFromSavedCatalog(t *testing.T) {
	probe := &estimateProbe{catalog: estimateCatalog(t)}
	got := EstimateGenerationCost(probe, []EstimateTarget{
		{ModelKey: "beefapi::gpt-image-2", Kind: "image", Parameters: map[string]string{"size": "1024x1024", "quality": "low", "count": "2"}, ReferenceImages: 1},
		{ModelKey: "beefapi::seedance-2.0", Kind: "video"},
		{ModelKey: "beefapi::minimax-h3", Kind: "video", Parameters: map[string]string{"vquality": "768p", "seconds": "6"}},
		{ModelKey: "beefapi::minimax-speech-2.8-hd", Kind: "audio", Text: "你好，欢迎来到牛肉粉"},
		{ModelKey: "custom::my-video", Kind: "video", Parameters: map[string]string{"vquality": "720p", "seconds": "5"}},
	})
	want := []struct {
		amount float64
		basis  string
	}{
		{0.85, "1K 低质量 ¥0.35/张 × 2 张 + 参考图 1 张 × ¥0.15"},
		{4.968, "720p ¥0.9936/秒 × 5 秒，按 Token 折算"},
		{3.662, "768p ¥0.6103/秒 × 6 秒"},
		{0.0035, "10 字 × ¥350/百万字"},
	}
	for i, item := range want {
		if got.Items[i].Amount == nil || *got.Items[i].Amount != item.amount || got.Items[i].Basis != item.basis {
			t.Fatalf("item %d: %+v, want %v %q", i, got.Items[i], item.amount, item.basis)
		}
	}
	if byok := got.Items[4]; byok.Amount != nil || byok.Basis != "自带 Key 的渠道暂无价格，按该渠道实际计费" {
		t.Fatalf("a bring-your-own-key channel must stay unpriced: %+v", byok)
	}
	if got.Summary.Text != "预计费用：已知部分约 ¥9.48，另有 1 项暂无价格" {
		t.Fatalf("summary: %+v", got.Summary)
	}
}

func TestOpGenerationProposeCarriesEstimate(t *testing.T) {
	node := imageNode("n1", "")
	node["metadata"].(map[string]any)["size"] = "2048x2048"
	node["metadata"].(map[string]any)["quality"] = "high"
	probe := &estimateProbe{catalog: estimateCatalog(t)}
	probe.doc = proposeCanvas(t, []map[string]any{node})
	result, err := opCanvasGenerationPropose(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"canvasId":"c1","nodeIds":["n1"],"kind":"image"}`))
	if err != nil {
		t.Fatal(err)
	}
	payload := result.(map[string]any)
	if summary, ok := payload["estimate"].(pricing.Summary); !ok || summary.Text != "预计费用：¥4.4" {
		t.Fatalf("proposal summary: %#v", payload["estimate"])
	}
	targets := payload["targets"].([]map[string]any)
	if item, ok := targets[0]["estimate"].(pricing.Estimate); !ok || item.Amount == nil || *item.Amount != 4.4 {
		t.Fatalf("target estimate: %#v", targets[0]["estimate"])
	}
}

func TestGenerationEstimateOpRejectsUnknownKinds(t *testing.T) {
	registry := &Registry{}
	registerGenerationEstimateOp(registry)
	op, ok := registry.ops["generation.estimate"]
	if !ok || !op.ReadOnly {
		t.Fatal("generation.estimate must be a registered read-only operation")
	}
	if _, err := op.Handler(&Context{Domain: &estimateProbe{catalog: estimateCatalog(t)}}, json.RawMessage(`{"targets":[{"modelKey":"beefapi::gpt-image-2","kind":"text"}]}`)); err == nil {
		t.Fatal("a text target was accepted")
	}
}

func TestModelCatalogLeavesPriceRowsToTheEstimate(t *testing.T) {
	probe := &estimateProbe{catalog: estimateCatalog(t)}
	registry := &Registry{}
	registerModelCatalogOp(registry)
	for _, params := range []string{`{}`, `{"capability":"image"}`} {
		result, err := registry.ops["model.catalog"].Handler(&Context{Domain: probe}, json.RawMessage(params))
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(result)
		if strings.Contains(string(raw), `"pricing"`) || !strings.Contains(string(raw), "gpt-image-2") {
			t.Fatalf("catalog %s: %s", params, raw)
		}
	}
	got := EstimateGenerationCost(probe, []EstimateTarget{{ModelKey: "beefapi::gpt-image-2", Kind: "image"}})
	if got.Items[0].Amount == nil || *got.Items[0].Amount != 0.35 {
		t.Fatalf("estimate lost the price row: %+v", got.Items[0])
	}
}
