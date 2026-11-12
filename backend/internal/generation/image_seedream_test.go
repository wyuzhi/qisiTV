package generation

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"qisitv/backend/internal/protocol"
)

func TestSeedreamPluginPreservesReferencesAndSystemPrompt(t *testing.T) {
	const inline = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII="
	body, err := seedreamPluginBody(t, Input{
		Prompt:          "combine the references",
		Config:          Config{Model: "seedream-4-0-250828", Size: "3840x2160", SystemPrompt: "keep the subject"},
		ReferenceImages: []Media{{URL: "https://example.test/first.png"}, {DataURL: inline}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(body["image"], []any{"https://example.test/first.png", inline}) || body["prompt"] != "keep the subject\n\ncombine the references" || body["size"] != "3840x2160" || body["watermark"] != false || body["response_format"] != "url" {
		t.Fatalf("body = %#v", body)
	}
	// The plugin owns per-model size validation, including aspect-ratio presets.
	body, err = seedreamPluginBody(t, Input{Prompt: "vertical image", Config: Config{Model: "seedream-4-0-250828", Size: "9:16"}})
	if err != nil || body["size"] != "1440x2560" {
		t.Fatalf("body = %#v, err = %v", body, err)
	}
}

func TestSeedreamInvalidOptionsAreUnsubmitted(t *testing.T) {
	port := &captureImagePort{}
	ctx := WithRuntime(context.Background(), Runtime{Images: port})
	_, err := RunImageTask(ctx, Input{Mode: "image", Prompt: "fixture", Config: Config{Model: "doubao-seedream-5-0-pro-260628", InterfaceType: "volcengine-ark-image", BaseURL: "https://example.test", Size: "4K"}})
	var preparation RequestPreparationError
	if !errors.As(err, &preparation) || port.calls != 0 {
		t.Fatalf("calls = %d, err = %v", port.calls, err)
	}
}

// The installed package must preserve all previously supported image options.
func TestSeedreamDomesticProUsesInstalledArkPlugin(t *testing.T) {
	manifest, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "volcengine-ark-seedream", "manifest.json"))
	if err != nil {
		t.Fatalf("read ark plugin manifest: %v", err)
	}
	adapter, err := protocol.LoadManifest(manifest)
	if err != nil {
		t.Fatalf("load ark plugin manifest: %v", err)
	}
	registry, err := protocol.NewRegistry(adapter)
	if err != nil {
		t.Fatalf("build protocol registry: %v", err)
	}
	if _, ok := registry.Resolve("volcengine-ark-image"); !ok {
		t.Fatal("ark plugin must resolve in this registry")
	}
	port := &captureImagePort{}
	input := Input{Mode: "image", Prompt: "split the layers", Config: Config{
		Model: "doubao-seedream-5-0-pro-260628", BaseURL: "https://beeftv.app", APIKey: "synthetic",
		InterfaceType: "volcengine-ark-image", Size: "16:9", SeedreamMode: "layers",
		SeedreamOutputFormat: "jpeg", SeedreamOptimize: "fast", SeedreamWatermark: "true",
	}, ReferenceImages: []Media{{URL: "https://example.test/source.png"}}}
	ctx := WithProtocolRegistry(offlineImageRuntime(port), registry)
	if _, err := RunImageTask(ctx, input); err != nil {
		t.Fatal(err)
	}
	// A bare third-party Ark gateway retains its existing /v1 endpoint.
	if port.path != "/v1/images/generations" {
		t.Fatalf("path=%q, want the seedream request body path", port.path)
	}
	if port.body["layer_decomposition"] != true || port.body["output_format"] != "jpeg" || port.body["watermark"] != true {
		t.Fatalf("seedream options lost: body=%#v", port.body)
	}
	if optimize, ok := port.body["optimize_prompt_options"].(map[string]interface{}); !ok || optimize["mode"] != "fast" {
		t.Fatalf("optimize option lost: body=%#v", port.body)
	}
}

func TestSeedreamManagedReferencesUseOneJSONGeneration(t *testing.T) {
	port := &captureImagePort{}
	input := Input{Mode: "image", Prompt: "replace object <bbox>10 10 100 100</bbox>", Config: Config{Model: "dola-seedream-5-0-pro-260628", BaseURL: "https://beeftv.app", APIKey: "synthetic", InterfaceType: "openai-image", Size: "1.5K", SeedreamOutputFormat: "png", SeedreamOptimize: "fast"}, ReferenceImages: []Media{{DataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII="}}}
	result, err := RunImageTask(offlineImageRuntime(port), input)
	if err != nil {
		t.Fatal(err)
	}
	if port.calls != 1 || port.path != "/v1/images/generations" || port.contentType != "application/json" || result["mode"] != "image" {
		t.Fatalf("wire=%#v result=%#v", port, result)
	}
	if port.body["image"] == nil || port.body["size"] != "1.5K" || port.body["output_format"] != "png" || port.body["watermark"] != false {
		t.Fatalf("body=%#v", port.body)
	}
	if _, exists := port.body["n"]; exists {
		t.Fatal("n must not be sent to Ark")
	}
}

func TestSeedreamGroupAndLayerOptionsStayInOneRequest(t *testing.T) {
	input := Input{Prompt: "three matching views", Config: Config{Model: "seedream-4-5-251128", Size: "4K", SeedreamMaxImages: "3"}}
	body, err := seedreamPluginBody(t, input)
	if err != nil {
		t.Fatal(err)
	}
	if body["response_format"] != "url" || body["stream"] != true || body["sequential_image_generation"] != "auto" || body["sequential_image_generation_options"].(map[string]any)["max_images"] != 3 {
		t.Fatalf("body=%#v", body)
	}
	if _, exists := body["output_format"]; exists {
		t.Fatalf("Seedream 4.5 must not send output_format: body=%#v", body)
	}
	input.Config.Model = "dola-seedream-5-0-flash-260915"
	input.Config.Size = "2K"
	input.Config.SeedreamMode = "layers"
	if _, err = seedreamPluginBody(t, input); err == nil {
		t.Fatal("layers require a source image")
	}
	input.ReferenceImages = []Media{{URL: "https://example.test/source.png"}}
	body, err = seedreamPluginBody(t, input)
	if err != nil {
		t.Fatal(err)
	}
	if body["layer_decomposition"] != true {
		t.Fatalf("body=%#v", body)
	}
	if _, exists := body["sequential_image_generation"]; exists {
		t.Fatal("Flash must not receive group generation")
	}
}

func TestSeedreamCustomGatewayKeepsConfiguredVersion(t *testing.T) {
	port := &captureImagePort{}
	input := Input{Mode: "image", Prompt: "a cup", Config: Config{Model: "seedream-4-0-250828", BaseURL: "http://127.0.0.1:33022/v1", APIKey: "synthetic", InterfaceType: "openai-image", Size: "1600x600"}}
	_, err := RunImageTask(WithRuntime(context.Background(), Runtime{Images: port}), input)
	if err != nil {
		t.Fatal(err)
	}
	if port.path != "/v1/images/generations" || port.body["size"] != "1600x600" {
		t.Fatalf("wire=%#v", port)
	}
}

func TestSeedreamStreamKeepsDeliveredImagesAfterPartialFailure(t *testing.T) {
	adapter := seedreamTestAdapter(t)
	parser := adapter.(protocol.CreateResponseParser)
	data := []byte("data: {\"type\":\"image_generation.partial_succeeded\",\"image_index\":0,\"url\":\"https://example.test/0.png\"}\n\ndata: {\"type\":\"image_generation.partial_failed\",\"image_index\":1,\"error\":{\"message\":\"filtered\"}}\n\n")
	result, err := parser.ParseCreateResponse(context.Background(), data, "text/event-stream")
	if err != nil || result.Result == nil || len(result.Result.Images) != 1 {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	if _, err := parser.ParseCreateResponse(context.Background(), []byte("data: {\"type\":\"error\",\"error\":{\"message\":\"failed\"}}\n\n"), "text/event-stream"); err == nil {
		t.Fatal("empty stream must fail")
	}
	if wrongType, err := parser.ParseCreateResponse(context.Background(), data, "application/json"); err != nil || wrongType.Result == nil || len(wrongType.Result.Images) != 1 {
		t.Fatal("declared SSE result was lost when gateway mislabeled content type")
	}
}

// 火山官方渠道上的国内型号也要走 Seedream 自己的请求体：图层拆分、图片格式、
// 水印和提示词优化都是用户选过的，改走通用插件会静默变成普通生图。
func TestSeedreamDomesticProKeepsConfiguredOptionsOnArkChannel(t *testing.T) {
	port := &captureImagePort{}
	input := Input{Mode: "image", Prompt: "split the layers", Config: Config{
		Model: "doubao-seedream-5-0-pro-260628", BaseURL: "https://beeftv.app", APIKey: "synthetic",
		InterfaceType: "volcengine-ark-image", Size: "16:9", SeedreamMode: "layers",
		SeedreamOutputFormat: "jpeg", SeedreamOptimize: "fast", SeedreamWatermark: "true",
	}, ReferenceImages: []Media{{URL: "https://example.test/source.png"}}}
	if _, err := RunImageTask(offlineImageRuntime(port), input); err != nil {
		t.Fatal(err)
	}
	if port.calls != 1 {
		t.Fatalf("calls=%d", port.calls)
	}
	if port.body["layer_decomposition"] != true || port.body["output_format"] != "jpeg" || port.body["watermark"] != true {
		t.Fatalf("seedream options lost: body=%#v", port.body)
	}
	if optimize, ok := port.body["optimize_prompt_options"].(map[string]interface{}); !ok || optimize["mode"] != "fast" {
		t.Fatalf("optimize option lost: body=%#v", port.body)
	}
	// 图层拆分只能按档位出图，比例由上游按原图保持。
	if port.body["size"] != "2K" {
		t.Fatalf("size=%#v", port.body["size"])
	}
}

// Agent Plan 图片协议是独立端点（/api/plan/v3/images/generations），只有声明式插件
// 知道那个地址；国内 Seedream 型号名不能把 Agent Plan 渠道拐到官方 Ark 路径上。
func TestSeedreamPluginMissingNeverFallsBack(t *testing.T) {
	registry, err := protocol.NewRegistry()
	if err != nil {
		t.Fatal(err)
	}
	for _, interfaceType := range []string{"volcengine-ark-image", "volcengine-ark-agent-plan-image", "openai-image"} {
		port := &captureImagePort{}
		ctx := WithProtocolRegistry(WithRuntime(context.Background(), Runtime{Images: port}), registry)
		_, err := RunImageTask(ctx, Input{Mode: "image", Prompt: "x", Config: Config{Model: "doubao-seedream-5-0-pro-260628", InterfaceType: interfaceType, BaseURL: "https://example.test", Size: "2K"}})
		if err == nil || port.calls != 0 {
			t.Fatalf("%s: calls=%d err=%v", interfaceType, port.calls, err)
		}
	}
}

func TestSeedreamDomesticFlashIsNotTreatedAsLite(t *testing.T) {
	// Lite 会拒绝图层拆分与透明背景；国内 Flash 被当成 Lite 时这些能力会被误判。
	input := Input{Prompt: "layers", Config: Config{Model: "doubao-seedream-5-0-flash-260915", Size: "1.5K", SeedreamMode: "layers"}, ReferenceImages: []Media{{URL: "https://example.test/source.png"}}}
	body, err := seedreamPluginBody(t, input)
	if err != nil {
		t.Fatal(err)
	}
	if body["layer_decomposition"] != true || body["size"] != "1.5K" {
		t.Fatalf("body=%#v", body)
	}
	input.Config.Size = "4K"
	if _, err := seedreamPluginBody(t, input); err == nil {
		t.Fatal("flash must reject the 4K tier")
	}
}

func TestSeedreamRequestBodyFollowsPerModelSizeRules(t *testing.T) {
	for _, item := range []struct {
		model, size, want string
		reject            bool
	}{
		{model: "seedream-4-0-250828", size: "16:9", want: "2560x1440"},
		{model: "seedream-4-0-250828", size: "1600x600", want: "1600x600"},
		{model: "seedream-4-5-251128", size: "5504x3040", want: "5504x3040"},
		{model: "seedream-4-5-251128", size: "1500x1500", reject: true},
		{model: "doubao-seedream-5-0-pro-260628", size: "4K", reject: true},
		{model: "doubao-seedream-5-0-260128", size: "3K", want: "3K"},
	} {
		body, err := seedreamPluginBody(t, Input{Prompt: "x", Config: Config{Model: item.model, Size: item.size}})
		if item.reject {
			if err == nil {
				t.Fatalf("%s %q should be rejected, body=%#v", item.model, item.size, body)
			}
			continue
		}
		if err != nil || body["size"] != item.want {
			t.Fatalf("%s %q -> %#v, %v; want %q", item.model, item.size, body["size"], err, item.want)
		}
	}
}

// 尺寸不合规要在发出付费请求之前就失败，不能等上游 400。
func TestSeedreamRejectsUnsupportedSizeBeforeSending(t *testing.T) {
	port := &captureImagePort{}
	input := Input{Mode: "image", Prompt: "x", Config: Config{Model: "seedream-4-5-251128", BaseURL: "https://beeftv.app", APIKey: "synthetic", InterfaceType: "openai-image", Size: "1K"}}
	if _, err := RunImageTask(WithRuntime(context.Background(), Runtime{Images: port}), input); err == nil {
		t.Fatal("unsupported size must be rejected")
	}
	if port.calls != 0 {
		t.Fatalf("calls=%d, want 0", port.calls)
	}
}

// 复查 #45 问题 1：尺寸规则要按生成场景分开。普通生图的官方取值只有档位和宽x高，
// auto 要按默认档位发出（国内型号在通用插件下本来就是 2k）；图层拆分只接受档位和
// auto，显式像素尺寸必须在发出付费请求之前就被拦下。
func TestSeedreamSizeFollowsGenerationSceneBeforeSending(t *testing.T) {
	for _, item := range []struct {
		name, model, size, mode string
		refs                    int
		wantSize                string
		reject                  bool
	}{
		{name: "国内 Pro 普通生图 auto", model: "doubao-seedream-5-0-pro-260628", size: "auto", wantSize: "2K"},
		{name: "国内 Flash 普通生图 auto", model: "doubao-seedream-5-0-flash-260915", size: "auto", wantSize: "2K"},
		{name: "国际 Pro 普通生图 auto", model: "dola-seedream-5-0-pro-260628", size: "auto", wantSize: "2K"},
		{name: "4.5 普通生图 auto", model: "seedream-4-5-251128", size: "auto", wantSize: "2K"},
		{name: "普通生图宽x高", model: "doubao-seedream-5-0-pro-260628", size: "2048x2048", wantSize: "2048x2048"},
		{name: "图层拆分跟随原图", model: "doubao-seedream-5-0-pro-260628", size: "auto", mode: "layers", refs: 1, wantSize: "auto"},
		{name: "图层拆分档位", model: "doubao-seedream-5-0-pro-260628", size: "1.5K", mode: "layers", refs: 1, wantSize: "1.5K"},
		{name: "国内 Pro 图层拆分像素", model: "doubao-seedream-5-0-pro-260628", size: "2048x2048", mode: "layers", refs: 1, reject: true},
		{name: "国际 Pro 图层拆分像素", model: "dola-seedream-5-0-pro-260628", size: "2048x2048", mode: "layers", refs: 1, reject: true},
		{name: "国内 Flash 图层拆分像素", model: "doubao-seedream-5-0-flash-260915", size: "2048x2048", mode: "layers", refs: 1, reject: true},
		{name: "图层拆分像素过小", model: "doubao-seedream-5-0-pro-260628", size: "1280x720", mode: "layers", refs: 1, reject: true},
	} {
		port := &captureImagePort{}
		input := Input{Mode: "image", Prompt: "x", Config: Config{Model: item.model, BaseURL: "https://beeftv.app", APIKey: "synthetic", InterfaceType: "openai-image", Size: item.size, SeedreamMode: item.mode}}
		for i := 0; i < item.refs; i++ {
			input.ReferenceImages = append(input.ReferenceImages, Media{URL: "https://example.test/source.png"})
		}
		if _, err := RunImageTask(offlineImageRuntime(port), input); err != nil {
			if !item.reject {
				t.Fatalf("%s: %v", item.name, err)
			}
			if port.calls != 0 {
				t.Fatalf("%s: calls=%d, want 0", item.name, port.calls)
			}
			continue
		}
		if item.reject {
			t.Fatalf("%s: request was sent with size=%#v", item.name, port.body["size"])
		}
		if port.calls != 1 || port.body["size"] != item.wantSize {
			t.Fatalf("%s: calls=%d size=%#v, want 1 and %q", item.name, port.calls, port.body["size"], item.wantSize)
		}
	}
}

// Agent Plan 图片协议走 /api/plan/v3/images/generations，只有声明式插件知道那个端点。
// 这里加载仓库真实 Agent Plan manifest，确认国内 Seedream 型号不会被按型号名拐到
// 官方 Ark 的 /v1/images/generations 或 /api/v3 上。
func TestSeedreamAgentPlanChannelSendsToPluginEndpoint(t *testing.T) {
	manifest, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "volcengine-ark-agent-plan-seedream", "manifest.json"))
	if err != nil {
		t.Fatalf("read agent plan plugin manifest: %v", err)
	}
	adapter, err := protocol.LoadManifest(manifest)
	if err != nil {
		t.Fatalf("load agent plan plugin manifest: %v", err)
	}
	registry, err := protocol.NewRegistry(adapter)
	if err != nil {
		t.Fatalf("build protocol registry: %v", err)
	}
	port := &captureImagePort{}
	input := Input{Mode: "image", Prompt: "a cup", Config: Config{
		Model: "doubao-seedream-5-0-pro-260628", BaseURL: "https://ark.cn-beijing.volces.com",
		APIKey: "synthetic", InterfaceType: "volcengine-ark-agent-plan-image", Size: "2K",
	}}
	ctx := WithProtocolRegistry(offlineImageRuntime(port), registry)
	if _, err := RunImageTask(ctx, input); err != nil {
		t.Fatal(err)
	}
	if port.calls != 1 || port.path != "/api/plan/v3/images/generations" {
		t.Fatalf("calls=%d path=%q, want one request to the agent plan endpoint", port.calls, port.path)
	}
	if port.body["size"] != "2K" {
		t.Fatalf("size=%#v, want the configured tier", port.body["size"])
	}
}

func seedreamTestAdapter(t *testing.T) protocol.Adapter {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "volcengine-ark-seedream", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	adapters, err := protocol.LoadInstalledProviders(data)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := protocol.NewRegistry(adapters...)
	if err != nil {
		t.Fatal(err)
	}
	adapter, ok := registry.Resolve("volcengine-ark-image")
	if !ok {
		t.Fatal("installed provider missing")
	}
	return adapter
}
func seedreamPluginBody(t *testing.T, input Input) (map[string]any, error) {
	t.Helper()
	input.Mode = "image"
	spec, err := seedreamTestAdapter(t).BuildCreate(context.Background(), protocol.RequestContext{Request: ProtocolRequestFromInput(input)})
	if err != nil {
		return nil, err
	}
	return ProtocolBodyObject(spec.Body), nil
}

// offlineImageRuntime 让测试不连外网：标记为已完成提交前的元数据探测，请求仍交给 port 检查。
func offlineImageRuntime(port *captureImagePort) context.Context {
	return WithImageReplayProtocol(WithRuntime(context.Background(), Runtime{Images: port}), ImageReplayProtocol)
}
