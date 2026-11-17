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
		maxImages     int
		maxAudios     int
		wantOps       []string
	}{
		{
			model:         "minimax_h3_b99_001",
			resolutions:   []string{"736p竖", "736p横", "736p(1:1)"},
			defaultRes:    "736p竖",
			maxSeconds:    15,
			defaultSecond: 5,
			maxImages:     0,
			maxAudios:     0,
			wantOps:       []string{"text_to_video"},
		},
		{
			model:         "minimax_h3_b99_003_12s",
			resolutions:   []string{"736p竖", "736p横", "736p(1:1)"},
			defaultRes:    "736p竖",
			maxSeconds:    12,
			defaultSecond: 5,
			maxImages:     9,
			maxAudios:     0,
			wantOps:       []string{"text_to_video", "image_to_video", "reference_to_video"},
		},
		{
			model:         "minimax_h3_lightx2v_v5",
			resolutions:   []string{"480p竖", "768p竖", "1080p竖", "480p横", "768p横", "1080p横", "480p(1:1)", "768p(1:1)", "1080p(1:1)"},
			defaultRes:    "768p竖",
			maxSeconds:    10,
			defaultSecond: 5,
			maxImages:     9,
			maxAudios:     0,
			wantOps:       []string{"text_to_video", "image_to_video", "reference_to_video"},
		},
		{
			model:         "minimax_h3_image_audio_to_video",
			resolutions:   []string{"480p竖", "768p竖", "1080p竖", "480p横", "768p横", "1080p横"},
			defaultRes:    "768p竖",
			maxSeconds:    15,
			defaultSecond: 5,
			maxImages:     1,
			maxAudios:     3,
			wantOps:       []string{"image_to_video", "reference_to_video"},
		},
		{
			model:         "minimax_h3_image_audio_to_video_v2",
			resolutions:   []string{"480p竖", "768p竖", "1080p竖", "480p横", "768p横", "1080p横"},
			defaultRes:    "768p竖",
			maxSeconds:    10,
			defaultSecond: 5,
			maxImages:     9,
			maxAudios:     3,
			wantOps:       []string{"text_to_video", "image_to_video", "reference_to_video"},
		},
		{
			model:         "minimax_h3_zm_u24",
			resolutions:   []string{"480p竖", "768p竖", "480p横", "768p横", "480p(1:1)", "768p(1:1)"},
			defaultRes:    "768p竖",
			maxSeconds:    15,
			defaultSecond: 5,
			maxImages:     9,
			maxAudios:     0,
			wantOps:       []string{"text_to_video", "image_to_video", "reference_to_video"},
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
		if cfg.Video.References.MaxImages != tc.maxImages || cfg.Video.References.MaxAudios != tc.maxAudios || !slices.Equal(cfg.Video.Operations, tc.wantOps) {
			t.Fatalf("%s media projection mismatch: refs=%#v ops=%#v", tc.model, cfg.Video.References, cfg.Video.Operations)
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

func TestPublicCatalogFromLocalSnapshotUpgradesSavedWorkflowProfiles(t *testing.T) {
	snapshot := []byte(`{
		"channels": [{
			"id": "autodl",
			"name": "AutoDL",
			"baseUrl": "https://autodl.art",
			"models": ["minimax_h3_image_audio_to_video", "minimax_h3_zm_u24", "minimax_h3_zm_u24_versioned", "minimax_h3_zm_u24_other_versions"],
			"modelProfiles": [
				{
					"model": "minimax_h3_image_audio_to_video",
					"capability": "video",
					"protocol": "autodl-comfyui",
					"capabilityConfig": {
						"version": 1,
						"video": {
							"references": { "maxImages": 9, "maxAudios": 0 },
							"ratios": [],
							"defaultRatio": "",
							"resolutions": ["768p竖"],
							"defaultResolution": "768p竖",
							"operations": ["text_to_video", "image_to_video"],
							"defaultOperation": "text_to_video"
						}
					}
				},
				{
					"model": "minimax_h3_zm_u24",
					"capability": "video",
					"protocol": "autodl-comfyui",
					"capabilitySource": "user",
					"capabilityConfig": {
						"version": 1,
						"video": {
							"references": { "promptMaxChars": 0, "minImages": 0, "maxImages": 3, "maxImageBytes": 31457280, "maxVideos": 0, "maxVideoBytes": 0, "maxVideoDurationSeconds": 0, "maxAudios": 0, "maxAudioBytes": 0, "maxAudioDurationSeconds": 0 },
							"duration": { "selection": "range", "min": 1, "max": 15, "step": 1, "default": 5 },
							"ratios": [],
							"defaultRatio": "",
							"resolutions": ["768p竖"],
							"defaultResolution": "768p竖",
							"generateAudio": { "supported": false, "default": false },
							"watermark": { "supported": false, "default": false },
							"operations": ["text_to_video", "image_to_video"],
							"defaultOperation": "text_to_video"
						}
					}
				},
				{
					"model": "minimax_h3_zm_u24_versioned",
					"capability": "video",
					"protocol": "autodl-comfyui",
					"videoCapabilitiesVersion": "gw-v1",
					"capabilityConfig": {
						"version": 1,
						"video": {
							"references": { "promptMaxChars": 0, "minImages": 0, "maxImages": 9, "maxImageBytes": 31457280, "maxVideos": 0, "maxVideoBytes": 0, "maxVideoDurationSeconds": 0, "maxAudios": 0, "maxAudioBytes": 0, "maxAudioDurationSeconds": 0 },
							"duration": { "selection": "range", "min": 1, "max": 15, "step": 1, "default": 5 },
							"ratios": [],
							"defaultRatio": "",
							"resolutions": ["768p竖"],
							"defaultResolution": "768p竖",
							"generateAudio": { "supported": false, "default": false },
							"watermark": { "supported": false, "default": false },
							"operations": ["text_to_video", "image_to_video"],
							"defaultOperation": "text_to_video"
						}
					}
				},
				{
					"model": "minimax_h3_zm_u24_other_versions",
					"capability": "video",
					"protocol": "autodl-comfyui",
					"imageCapabilitiesVersion": "img-v1",
					"mediaCapabilitiesVersion": "aud-v1",
					"capabilityConfig": {
						"version": 1,
						"video": {
							"references": { "promptMaxChars": 0, "minImages": 0, "maxImages": 9, "maxImageBytes": 31457280, "maxVideos": 0, "maxVideoBytes": 0, "maxVideoDurationSeconds": 0, "maxAudios": 0, "maxAudioBytes": 0, "maxAudioDurationSeconds": 0 },
							"duration": { "selection": "range", "min": 1, "max": 15, "step": 1, "default": 5 },
							"ratios": [],
							"defaultRatio": "",
							"resolutions": ["768p竖"],
							"defaultResolution": "768p竖",
							"generateAudio": { "supported": false, "default": false },
							"watermark": { "supported": false, "default": false },
							"operations": ["text_to_video", "image_to_video"],
							"defaultOperation": "text_to_video"
						}
					}
				}
			]
		}]
	}`)

	max1, max3 := 1, 3
	lookup := func(providerID string, capability protocol.Capability, modelID string) (protocol.ManifestWorkflow, bool) {
		if providerID != "autodl-comfyui" || capability != protocol.CapabilityVideo {
			return protocol.ManifestWorkflow{}, false
		}
		if modelID == "minimax_h3_image_audio_to_video" {
			return protocol.ManifestWorkflow{
				ID:         "minimax_h3_image_audio_to_video",
				ProviderID: "autodl-comfyui",
				Capability: protocol.CapabilityVideo,
				Parameters: []protocol.Parameter{
					{Name: "resolution", Type: "string", Mapping: "resolution", Values: []string{"768p竖", "768p横"}},
					{Name: "images", Type: "array", Mapping: "images", Max: &max1},
					{Name: "audios", Type: "array", Mapping: "audios", Max: &max3},
				},
			}, true
		}
		return protocol.ManifestWorkflow{
			ID:         "minimax_h3_zm_u24",
			ProviderID: "autodl-comfyui",
			Capability: protocol.CapabilityVideo,
			Parameters: []protocol.Parameter{
				{Name: "prompt", Type: "string", Required: true, Mapping: "prompt"},
				{Name: "images", Type: "array", Mapping: "images", Max: &max3},
			},
		}, true
	}

	catalog, err := PublicCatalogFromLocalSnapshot(snapshot, lookup)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Channels) != 1 || len(catalog.Channels[0].Models) != 4 {
		t.Fatalf("unexpected catalog = %#v", catalog)
	}
	findVideo := func(modelID string) map[string]any {
		for _, m := range catalog.Channels[0].Models {
			if m.ID == modelID {
				return m.CapabilityConfig["video"].(map[string]any)
			}
		}
		t.Fatalf("missing model %s", modelID)
		return nil
	}

	upgraded := findVideo("minimax_h3_image_audio_to_video")
	refs := upgraded["references"].(map[string]any)
	if refs["maxImages"] != float64(1) || refs["maxAudios"] != float64(3) {
		t.Fatalf("stale pre-2.2.0 profile not upgraded: refs=%#v", refs)
	}
	if ops, _ := upgraded["operations"].([]any); len(ops) != 2 || ops[0] != "image_to_video" || ops[1] != "reference_to_video" {
		t.Fatalf("upgraded operations mismatch: %#v", upgraded["operations"])
	}

	userKept := findVideo("minimax_h3_zm_u24")
	userRefs := userKept["references"].(map[string]any)
	if userRefs["maxImages"] != float64(3) {
		t.Fatalf("user custom maxImages altered: %#v", userRefs)
	}
	if ops, _ := userKept["operations"].([]any); len(ops) != 2 || ops[1] != "image_to_video" {
		t.Fatalf("user custom operations altered: %#v", userKept["operations"])
	}

	versionedKept := findVideo("minimax_h3_zm_u24_versioned")
	versionedRefs := versionedKept["references"].(map[string]any)
	if versionedRefs["maxImages"] != float64(9) {
		t.Fatalf("versioned maxImages altered: %#v", versionedRefs)
	}
	if ops, _ := versionedKept["operations"].([]any); len(ops) != 2 || ops[1] != "image_to_video" {
		t.Fatalf("versioned operations altered: %#v", versionedKept["operations"])
	}

	unrelatedUpgraded := findVideo("minimax_h3_zm_u24_other_versions")
	unrelatedRefs := unrelatedUpgraded["references"].(map[string]any)
	if unrelatedRefs["maxImages"] != float64(3) {
		t.Fatalf("video profile with only image/media version was not upgraded: %#v", unrelatedRefs)
	}
}
