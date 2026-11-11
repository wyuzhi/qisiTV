package plugins

import (
	"context"
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

func decodeSpecBody(t *testing.T, spec protocol.RequestSpec) map[string]any {
	t.Helper()
	raw, err := json.Marshal(spec.Body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}
	return out
}

func loadYsduiRegistry(t *testing.T) *protocol.Registry {
	t.Helper()
	rt, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatalf("NewRuntime: %v", err)
	}
	return rt.Registry()
}

func TestYsduiImageManifestFollowsPerModelDocumentation(t *testing.T) {
	reg := loadYsduiRegistry(t)
	adapter, ok := reg.Resolve("ysdui-image")
	if !ok {
		t.Fatal("ysdui-image not registered")
	}

	t.Run("Seedream 5.0 Pro never sends sequential_image_generation and supports tiers, transparent, and layers", func(t *testing.T) {
		for _, count := range []int{1, 4} {
			spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
				BaseURL: "https://tokenhub.ysdui.cn",
				Request: protocol.GenerationRequest{
					Model:        "doubao-seedream-5-0-pro-260628",
					Instructions: "studio lighting",
					Prompt:       "product shot",
					AspectRatio:  "16:9",
					ImageCount:   count,
					Watermark:    true,
					Output: protocol.OutputOptions{
						Watermark: true,
						Options:   map[string]any{"maxImages": 4, "watermark": "true"},
					},
				},
			})
			if err != nil {
				t.Fatalf("BuildCreate count=%d: %v", count, err)
			}
			body := decodeSpecBody(t, spec)
			for _, forbidden := range []string{"sequential_image_generation", "sequential_image_generation_options", "n", "prompt_extend"} {
				if _, exists := body[forbidden]; exists {
					t.Fatalf("Seedream 5.0 Pro count=%d must omit %s, got %#v", count, forbidden, body)
				}
			}
			if body["size"] != "2560x1440" || body["prompt"] != "studio lighting\n\nproduct shot" || body["watermark"] != true {
				t.Fatalf("unexpected Seedream 5.0 Pro body: %#v", body)
			}
		}

		tierSpec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
			BaseURL: "https://tokenhub.ysdui.cn",
			Request: protocol.GenerationRequest{
				Model:       "doubao-seedream-5-0-pro-260628",
				Prompt:      "transparent icon",
				AspectRatio: "1.5k",
				Extra:       map[string]any{"transparentBackground": true},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		tierBody := decodeSpecBody(t, tierSpec)
		if tierBody["size"] != "1.5K" || tierBody["background"] != "transparent" || tierBody["output_format"] != "png" {
			t.Fatalf("unexpected Seedream 5.0 Pro tier/transparent body: %#v", tierBody)
		}

		layerSpec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
			BaseURL: "https://tokenhub.ysdui.cn",
			Request: protocol.GenerationRequest{
				Model:       "doubao-seedream-5-0-pro-260628",
				Prompt:      "decompose layers",
				AspectRatio: "16:9",
				Images:      []protocol.MediaReference{{URL: "https://cdn.example.test/src.png"}},
				Output:      protocol.OutputOptions{Options: map[string]any{"mode": "layers"}},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		layerBody := decodeSpecBody(t, layerSpec)
		if layerBody["layer_decomposition"] != true || layerBody["size"] != "2K" {
			t.Fatalf("Seedream 5.0 Pro layer decomposition must send size=2K, got %#v", layerBody)
		}
	})

	t.Run("Seedream 5.0 Lite separates batch imageCount from sequential group maxImages", func(t *testing.T) {
		batchSpec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
			BaseURL: "https://tokenhub.ysdui.cn",
			Request: protocol.GenerationRequest{
				Model:       "doubao-seedream-5-0-260128",
				Prompt:      "batch single",
				AspectRatio: "4k",
				ImageCount:  4,
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		batchBody := decodeSpecBody(t, batchSpec)
		if batchBody["size"] != "4K" {
			t.Fatalf("want 4K size tier, got %#v", batchBody["size"])
		}
		if _, exists := batchBody["sequential_image_generation"]; exists {
			t.Fatalf("batch count without group maxImages must not trigger sequential_image_generation: %#v", batchBody)
		}

		groupSpec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
			BaseURL: "https://tokenhub.ysdui.cn",
			Request: protocol.GenerationRequest{
				Model:       "doubao-seedream-5-0-260128",
				Prompt:      "storyboard four panels",
				AspectRatio: "16:9",
				Output:      protocol.OutputOptions{Options: map[string]any{"mode": "group", "maxImages": 4}},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		groupBody := decodeSpecBody(t, groupSpec)
		opts, _ := groupBody["sequential_image_generation_options"].(map[string]any)
		if groupBody["sequential_image_generation"] != "auto" || opts["max_images"] != float64(4) {
			t.Fatalf("expected sequential group options on Lite, got %#v", groupBody)
		}

		clippedSpec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
			BaseURL: "https://tokenhub.ysdui.cn",
			Request: protocol.GenerationRequest{
				Model:  "doubao-seedream-5-0-260128",
				Prompt: "series with references",
				Images: []protocol.MediaReference{
					{URL: "https://cdn.example.test/1.png"},
					{URL: "https://cdn.example.test/2.png"},
					{URL: "https://cdn.example.test/3.png"},
				},
				Output: protocol.OutputOptions{
					Options: map[string]any{"maxImages": "15"},
				},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		clippedBody := decodeSpecBody(t, clippedSpec)
		clippedOpts, _ := clippedBody["sequential_image_generation_options"].(map[string]any)
		if clippedBody["sequential_image_generation"] != "auto" || clippedOpts["max_images"] != float64(12) {
			t.Fatalf("expected max_images clipped to 12 (15 - 3 refs), got %#v", clippedBody)
		}

		 fourteenRefs := make([]protocol.MediaReference, 14)
		for i := range fourteenRefs {
			fourteenRefs[i] = protocol.MediaReference{URL: "https://cdn.example.test/ref.png"}
		}
		fullRefSpec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
			BaseURL: "https://tokenhub.ysdui.cn",
			Request: protocol.GenerationRequest{
				Model:  "doubao-seedream-5-0-260128",
				Prompt: "14 refs",
				Images: fourteenRefs,
				Output: protocol.OutputOptions{
					Options: map[string]any{"maxImages": "15"},
				},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		fullRefBody := decodeSpecBody(t, fullRefSpec)
		if _, exists := fullRefBody["sequential_image_generation"]; exists {
			t.Fatalf("14 references leave only 1 output slot and must omit sequential_image_generation: %#v", fullRefBody)
		}

		layerTierSpec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
			BaseURL: "https://tokenhub.ysdui.cn",
			Request: protocol.GenerationRequest{
				Model:       "doubao-seedream-5-0-pro-260628",
				Prompt:      "layers with 1K selected",
				AspectRatio: "1K",
				Output: protocol.OutputOptions{
					Options: map[string]any{"mode": "layers"},
				},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		layerTierBody := decodeSpecBody(t, layerTierSpec)
		if layerTierBody["layer_decomposition"] != true || layerTierBody["size"] != "2K" {
			t.Fatalf("layers mode with 1K tier must send documented 2K size, got %#v", layerTierBody)
		}
	})

	t.Run("Qwen Image 3.0 Pro and Hunyuan Image 3.0 use their own documented fields and sizes", func(t *testing.T) {
		qwenSpec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
			BaseURL: "https://tokenhub.ysdui.cn",
			Request: protocol.GenerationRequest{
				Model:       "qwen-image-3.0-pro",
				Prompt:      "poster",
				AspectRatio: "16:9",
				Quality:     "1k",
				ImageCount:  3,
				ProviderOptions: map[string]map[string]any{
					"ysdui-image": {"negative_prompt": "low quality"},
				},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		qwenBody := decodeSpecBody(t, qwenSpec)
		if qwenBody["size"] != "1280x720" || qwenBody["n"] != float64(3) || qwenBody["negative_prompt"] != "low quality" {
			t.Fatalf("unexpected qwen-image-3.0-pro body: %#v", qwenBody)
		}
		for _, forbidden := range []string{"sequential_image_generation", "background", "output_format"} {
			if _, exists := qwenBody[forbidden]; exists {
				t.Fatalf("qwen-image-3.0-pro must omit %s: %#v", forbidden, qwenBody)
			}
		}

		hySpec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
			BaseURL: "https://tokenhub.ysdui.cn",
			Request: protocol.GenerationRequest{
				Model:       "hy-image-v3.0",
				Prompt:      "watercolor",
				AspectRatio: "3:2",
				ImageCount:  4,
				Watermark:   true,
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		hyBody := decodeSpecBody(t, hySpec)
		if hyBody["size"] != "1152x768" {
			t.Fatalf("hy-image-v3.0 3:2 must map to documented 1152x768, got %#v", hyBody["size"])
		}
		for _, forbidden := range []string{"n", "watermark", "sequential_image_generation", "prompt_extend"} {
			if _, exists := hyBody[forbidden]; exists {
				t.Fatalf("hy-image-v3.0 must omit %s: %#v", forbidden, hyBody)
			}
		}
	})
}

func TestYsduiVideoManifestIsolatesVendorParameters(t *testing.T) {
	reg := loadYsduiRegistry(t)
	adapter, ok := reg.Resolve("ysdui-video")
	if !ok {
		t.Fatal("ysdui-video not registered")
	}

	seedanceSpec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
		BaseURL: "https://tokenhub.ysdui.cn",
		Request: protocol.GenerationRequest{
			Model:       "doubao-seedance-2-0-260128",
			Prompt:      "camera pan",
			Resolution:  "4k",
			AspectRatio: "16:9",
			Extra:       map[string]any{"videoSeconds": "-1", "generateAudio": false},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	seedanceBody := decodeSpecBody(t, seedanceSpec)
	if seedanceBody["resolution"] != "4K" || seedanceBody["duration"] != float64(-1) || seedanceBody["generate_audio"] != false {
		t.Fatalf("unexpected Seedance body: %#v", seedanceBody)
	}

	seedanceDefaultSpec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
		BaseURL: "https://tokenhub.ysdui.cn",
		Request: protocol.GenerationRequest{
			Model:  "doubao-seedance-2-0-260128",
			Prompt: "default audio",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	seedanceDefaultBody := decodeSpecBody(t, seedanceDefaultSpec)
	if _, exists := seedanceDefaultBody["generate_audio"]; exists {
		t.Fatalf("unset generateAudio must be omitted so upstream keeps default true, got %#v", seedanceDefaultBody)
	}

	wanEditSpec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
		BaseURL: "https://tokenhub.ysdui.cn",
		Request: protocol.GenerationRequest{
			Model:       "wan3.0-video",
			Prompt:      "替换背景",
			Operation:   "inpaint",
			AspectRatio: "16:9",
			Videos:      []protocol.MediaReference{{URL: "https://cdn.example.test/ref.mp4"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	wanEditBody := decodeSpecBody(t, wanEditSpec)
	if wanEditBody["ratio"] != "adaptive" || wanEditBody["duration"] != float64(-1) {
		t.Fatalf("wan3.0-video edit must send ratio=adaptive and duration=-1, got %#v", wanEditBody)
	}
	if _, exists := wanEditBody["reference_mode"]; exists {
		t.Fatalf("wan3.0-video must not send Doubao reference_mode: %#v", wanEditBody)
	}

	for _, tc := range []struct {
		model          string
		inResolution   string
		wantResolution string
	}{
		{model: "minimax-h3", inResolution: "2k", wantResolution: "2K"},
		{model: "wand-vega-video-1.0-lite", inResolution: "720p", wantResolution: "768P"},
	} {
		spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{
			BaseURL: "https://tokenhub.ysdui.cn",
			Request: protocol.GenerationRequest{
				Model:         tc.model,
				Prompt:        "ocean waves",
				Resolution:    tc.inResolution,
				GenerateAudio: true,
				Watermark:     true,
				Extra:         map[string]any{"generateAudio": false},
			},
		})
		if err != nil {
			t.Fatalf("%s: %v", tc.model, err)
		}
		body := decodeSpecBody(t, spec)
		if body["resolution"] != tc.wantResolution {
			t.Fatalf("%s resolution=%#v, want %q", tc.model, body["resolution"], tc.wantResolution)
		}
		for _, forbidden := range []string{"generate_audio", "watermark", "reference_mode", "output_format", "return_last_frame", "prompt_extend"} {
			if _, exists := body[forbidden]; exists {
				t.Fatalf("%s must omit %s: %#v", tc.model, forbidden, body)
			}
		}
	}
}
