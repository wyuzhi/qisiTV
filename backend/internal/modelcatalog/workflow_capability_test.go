package modelcatalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

func TestCapabilityNormalizerProjectsPluginWorkflowCapabilities(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "autodl-comfyui.beeftv-plugin"))
	if err != nil {
		t.Fatal(err)
	}
	pkg, err := protocol.ParsePluginPackage(data)
	if err != nil {
		t.Fatal(err)
	}
	normalizer := NewCapabilityNormalizer(func(providerID string, capability protocol.Capability, modelID string) (protocol.ManifestWorkflow, bool) {
		for _, workflow := range pkg.Manifest.Contributes.Workflows {
			if strings.EqualFold(workflow.ProviderID, providerID) && workflow.Capability == capability && strings.EqualFold(workflow.ID, modelID) {
				return workflow, true
			}
		}
		return protocol.ManifestWorkflow{}, false
	})

	cases := []struct {
		model         string
		resolutions   []string
		defaultRes    string
		maxSeconds    int
		defaultSecond int
	}{
		{
			model:         "minimax_h3_b99_003_12s",
			resolutions:   []string{"736p竖", "736p横", "736p(1:1)"},
			defaultRes:    "736p竖",
			maxSeconds:    12,
			defaultSecond: 5,
		},
		{
			model:         "minimax_h3_lightx2v_v5",
			resolutions:   []string{"480p竖", "768p竖", "1080p竖", "480p横", "768p横", "1080p横", "480p(1:1)", "768p(1:1)", "1080p(1:1)"},
			defaultRes:    "768p竖",
			maxSeconds:    10,
			defaultSecond: 5,
		},
		{
			model:         "minimax_h3_image_audio_to_video",
			resolutions:   []string{"480p竖", "768p竖", "1080p竖", "480p横", "768p横", "1080p横"},
			defaultRes:    "768p竖",
			maxSeconds:    15,
			defaultSecond: 5,
		},
	}

	for _, tc := range cases {
		cfg, err := normalizer.NormalizeModelCapabilityDraft(ModelCapabilityDraft{
			Model:      tc.model,
			Capability: "video",
			Protocol:   "autodl-comfyui",
		})
		if err != nil {
			t.Fatalf("%s normalize error: %v", tc.model, err)
		}
		if cfg == nil || cfg.Video == nil {
			t.Fatalf("%s missing video config: %#v", tc.model, cfg)
		}
		if len(cfg.Video.Ratios) != 0 || cfg.Video.DefaultRatio != "" {
			t.Fatalf("%s ratios = %#v (default %q), want empty", tc.model, cfg.Video.Ratios, cfg.Video.DefaultRatio)
		}
		if !slices.Equal(cfg.Video.Resolutions, tc.resolutions) || cfg.Video.DefaultResolution != tc.defaultRes {
			t.Fatalf("%s resolutions = %#v (default %q), want %#v (%q)", tc.model, cfg.Video.Resolutions, cfg.Video.DefaultResolution, tc.resolutions, tc.defaultRes)
		}
		if cfg.Video.Duration.Selection != "range" || cfg.Video.Duration.Min != 1 || cfg.Video.Duration.Max != tc.maxSeconds || cfg.Video.Duration.Default != tc.defaultSecond {
			t.Fatalf("%s duration = %#v, want range 1..%d default %d", tc.model, cfg.Video.Duration, tc.maxSeconds, tc.defaultSecond)
		}
	}
}

func TestWorkflowVideoCapabilityProjectionMatchesSharedFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "fixtures", "workflow-video-capability-projection.json"))
	if err != nil {
		t.Fatalf("读取工作流能力共享夹具失败：%v", err)
	}
	var cases []struct {
		Name     string                    `json:"name"`
		Workflow protocol.ManifestWorkflow `json:"workflow"`
		Expected map[string]any            `json:"expected"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("解析工作流能力共享夹具失败：%v", err)
	}
	for _, item := range cases {
		video := defaultVideoCapabilityConfig(item.Workflow.ProviderID, item.Workflow.ID)
		applyProtocolWorkflowVideoCapability(video, item.Workflow)
		encoded, err := json.Marshal(video)
		if err != nil {
			t.Fatalf("%s 序列化失败：%v", item.Name, err)
		}
		var actual map[string]any
		if err := json.Unmarshal(encoded, &actual); err != nil {
			t.Fatalf("%s 解析失败：%v", item.Name, err)
		}
		assertFixtureSubset(t, item.Name, item.Expected, actual)
	}
}
