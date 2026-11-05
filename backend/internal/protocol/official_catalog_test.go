package protocol

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const (
	manifestContractStart            = "<!-- BEEFTV_PLUGIN_MANIFEST_START -->"
	manifestContractEnd              = "<!-- BEEFTV_PLUGIN_MANIFEST_END -->"
	manifestDocumentationPlaceholder = "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>"
)

func TestOfficialProtocolPackagesAreSelfContainedDeclarativePlugins(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join("..", "..", "..", "plugin-packages", "*.beeftv-plugin"))
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) < 70 {
		t.Fatalf("official protocol packages = %d, want at least 70", len(paths))
	}
	providerOwners := map[string]string{}
	for _, path := range paths {
		if strings.HasPrefix(filepath.Base(path), "official-payment-") {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		pkg, err := ParsePluginPackage(data)
		if err != nil {
			t.Fatalf("parse %s: %v", filepath.Base(path), err)
		}
		if pkg.Manifest.APIVersion != "beeftv.plugin/v2" && pkg.Manifest.APIVersion != "beeftv.plugin/v3" {
			t.Fatalf("%s apiVersion = %q", filepath.Base(path), pkg.Manifest.APIVersion)
		}
		if len(pkg.Files["README.md"]) == 0 || len(pkg.Files["docs/interface.md"]) == 0 {
			t.Fatalf("%s must contain README.md and docs/interface.md", filepath.Base(path))
		}
		interfaceDocs := string(pkg.Files["docs/interface.md"])
		expectedDocumentation := strings.TrimSpace(string(pkg.Files["README.md"])) + "\n\n---\n\n" + strings.TrimSpace(interfaceDocs)
		if strings.TrimSpace(pkg.Manifest.Metadata.Documentation) != expectedDocumentation {
			t.Fatalf("%s manifest.documentation does not contain the packaged README and interface document", filepath.Base(path))
		}
		assertManifestContractMatchesPackage(t, filepath.Base(path), pkg.ManifestRaw, interfaceDocs)
		if !strings.Contains(interfaceDocs, "响应") {
			t.Fatalf("%s interface documentation must describe response mapping", filepath.Base(path))
		}
		for _, field := range pkg.Manifest.Configuration.Fields {
			if !strings.Contains(interfaceDocs, field.Name) {
				t.Fatalf("%s interface documentation is missing configuration field %q", filepath.Base(path), field.Name)
			}
		}
		adapters, err := LoadInstalledProviders(pkg.ManifestRaw)
		if err != nil {
			t.Fatalf("load %s: %v", filepath.Base(path), err)
		}
		if len(adapters) != len(pkg.Manifest.Contributes.Providers) {
			t.Fatalf("%s adapters = %d, providers = %d", filepath.Base(path), len(adapters), len(pkg.Manifest.Contributes.Providers))
		}
		for _, provider := range pkg.Manifest.Contributes.Providers {
			if owner, duplicate := providerOwners[provider.ID]; duplicate {
				t.Fatalf("provider id %q is shared by %s and %s", provider.ID, owner, filepath.Base(path))
			}
			providerOwners[provider.ID] = filepath.Base(path)
			for _, parameter := range provider.Parameters {
				if strings.TrimSpace(parameter.Name) == "" || strings.TrimSpace(parameter.Type) == "" || strings.TrimSpace(parameter.Mapping) == "" || strings.TrimSpace(parameter.Description) == "" {
					t.Fatalf("%s provider %s has incomplete parameter documentation: %#v", filepath.Base(path), provider.ID, parameter)
				}
				if !strings.Contains(interfaceDocs, parameter.Name) {
					t.Fatalf("%s interface documentation is missing provider parameter %q", filepath.Base(path), parameter.Name)
				}
			}
		}
	}
}

func TestOfficialAtlasCloudChatProfile(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "atlascloud-chat.beeftv-plugin"))
	if err != nil {
		t.Fatal(err)
	}
	pkg, err := ParsePluginPackage(data)
	if err != nil {
		t.Fatal(err)
	}
	provider := pkg.Manifest.Contributes.Providers[0]
	if provider.ID != "atlascloud-chat" || provider.BaseURL != "https://api.atlascloud.ai" || provider.Auth.Type != "bearer" {
		t.Fatalf("Atlas Cloud provider metadata = %#v", provider)
	}

	adapter := officialPackageAdapter(t, "atlascloud-chat.beeftv-plugin", "atlascloud-chat")
	spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model:    "openai/gpt-5.6-luna",
		Messages: []Message{{Role: "user", Content: "hello"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	body := manifestTestBody(t, spec)
	if spec.Method != "POST" || spec.Path != "/v1/chat/completions" || body["model"] != "openai/gpt-5.6-luna" {
		t.Fatalf("Atlas Cloud request = %#v, body = %#v", spec, body)
	}
	result, err := adapter.ParseCreate(context.Background(), []byte(`{"choices":[{"message":{"content":"atlas ok"}}],"usage":{"total_tokens":3}}`))
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != StatusSucceeded || result.Result == nil || result.Result.Text != "atlas ok" {
		t.Fatalf("Atlas Cloud response = %#v", result)
	}
}

func assertManifestContractMatchesPackage(t *testing.T, packageName string, manifestRaw []byte, interfaceDocs string) {
	t.Helper()
	start := strings.Index(interfaceDocs, manifestContractStart)
	end := strings.Index(interfaceDocs, manifestContractEnd)
	if start < 0 || end < start {
		t.Fatalf("%s interface documentation has no complete manifest contract", packageName)
	}
	contractSection := interfaceDocs[start:end]
	jsonStart := strings.Index(contractSection, "```json\n")
	if jsonStart < 0 {
		t.Fatalf("%s manifest contract has no JSON block", packageName)
	}
	jsonStart += len("```json\n")
	jsonEnd := strings.Index(contractSection[jsonStart:], "\n```")
	if jsonEnd < 0 {
		t.Fatalf("%s manifest contract JSON block is not terminated", packageName)
	}

	var actual map[string]any
	if err := json.Unmarshal(manifestRaw, &actual); err != nil {
		t.Fatalf("decode %s manifest: %v", packageName, err)
	}
	actual["documentation"] = manifestDocumentationPlaceholder
	var documented map[string]any
	if err := json.Unmarshal([]byte(contractSection[jsonStart:jsonStart+jsonEnd]), &documented); err != nil {
		t.Fatalf("decode %s documented manifest contract: %v", packageName, err)
	}
	if !reflect.DeepEqual(documented, actual) {
		t.Fatalf("%s documented manifest contract does not exactly match manifest.json", packageName)
	}
}

func TestOfficialAgentProfilesMapToolRequestsAndResponses(t *testing.T) {
	requests := map[string]any{
		"chatCompletion": map[string]any{"messages": []any{map[string]any{"role": "user", "content": "inspect"}}, "tools": []any{map[string]any{"type": "function"}}, "tool_choice": "required", "marker": "chat"},
		"responses":      map[string]any{"input": []any{map[string]any{"role": "user", "content": "inspect"}}, "tools": []any{map[string]any{"type": "function"}}, "tool_choice": "required", "marker": "responses"},
		"claude":         map[string]any{"messages": []any{map[string]any{"role": "user", "content": "inspect"}}, "tools": []any{map[string]any{"name": "canvas_get_state"}}, "tool_choice": map[string]any{"type": "any"}, "max_tokens": 512, "marker": "claude"},
		"gemini":         map[string]any{"contents": []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": "inspect"}}}}, "tools": []any{map[string]any{"functionDeclarations": []any{}}}, "toolConfig": map[string]any{"functionCallingConfig": map[string]any{"mode": "ANY"}}, "marker": "gemini"},
	}
	tests := []struct {
		name, packageName, providerID, marker, wantPath, response, wantID, wantSignature string
	}{
		{
			name: "openai-chat", packageName: "openai-chat-completions.beeftv-plugin", providerID: "chat-completion", marker: "chat", wantPath: "/chat/completions", wantID: "call-chat",
			response: `{"choices":[{"message":{"content":"chat answer","tool_calls":[{"id":"call-chat","function":{"name":"canvas_get_state","arguments":"{\"scope\":\"all\"}"}}]}}]}`,
		},
		{
			name: "openai-responses", packageName: "openai-responses.beeftv-plugin", providerID: "openai-response", marker: "responses", wantPath: "/responses", wantID: "call-responses",
			response: `{"output_text":"responses answer","output":[{"type":"message"},{"type":"function_call","call_id":"call-responses","name":"canvas_get_state","arguments":"{\"scope\":\"all\"}"}]}`,
		},
		{
			name: "anthropic", packageName: "anthropic-messages.beeftv-plugin", providerID: "claude-api", marker: "claude", wantPath: "/v1/messages", wantID: "call-claude",
			response: `{"content":[{"type":"text","text":"claude answer"},{"type":"tool_use","id":"call-claude","name":"canvas_get_state","input":{"scope":"all"}}]}`,
		},
		{
			name: "gemini", packageName: "google-gemini-generate-content.beeftv-plugin", providerID: "gemini-generate-content", marker: "gemini", wantPath: "/v1beta/models/gemini-test:generateContent", wantSignature: "signature-1",
			response: `{"candidates":[{"content":{"parts":[{"text":"gemini answer"},{"functionCall":{"name":"canvas_get_state","args":{"scope":"all"}},"thoughtSignature":"signature-1"}]}}]}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			adapter := officialPackageAdapter(t, test.packageName, test.providerID)
			capability, ok := adapter.(AgentCapability)
			if !ok || !capability.AgentAvailable() {
				t.Fatalf("%s does not expose its declared agent operation", test.providerID)
			}
			agent, ok := adapter.(AgentAdapter)
			if !ok {
				t.Fatalf("%s does not implement AgentAdapter", test.providerID)
			}
			spec, err := agent.BuildAgent(context.Background(), AgentRequestContext{Model: "gemini-test", Request: requests})
			if err != nil {
				t.Fatal(err)
			}
			if spec.Path != test.wantPath {
				t.Fatalf("request path = %q, want %q", spec.Path, test.wantPath)
			}
			body := manifestTestBody(t, spec)
			if body["marker"] != test.marker {
				t.Fatalf("request selected wrong protocol body: %#v", body)
			}
			if test.providerID != "gemini-generate-content" && body["model"] != "gemini-test" {
				t.Fatalf("request model = %#v", body["model"])
			}
			result, err := agent.ParseAgent(context.Background(), []byte(test.response))
			if err != nil {
				t.Fatal(err)
			}
			if len(result.ToolCalls) != 1 || result.ToolCalls[0].Name != "canvas_get_state" || result.ToolCalls[0].Arguments != `{"scope":"all"}` {
				t.Fatalf("agent result = %#v", result)
			}
			if test.wantID != "" && result.ToolCalls[0].ID != test.wantID {
				t.Fatalf("tool call id = %q, want %q", result.ToolCalls[0].ID, test.wantID)
			}
			if test.wantID == "" && !strings.HasPrefix(result.ToolCalls[0].ID, "call_") {
				t.Fatalf("provider omitted tool call id and no stable id was synthesized: %#v", result.ToolCalls[0])
			}
			if result.ToolCalls[0].ThoughtSignature != test.wantSignature {
				t.Fatalf("thought signature = %q, want %q", result.ToolCalls[0].ThoughtSignature, test.wantSignature)
			}
		})
	}
}

func TestOfficialVideoProfilesPreserveExplicitMediaRoles(t *testing.T) {
	tests := []struct {
		packageName string
		providerID  string
		model       string
		resolution  string
		assert      func(t *testing.T, spec RequestSpec)
	}{
		{
			packageName: "minimax-hailuo-video-v2.beeftv-plugin", providerID: "minimax-video", model: "MiniMax-H3", resolution: "1080P",
			assert: func(t *testing.T, spec RequestSpec) {
				body := manifestTestBody(t, spec)
				content, _ := body["content"].([]any)
				if len(content) != 3 {
					t.Fatalf("MiniMax content = %#v", content)
				}
				first, _ := content[1].(map[string]any)
				last, _ := content[2].(map[string]any)
				if first["role"] != "first_frame" || last["role"] != "last_frame" || body["ratio"] != "adaptive" || body["resolution"] != "1080P" {
					t.Fatalf("MiniMax role payload = %#v", body)
				}
			},
		},
		{
			packageName: "newapi-media-task-v1.beeftv-plugin", providerID: "newapi-channel-1", model: "minimax-h3", resolution: "720P",
			assert: func(t *testing.T, spec RequestSpec) {
				body := manifestTestBody(t, spec)
				input, _ := body["input"].(map[string]any)
				media, _ := input["media"].([]any)
				first, _ := media[0].(map[string]any)
				last, _ := media[1].(map[string]any)
				if first["type"] != "first_frame" || last["type"] != "last_frame" {
					t.Fatalf("NewAPI media = %#v", media)
				}
			},
		},
		{
			packageName: "agnes-video-25.beeftv-plugin", providerID: "agnes-video", model: "agnes-video-2.5", resolution: "720P",
			assert: func(t *testing.T, spec RequestSpec) {
				body := manifestTestBody(t, spec)
				if body["mode"] != "keyframe" || body["first_frame"] != "https://cdn.example/first.png" || body["last_frame"] != "https://cdn.example/last.png" {
					t.Fatalf("Agnes keyframe payload = %#v", body)
				}
			},
		},
		{
			packageName: "dashscope-wan-video.beeftv-plugin", providerID: "dashscope-wan-video", model: "wan2.2-kf2v-flash", resolution: "720P",
			assert: func(t *testing.T, spec RequestSpec) {
				body := manifestTestBody(t, spec)
				input, _ := body["input"].(map[string]any)
				if input["first_frame_url"] != "https://cdn.example/first.png" || input["last_frame_url"] != "https://cdn.example/last.png" {
					t.Fatalf("Wan keyframe input = %#v", input)
				}
				if _, duplicated := input["img_url"]; duplicated {
					t.Fatalf("Wan keyframe input must not also send img_url: %#v", input)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.providerID, func(t *testing.T) {
			adapter := officialPackageAdapter(t, test.packageName, test.providerID)
			spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
				Model: test.model, Prompt: "镜头推进", Duration: 6, AspectRatio: "16:9", Resolution: test.resolution,
				Images: []MediaReference{
					{URL: "https://cdn.example/last.png", Role: "last_frame", Order: 2},
					{URL: "https://cdn.example/first.png", Role: "first_frame", Order: 1},
				},
			}})
			if err != nil {
				t.Fatal(err)
			}
			test.assert(t, spec)
		})
	}
}

func TestOfficialVideoProfilesPassThroughCustomDuration(t *testing.T) {
	t.Run("minimax-video", func(t *testing.T) {
		adapter := officialPackageAdapter(t, "minimax-hailuo-video-v2.beeftv-plugin", "minimax-video")
		spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Model: "MiniMax-H3", Prompt: "custom duration clip", Duration: 30, AspectRatio: "16:9", Resolution: "768P",
		}})
		if err != nil {
			t.Fatalf("BuildCreate() error = %v", err)
		}
		body := manifestTestBody(t, spec)
		if body["duration"] != float64(30) {
			t.Fatalf("MiniMax duration = %#v, want 30", body["duration"])
		}
	})
	t.Run("agnes-video", func(t *testing.T) {
		adapter := officialPackageAdapter(t, "agnes-video-25.beeftv-plugin", "agnes-video")
		spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Model: "agnes-video-2.5", Prompt: "custom duration clip", Duration: 30, AspectRatio: "16:9", Resolution: "720P",
		}})
		if err != nil {
			t.Fatalf("BuildCreate() error = %v", err)
		}
		body := manifestTestBody(t, spec)
		if body["seconds"] != "30" {
			t.Fatalf("Agnes seconds = %#v, want \"30\"", body["seconds"])
		}
	})
}

func TestNewAPIChannel1AddsSeedanceContentAliasAndParsesDataURL(t *testing.T) {
	adapter := officialPackageAdapter(t, "newapi-media-task-v1.beeftv-plugin", "newapi-channel-1")
	spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Capability: CapabilityVideo, Model: "seedance-2-0-fast", Prompt: "a red glass cube", Duration: 6,
		AspectRatio: "9:16", Resolution: "480p",
	}})
	if err != nil {
		t.Fatal(err)
	}
	body := manifestTestBody(t, spec)
	content, ok := body["content"].([]any)
	if !ok || len(content) != 1 {
		t.Fatalf("top-level content = %#v", body["content"])
	}
	item, _ := content[0].(map[string]any)
	if item["type"] != "text" || item["text"] != "a red glass cube" {
		t.Fatalf("top-level content item = %#v", item)
	}
	input, _ := body["input"].(map[string]any)
	if nested, ok := input["content"].([]any); !ok || len(nested) != 1 {
		t.Fatalf("nested input.content = %#v", input["content"])
	}
	parameters, _ := body["parameters"].(map[string]any)
	if parameters["ratio"] != "9:16" || parameters["resolution"] != "480p" || parameters["duration"] != float64(6) {
		t.Fatalf("video parameters = %#v", parameters)
	}
	state, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "task-1"}, []byte(`{"id":"task-1","status":"completed","data":[{"url":"https://cdn.example/result.mp4"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != StatusSucceeded || state.Result == nil || len(state.Result.Videos) != 1 || state.Result.Videos[0].URL != "https://cdn.example/result.mp4" {
		t.Fatalf("data URL result = %#v", state)
	}
}

func TestOfficialWanProfilesUseMutuallyExclusiveReferenceFields(t *testing.T) {
	video := officialPackageAdapter(t, "dashscope-wan-video.beeftv-plugin", "dashscope-wan-video")
	videoSpec, err := video.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "wan2.6-r2v", Prompt: "保持角色一致", Operation: "reference_to_video",
		Images: []MediaReference{
			{URL: "https://cdn.example/second.png", Role: "subject_reference", Order: 2},
			{URL: "https://cdn.example/first.png", Role: "reference_image", Order: 1},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	videoBody := manifestTestBody(t, videoSpec)
	videoInput, _ := videoBody["input"].(map[string]any)
	if _, duplicated := videoInput["img_url"]; duplicated {
		t.Fatalf("Wan reference mode must not also send img_url: %#v", videoInput)
	}
	references, _ := videoInput["reference_images"].([]any)
	if len(references) != 2 || references[0] != "https://cdn.example/first.png" || references[1] != "https://cdn.example/second.png" {
		t.Fatalf("Wan reference_images = %#v", references)
	}

	image := officialPackageAdapter(t, "dashscope-wanx-image.beeftv-plugin", "dashscope-wanx-image")
	for _, test := range []struct {
		name   string
		images []MediaReference
		single bool
	}{
		{name: "single", images: []MediaReference{{URL: "https://cdn.example/one.png", Role: "reference_image", Order: 1}}, single: true},
		{name: "multiple", images: []MediaReference{{URL: "https://cdn.example/two.png", Role: "reference_image", Order: 2}, {URL: "https://cdn.example/one.png", Role: "reference_image", Order: 1}}},
	} {
		t.Run("wanx-"+test.name, func(t *testing.T) {
			spec, err := image.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{Model: "wanx2.1-t2i-turbo", Prompt: "角色设定", Images: test.images}})
			if err != nil {
				t.Fatal(err)
			}
			body := manifestTestBody(t, spec)
			input, _ := body["input"].(map[string]any)
			_, hasSingle := input["ref_img"]
			_, hasMultiple := input["ref_images"]
			if hasSingle != test.single || hasMultiple == test.single {
				t.Fatalf("Wanx reference fields are not mutually exclusive: %#v", input)
			}
		})
	}
}

func TestOfficialRollDekWanVideoUsesVideosLifecycle(t *testing.T) {
	adapter := officialPackageAdapter(t, "rolldek-wan-video.beeftv-plugin", "rolldek-wan-video")
	request := GenerationRequest{
		Model: "wan3.0-video-prime-1080p", Prompt: "保持角色一致", Duration: 11, AspectRatio: "16:9", Resolution: "1080p",
		Images: []MediaReference{{URL: "https://cdn.example/character.png", Role: "reference_image"}},
		Videos: []MediaReference{{URL: "https://cdn.example/motion.mp4", Role: "reference_video", Metadata: map[string]any{"durationMs": 5250}}},
		Audios: []MediaReference{{URL: "https://cdn.example/voice.mp3", Role: "reference_audio"}},
	}
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	if create.Method != "POST" || create.Path != "/v1/videos" || create.ContentType != "application/json" {
		t.Fatalf("RollDek create = %#v", create)
	}
	body := manifestTestBody(t, create)
	if body["model"] != request.Model || body["seconds"] != "11" || body["size"] != "1080P" || body["aspect_ratio"] != "16:9" {
		t.Fatalf("RollDek create body = %#v", body)
	}
	images, _ := body["reference_images"].([]any)
	image, _ := images[0].(map[string]any)
	videos, _ := body["reference_videos"].([]any)
	video, _ := videos[0].(map[string]any)
	audios, _ := body["reference_audios"].([]any)
	audio, _ := audios[0].(map[string]any)
	if image["url"] != request.Images[0].URL || image["role"] != "reference_image" || video["url"] != request.Videos[0].URL || video["duration"] != 5.25 || audio["url"] != request.Audios[0].URL {
		t.Fatalf("RollDek references = images:%#v videos:%#v audios:%#v", images, videos, audios)
	}

	created, err := adapter.ParseCreate(context.Background(), []byte(`{"id":"task-roll-1","task_id":"task-roll-1","status":"queued"}`))
	if err != nil {
		t.Fatal(err)
	}
	if created.TaskID != "task-roll-1" || created.Status != StatusPending {
		t.Fatalf("RollDek create result = %#v", created)
	}
	poll, err := adapter.BuildPoll(context.Background(), PollContext{Request: request, TaskID: created.TaskID})
	if err != nil {
		t.Fatal(err)
	}
	if poll.Method != "GET" || poll.Path != "/v1/videos/task-roll-1" {
		t.Fatalf("RollDek poll = %#v", poll)
	}
	state, err := adapter.ParsePoll(context.Background(), PollContext{Request: request, TaskID: created.TaskID}, []byte(`{"id":"task-roll-1","status":"completed","metadata":{"url":"https://cdn.example/result.mp4"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != StatusSucceeded || state.Result == nil || len(state.Result.Videos) != 1 || state.Result.Videos[0].URL != "https://cdn.example/result.mp4" {
		t.Fatalf("RollDek poll result = %#v", state)
	}
	resultAdapter, ok := adapter.(ResultAdapter)
	if !ok {
		t.Fatal("RollDek adapter does not expose result download")
	}
	result, err := resultAdapter.BuildResult(context.Background(), PollContext{Request: request, TaskID: created.TaskID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Method != "GET" || result.Path != "/v1/videos/task-roll-1/content" {
		t.Fatalf("RollDek result = %#v", result)
	}
}

func TestNewAPIVideoGenerationsParsesNestedTaskIDs(t *testing.T) {
	adapter := officialPackageAdapter(t, "newapi-video-generations-v1.beeftv-plugin", "newapi-channel-2")
	tests := []struct {
		name    string
		payload string
		wantID  string
	}{
		{name: "snake case", payload: `{"data":{"task_id":"task-snake","status":"queued"}}`, wantID: "task-snake"},
		{name: "camel case", payload: `{"data":{"taskId":"task-camel","status":"queued"}}`, wantID: "task-camel"},
		{name: "nested upstream id wins over wrapper id", payload: `{"id":"49137","data":{"task_id":"task-upstream","status":"queued"}}`, wantID: "task-upstream"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			created, err := adapter.ParseCreate(context.Background(), []byte(test.payload))
			if err != nil {
				t.Fatal(err)
			}
			if created.TaskID != test.wantID || created.Status != StatusPending {
				t.Fatalf("created = %#v, want task ID %q and pending status", created, test.wantID)
			}
		})
	}
}

func TestNewAPIVideoGenerationsParsesNestedVideoResults(t *testing.T) {
	adapter := officialPackageAdapter(t, "newapi-video-generations-v1.beeftv-plugin", "newapi-channel-2")
	tests := []struct {
		name    string
		payload string
	}{
		{name: "channel result URL", payload: `{"code":"success","data":{"task_id":"task-upstream","status":"SUCCESS","result_url":"https://cdn.example/channel-result.mp4"}}`},
		{name: "provider nested video URL", payload: `{"code":"success","data":{"task_id":"task-upstream","status":"SUCCESS","data":{"status":"completed","video_url":"https://cdn.example/provider-result.mp4"}}}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			state, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "task-upstream"}, []byte(test.payload))
			if err != nil {
				t.Fatal(err)
			}
			if state.Status != StatusSucceeded || state.Result == nil || len(state.Result.Videos) != 1 {
				t.Fatalf("state = %#v, want one completed video", state)
			}
			if state.Result.Videos[0].URL == "" {
				t.Fatalf("video = %#v, want a result URL", state.Result.Videos[0])
			}
		})
	}
}

func TestOfficialOpenAIVideosDeclaresAuthenticatedResultDownload(t *testing.T) {
	adapter := officialPackageAdapter(t, "openai-videos.beeftv-plugin", "newapi")
	capability, ok := adapter.(ResultCapability)
	if !ok || !capability.ResultAvailable() {
		t.Fatal("OpenAI Videos result operation is unavailable")
	}
	resultAdapter, ok := adapter.(ResultAdapter)
	if !ok {
		t.Fatal("OpenAI Videos does not implement ResultAdapter")
	}
	spec, err := resultAdapter.BuildResult(context.Background(), PollContext{Model: "sora-2", TaskID: "video-1"})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Method != "GET" || spec.Path != "/v1/videos/video-1/content" || spec.Headers["Accept"] != "video/mp4" || spec.Auth.Type != "bearer" {
		t.Fatalf("result request = %#v", spec)
	}
}

// 系统指令必须真正到达上游：只映射 messages 的协议要收到 system 消息，
// 有独立 system 字段的协议要用该字段且不能在消息数组里重复发送。
func TestOfficialTextProtocolsDeliverInstructions(t *testing.T) {
	tests := []struct {
		name, packageName, providerID, messagesField, instructionField string
	}{
		{name: "openai-chat", packageName: "openai-chat-completions.beeftv-plugin", providerID: "chat-completion", messagesField: "messages"},
		{name: "deepseek", packageName: "deepseek-chat.beeftv-plugin", providerID: "deepseek-chat", messagesField: "messages"},
		{name: "atlascloud", packageName: "atlascloud-chat.beeftv-plugin", providerID: "atlascloud-chat", messagesField: "messages"},
		{name: "openai-responses", packageName: "openai-responses.beeftv-plugin", providerID: "openai-response", messagesField: "input", instructionField: "instructions"},
		{name: "anthropic", packageName: "anthropic-messages.beeftv-plugin", providerID: "claude-api", messagesField: "messages", instructionField: "system"},
		{name: "gemini", packageName: "google-gemini-generate-content.beeftv-plugin", providerID: "gemini-generate-content", messagesField: "contents", instructionField: "systemInstruction"},
	}
	const instructions = "只输出一个 JSON 对象"
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			adapter := officialPackageAdapter(t, test.packageName, test.providerID)
			spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
				Capability: CapabilityText, Model: "model-test", Prompt: "一句话故事", Instructions: instructions,
			}})
			if err != nil {
				t.Fatal(err)
			}
			body := manifestTestBody(t, spec)
			encodedMessages, err := json.Marshal(body[test.messagesField])
			if err != nil {
				t.Fatal(err)
			}
			carriesInstructions := strings.Contains(string(encodedMessages), instructions)
			if test.instructionField == "" {
				if !carriesInstructions {
					t.Fatalf("%s dropped the system instruction: %s", test.providerID, encodedMessages)
				}
				return
			}
			if carriesInstructions {
				t.Fatalf("%s duplicated the system instruction into %s: %s", test.providerID, test.messagesField, encodedMessages)
			}
			encodedInstruction, err := json.Marshal(body[test.instructionField])
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(encodedInstruction), instructions) {
				t.Fatalf("%s did not map the system instruction to %s: %s", test.providerID, test.instructionField, encodedInstruction)
			}
		})
	}
}

func officialPackageAdapter(t *testing.T, packageName, providerID string) Adapter {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", packageName))
	if err != nil {
		t.Fatal(err)
	}
	pkg, err := ParsePluginPackage(data)
	if err != nil {
		t.Fatal(err)
	}
	adapters, err := LoadInstalledProviders(pkg.ManifestRaw)
	if err != nil {
		t.Fatal(err)
	}
	for _, adapter := range adapters {
		if adapter.Metadata().ID == providerID {
			return adapter
		}
	}
	t.Fatalf("provider %s is missing from %s", providerID, packageName)
	return nil
}

func manifestTestBody(t *testing.T, spec RequestSpec) map[string]any {
	t.Helper()
	data, err := json.Marshal(spec.Body)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(data, &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func TestOfficialArkOlderModelsKeepOriginalSizeMapping(t *testing.T) {
	adapter := officialPackageAdapter(t, "volcengine-ark-seedream.beeftv-plugin", "volcengine-ark-image")
	tests := []struct {
		name, aspectRatio, wantSize string
	}{
		{name: "square maps to pixels", aspectRatio: "1:1", wantSize: "2048x2048"},
		{name: "landscape ratio", aspectRatio: "16:9", wantSize: "2560x1440"},
		{name: "auto preserves old tier", aspectRatio: "auto", wantSize: "2k"},
		{name: "pixel size passes through", aspectRatio: "2560x1440", wantSize: "2560x1440"},
		{name: "tier passes through", aspectRatio: "4k", wantSize: "4k"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{Model: "doubao-seedream-3-0-t2i", Prompt: "circle", AspectRatio: tt.aspectRatio}})
			if err != nil {
				t.Fatal(err)
			}
			if create.Path != "/images/generations" || create.DefaultPathPrefix != "/api/v3" {
				t.Fatalf("Seedream create = %#v", create)
			}
			if body := manifestTestBody(t, create); body["size"] != tt.wantSize {
				t.Fatalf("Seedream size = %#v, want %q", body["size"], tt.wantSize)
			}
		})
	}
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{Model: "doubao-seedream-3-0-t2i", Prompt: "circle"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := manifestTestBody(t, create)["size"]; exists {
		t.Fatalf("Older Ark models must omit an unselected size")
	}
}

func TestOfficialArkAgentPlanPluginsUsePlanPaths(t *testing.T) {
	image := officialPackageAdapter(t, "volcengine-ark-agent-plan-seedream.beeftv-plugin", "volcengine-ark-agent-plan-image")
	imageCreate, err := image.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{Model: "doubao-seedream-5-0-260128", Prompt: "circle", AspectRatio: "1:1"}})
	if err != nil {
		t.Fatal(err)
	}
	if imageCreate.Path != "/api/plan/v3/images/generations" {
		t.Fatalf("agent plan image create = %#v", imageCreate)
	}
	if body := manifestTestBody(t, imageCreate); body["size"] != "2048x2048" {
		t.Fatalf("agent plan image size = %#v", body["size"])
	}

	video := officialPackageAdapter(t, "volcengine-ark-agent-plan-seedance.beeftv-plugin", "volcengine-ark-agent-plan-video")
	videoCreate, err := video.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{Model: "doubao-seedance-2-0-260128", Prompt: "walk", AspectRatio: "16:9", Resolution: "720p", Duration: 5}})
	if err != nil {
		t.Fatal(err)
	}
	if videoCreate.Path != "/api/plan/v3/contents/generations/tasks" {
		t.Fatalf("agent plan video create = %#v", videoCreate)
	}
	poll, err := video.BuildPoll(context.Background(), PollContext{TaskID: "task-1", Model: "doubao-seedance-2-0-260128"})
	if err != nil {
		t.Fatal(err)
	}
	if poll.Path != "/api/plan/v3/contents/generations/tasks/task-1" {
		t.Fatalf("agent plan video poll = %#v", poll)
	}
}

func TestOfficialGeminiImageMapsQualityToImageSize(t *testing.T) {
	adapter := officialPackageAdapter(t, "google-gemini-image.beeftv-plugin", "gemini-image")
	tests := []struct {
		name, quality, wantSize string
		wantOmitted             bool
	}{
		{name: "4k becomes 4K", quality: "4k", wantSize: "4K"},
		{name: "high becomes 4K", quality: "high", wantSize: "4K"},
		{name: "2k becomes 2K", quality: "2k", wantSize: "2K"},
		{name: "1k becomes 1K", quality: "1k", wantSize: "1K"},
		{name: "video 720 omitted", quality: "720", wantOmitted: true},
		{name: "auto omitted", quality: "auto", wantOmitted: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
				Model: "gemini-3-pro-image-preview", Prompt: "landscape", AspectRatio: "16:9", Quality: tt.quality,
			}})
			if err != nil {
				t.Fatal(err)
			}
			if create.Path != "/v1beta/models/gemini-3-pro-image-preview:generateContent" {
				t.Fatalf("create path = %q", create.Path)
			}
			body := manifestTestBody(t, create)
			generationConfig, _ := body["generationConfig"].(map[string]any)
			if _, ok := generationConfig["candidateCount"]; ok {
				t.Fatalf("candidateCount must not be mapped from imageCount, got %#v", generationConfig["candidateCount"])
			}
			imageConfig, _ := generationConfig["imageConfig"].(map[string]any)
			if imageConfig["aspectRatio"] != "16:9" {
				t.Fatalf("aspectRatio = %#v", imageConfig["aspectRatio"])
			}
			if tt.wantOmitted {
				if imageConfig["imageSize"] != nil {
					t.Fatalf("imageSize should be omitted, got %#v", imageConfig["imageSize"])
				}
				return
			}
			if imageConfig["imageSize"] != tt.wantSize {
				t.Fatalf("imageSize = %#v, want %q", imageConfig["imageSize"], tt.wantSize)
			}
		})
	}
}

func TestOfficialGeminiImagePrefersQualityOverVideoResolution(t *testing.T) {
	adapter := officialPackageAdapter(t, "google-gemini-image.beeftv-plugin", "gemini-image")
	tests := []struct {
		name, quality, resolution, wantSize string
		wantOmitted                         bool
	}{
		{name: "canvas 4k keeps imageSize when vquality is 720", quality: "4k", resolution: "720", wantSize: "4K"},
		{name: "empty quality still maps resolution 4k", quality: "", resolution: "4k", wantSize: "4K"},
		{name: "video 720 alone is omitted", quality: "", resolution: "720", wantOmitted: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
				Model: "gemini-3-pro-image-preview", Prompt: "landscape", AspectRatio: "16:9", Quality: tt.quality, Resolution: tt.resolution,
			}})
			if err != nil {
				t.Fatal(err)
			}
			body := manifestTestBody(t, create)
			generationConfig, _ := body["generationConfig"].(map[string]any)
			imageConfig, _ := generationConfig["imageConfig"].(map[string]any)
			if tt.wantOmitted {
				if imageConfig["imageSize"] != nil {
					t.Fatalf("imageSize should be omitted, got %#v", imageConfig["imageSize"])
				}
				return
			}
			if imageConfig["imageSize"] != tt.wantSize {
				t.Fatalf("imageSize = %#v, want %q", imageConfig["imageSize"], tt.wantSize)
			}
		})
	}
}

func TestOfficialGrokImageMapsAspectAndResolution(t *testing.T) {
	adapter := officialPackageAdapter(t, "xai-grok-images.beeftv-plugin", "grok-image")
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "grok-imagine-image", Prompt: "a cat", AspectRatio: "1280x720", Quality: "high",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if create.Path != "/v1/images/generations" {
		t.Fatalf("path = %q", create.Path)
	}
	body := manifestTestBody(t, create)
	if body["aspect_ratio"] != "16:9" || body["resolution"] != "2k" {
		t.Fatalf("body = %#v", body)
	}
	if _, ok := body["size"]; ok {
		t.Fatalf("size must be omitted: %#v", body)
	}
}

func TestOfficialJimengImageSplitsPixelSize(t *testing.T) {
	adapter := officialPackageAdapter(t, "volcengine-jimeng-image.beeftv-plugin", "volcengine-jimeng-image")
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "jimeng_t2i_v40", Prompt: "still", AspectRatio: "1024x768",
		Images: []MediaReference{{DataURL: "data:image/png;base64,aGVsbG8="}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	body := manifestTestBody(t, create)
	if body["width"] != float64(1024) || body["height"] != float64(768) {
		t.Fatalf("dimensions = %#v %#v", body["width"], body["height"])
	}
	binary, ok := body["binary_data_base64"].([]any)
	if !ok || len(binary) != 1 || binary[0] != "aGVsbG8=" {
		t.Fatalf("binary_data_base64 = %#v", body["binary_data_base64"])
	}
}

func TestOfficialJimengVideoUsesOfficialFramesAspectAndQueryConfig(t *testing.T) {
	adapter := officialPackageAdapter(t, "volcengine-jimeng-video.beeftv-plugin", "volcengine-jimeng-video")
	for _, test := range []struct {
		duration int
		frames   float64
	}{{5, 121}, {10, 241}} {
		create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Model: "jimeng_t2v_v30", Prompt: "镜头推进", Duration: test.duration, AspectRatio: "9:16", Resolution: "720p",
		}})
		if err != nil {
			t.Fatal(err)
		}
		body := manifestTestBody(t, create)
		if body["frames"] != test.frames {
			t.Fatalf("duration %v frames = %#v, want %v", test.duration, body["frames"], test.frames)
		}
		if body["aspect_ratio"] != "9:16" {
			t.Fatalf("duration %v aspect_ratio = %#v", test.duration, body["aspect_ratio"])
		}
		for _, unexpected := range []string{"duration", "ratio", "req_json"} {
			if _, exists := body[unexpected]; exists {
				t.Fatalf("duration %v create body must not carry %q: %#v", test.duration, unexpected, body)
			}
		}
	}
	// 官方只提供 5 秒和 10 秒两档，其他秒数取最近一档，不能发出不存在的帧数。
	nearest, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "jimeng_t2v_v30", Prompt: "镜头推进", Duration: 6,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if frames := manifestTestBody(t, nearest)["frames"]; frames != float64(121) {
		t.Fatalf("6s frames = %#v, want 121", frames)
	}
}

func TestOfficialJimengVideoSendsReqJSONOnQueryOnly(t *testing.T) {
	adapter := officialPackageAdapter(t, "volcengine-jimeng-video.beeftv-plugin", "volcengine-jimeng-video")
	request := GenerationRequest{
		Model: "jimeng_t2v_v30", Prompt: "镜头推进", Duration: 5,
		ProviderOptions: map[string]map[string]any{"volcengine-jimeng-video": {"req_json": `{"return_url":true}`}},
	}
	poll, err := adapter.BuildPoll(context.Background(), PollContext{TaskID: "task-1", Model: "jimeng_t2v_v30", Request: request})
	if err != nil {
		t.Fatal(err)
	}
	pollBody := manifestTestBody(t, poll)
	if pollBody["req_json"] != `{"return_url":true}` || pollBody["task_id"] != "task-1" || pollBody["req_key"] != "jimeng_t2v_v30" {
		t.Fatalf("query body = %#v", pollBody)
	}
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := manifestTestBody(t, create)["req_json"]; exists {
		t.Fatalf("req_json belongs to the query request, not create: %#v", manifestTestBody(t, create))
	}
	// 未声明 req_json 时查询正文保持官方两字段形状，不发明默认值。
	withoutOptions, err := adapter.BuildPoll(context.Background(), PollContext{TaskID: "task-1", Model: "jimeng_t2v_v30", Request: GenerationRequest{Model: "jimeng_t2v_v30"}})
	if err != nil {
		t.Fatal(err)
	}
	plain := manifestTestBody(t, withoutOptions)
	if _, exists := plain["req_json"]; exists {
		t.Fatalf("query body must not invent req_json: %#v", plain)
	}
	if len(plain) != 2 {
		t.Fatalf("query body = %#v", plain)
	}
}

func TestOfficialJimengVideoTreatsCode10000AsSuccess(t *testing.T) {
	adapter := officialPackageAdapter(t, "volcengine-jimeng-video.beeftv-plugin", "volcengine-jimeng-video")
	done, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "task-1"}, []byte(`{"code":10000,"data":{"status":"done","video_url":"https://cdn.example/clip.mp4"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if done.Status != StatusSucceeded || done.Result == nil || len(done.Result.Videos) != 1 || done.Result.Videos[0].URL != "https://cdn.example/clip.mp4" {
		t.Fatalf("code 10000 result = %#v", done)
	}
	accepted, err := adapter.ParseCreate(context.Background(), []byte(`{"code":10000,"data":{"task_id":"task-1"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if accepted.Status == StatusFailed || accepted.TaskID != "task-1" {
		t.Fatalf("code 10000 receipt = %#v", accepted)
	}
	failed, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "task-1"}, []byte(`{"code":100013,"message":"输入图片中存在不合规内容","data":{"status":"failed"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if failed.Status != StatusFailed || failed.Message == "" {
		t.Fatalf("business error result = %#v", failed)
	}
}

func TestDeclarativeSuccessCodesOnlyApplyToProtocolsThatDeclareThem(t *testing.T) {
	body := `{"code":10000,"data":{"status":"done","video_url":"https://cdn.example/clip.mp4"}}`
	base := `{"apiVersion":"beeftv.plugin/v1","id":"success-code-test","version":"1.0.0","name":"Success Code Test","author":"Test","documentation":"# Success Code Test","contributes":{"providers":[{"id":"success-code-test","label":"Success Code Test","capabilities":["video"],"scopes":["canvas"],"create":{"method":"POST","path":"/tasks"},"response":{"statusPaths":["data.status"],"videos":["data.video_url"],"errorPaths":["code"],"messagePaths":["message"]%s}}]}}`
	for name, test := range map[string]struct {
		response string
		want     Status
	}{
		"undeclared":       {response: "", want: StatusFailed},
		"declared":         {response: `,"successCodes":[10000]`, want: StatusSucceeded},
		"declared as text": {response: `,"successCodes":["10000"]`, want: StatusSucceeded},
	} {
		t.Run(name, func(t *testing.T) {
			adapter, err := LoadManifest([]byte(fmt.Sprintf(base, test.response)))
			if err != nil {
				t.Fatal(err)
			}
			result, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "task-1"}, []byte(body))
			if err != nil {
				t.Fatal(err)
			}
			if result.Status != test.want {
				t.Fatalf("status = %q, want %q", result.Status, test.want)
			}
		})
	}
}

func TestOfficialOpenAIAudioUsesBinaryPayload(t *testing.T) {
	adapter := officialPackageAdapter(t, "openai-audio.beeftv-plugin", "openai-audio")
	result, err := adapter.ParseCreate(context.Background(), []byte("ID3fake-mp3"))
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != StatusSucceeded || result.Result == nil || len(result.Result.Audios) != 1 {
		t.Fatalf("result = %#v", result)
	}
}

func TestOfficialOpenAIAudioSpeedDefaultsInvalidAndZeroValues(t *testing.T) {
	adapter := officialPackageAdapter(t, "openai-audio.beeftv-plugin", "openai-audio")
	for _, test := range []struct {
		name  string
		value any
		want  float64
	}{
		{name: "invalid", value: "not-a-number", want: 1},
		{name: "zero", value: "0", want: 1},
		{name: "valid", value: "1.25", want: 1.25},
	} {
		t.Run(test.name, func(t *testing.T) {
			spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
				Model: "gpt-4o-mini-tts", Prompt: "hello", Extra: map[string]any{"audioSpeed": test.value},
			}})
			if err != nil {
				t.Fatal(err)
			}
			body := manifestTestBody(t, spec)
			if got := body["speed"]; !reflect.DeepEqual(got, test.want) {
				t.Fatalf("speed = %#v, want %v", got, test.want)
			}
		})
	}
}

func TestOfficialArkSeedreamParsesB64JSONAsDataURL(t *testing.T) {
	for _, tc := range []struct {
		packageName, providerID string
	}{
		{"volcengine-ark-seedream.beeftv-plugin", "volcengine-ark-image"},
		{"volcengine-ark-agent-plan-seedream.beeftv-plugin", "volcengine-ark-agent-plan-image"},
	} {
		t.Run(tc.providerID, func(t *testing.T) {
			adapter := officialPackageAdapter(t, tc.packageName, tc.providerID)
			const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII="
			result, err := adapter.ParseCreate(context.Background(), []byte(`{"created":1,"data":[{"b64_json":"`+image+`","output_format":"png","size":"1824x1024"}]}`))
			if err != nil {
				t.Fatal(err)
			}
			if result.Result == nil || len(result.Result.Images) != 1 {
				t.Fatalf("result = %#v", result.Result)
			}
			dataURL := result.Result.Images[0].DataURL
			if dataURL != "data:image/png;base64,"+image {
				t.Fatalf("DataURL = %q, want png data URL", dataURL)
			}
		})
	}
}

func TestOfficialKlingVideoAndImageFollowOfficialContract(t *testing.T) {
	videoAdapter := officialPackageAdapter(t, "kling-video.beeftv-plugin", "kling-video")
	t2v, err := videoAdapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "kling-v2-master", Prompt: "镜头推进", Duration: 5, AspectRatio: "16:9",
	}})
	if err != nil {
		t.Fatal(err)
	}
	t2vBody := manifestTestBody(t, t2v)
	if t2v.Path != "/v1/videos/text2video" || t2vBody["model_name"] != "kling-v2-master" || t2vBody["duration"] != "5" || t2vBody["aspect_ratio"] != "16:9" {
		t.Fatalf("Kling T2V = %#v, body = %#v", t2v, t2vBody)
	}
	i2v, err := videoAdapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "kling-v2-master", Prompt: "镜头推进", Duration: 10,
		Images: []MediaReference{
			{URL: "https://cdn.example/first.png", Role: "first_frame", Order: 0},
			{URL: "https://cdn.example/last.png", Role: "last_frame", Order: 1},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	i2vBody := manifestTestBody(t, i2v)
	if i2v.Path != "/v1/videos/image2video" || i2vBody["image"] != "https://cdn.example/first.png" || i2vBody["image_tail"] != "https://cdn.example/last.png" {
		t.Fatalf("Kling I2V = %#v, body = %#v", i2v, i2vBody)
	}
	pollResult, err := videoAdapter.ParsePoll(context.Background(), PollContext{TaskID: "k-1"}, []byte(`{"code":0,"message":"SUCCEED","data":{"task_id":"k-1","task_status":"succeed","task_result":{"videos":[{"id":"v1","url":"https://cdn.example/kling.mp4","duration":"5"}]}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if pollResult.Status != StatusSucceeded || pollResult.Result == nil || len(pollResult.Result.Videos) != 1 || pollResult.Result.Videos[0].URL != "https://cdn.example/kling.mp4" {
		t.Fatalf("Kling video poll result = %#v", pollResult)
	}

	imageAdapter := officialPackageAdapter(t, "kling-image.beeftv-plugin", "kling-image")
	imgCreate, err := imageAdapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "kling-v2", Prompt: "电影感海报", ImageCount: 2, AspectRatio: "16:9",
	}})
	if err != nil {
		t.Fatal(err)
	}
	imgBody := manifestTestBody(t, imgCreate)
	if imgCreate.Path != "/v1/images/generations" || imgBody["model_name"] != "kling-v2" || imgBody["n"] != float64(2) || imgBody["aspect_ratio"] != "16:9" {
		t.Fatalf("Kling image create = %#v, body = %#v", imgCreate, imgBody)
	}
	imgPoll, err := imageAdapter.ParsePoll(context.Background(), PollContext{TaskID: "ki-1"}, []byte(`{"code":0,"message":"SUCCEED","data":{"task_id":"ki-1","task_status":"succeed","task_result":{"images":[{"index":0,"url":"https://cdn.example/kling.png"}]}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if imgPoll.Status != StatusSucceeded || imgPoll.Result == nil || len(imgPoll.Result.Images) != 1 || imgPoll.Result.Images[0].URL != "https://cdn.example/kling.png" {
		t.Fatalf("Kling image poll result = %#v", imgPoll)
	}
}

func TestAgnesVideoPluginsAllowLocalReferenceMediaAndMapUnassignedImage(t *testing.T) {
	builtinMeta := agnesAdapter().Metadata()
	if !builtinMeta.RequiresPublicMediaURLs || builtinMeta.MediaTransport["image"] != "inline" || builtinMeta.MediaTransport["video"] != "url" || builtinMeta.MediaTransport["audio"] != "url" {
		t.Fatalf("builtin agnes-video media metadata = %#v", builtinMeta)
	}
	for _, pkg := range []struct {
		file, id string
	}{
		{"agnes-video-25.beeftv-plugin", "agnes-video"},
		{"agnes-video-v20.beeftv-plugin", "agnes-video-v20"},
	} {
		adapter := officialPackageAdapter(t, pkg.file, pkg.id)
		meta := adapter.Metadata()
		if !meta.RequiresPublicMediaURLs || meta.MediaTransport["image"] != "inline" || meta.MediaTransport["video"] != "url" || meta.MediaTransport["audio"] != "url" {
			t.Fatalf("%s media metadata = %#v, want requiresPublicMediaUrls=true and inline image transport", pkg.file, meta)
		}
	}
	v20 := officialPackageAdapter(t, "agnes-video-v20.beeftv-plugin", "agnes-video-v20")
	spec, err := v20.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "agnes-video-v2.0", Prompt: "角色转身", Duration: 5, AspectRatio: "16:9", Resolution: "720p",
		Images: []MediaReference{{DataURL: "data:image/png;base64,Zm9v"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	body := manifestTestBody(t, spec)
	if body["image"] != "data:image/png;base64,Zm9v" {
		t.Fatalf("agnes-video-v20 unassigned image = %#v, want data URL in image field", body["image"])
	}
}

func TestNewAPIVideoGenerationsIncludesSingularAndArrayImageFields(t *testing.T) {
	adapter := officialPackageAdapter(t, "newapi-video-generations-v1.beeftv-plugin", "newapi-channel-2")
	spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "wan3.0-video", Prompt: "镜头拉远", Duration: 5, AspectRatio: "16:9", Resolution: "720p",
		Images: []MediaReference{{URL: "https://cdn.example/frame1.png", Role: "first_frame"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	body := manifestTestBody(t, spec)
	if body["image"] != "https://cdn.example/frame1.png" || body["image_url"] != "https://cdn.example/frame1.png" {
		t.Fatalf("newapi-channel-2 singular image fields missing: %#v", body)
	}
	urls, _ := body["image_urls"].([]any)
	if len(urls) != 1 || urls[0] != "https://cdn.example/frame1.png" {
		t.Fatalf("newapi-channel-2 image_urls = %#v", body["image_urls"])
	}
}

func TestMiniMaxHailuoVideoParsesNestedTaskErrorsAndDataFields(t *testing.T) {
	adapter := officialPackageAdapter(t, "minimax-hailuo-video-v2.beeftv-plugin", "minimax-video")
	created, err := adapter.ParseCreate(context.Background(), []byte(`{"data":{"task_id":"mm-task-1","status":"Preparing"}}`))
	if err != nil || created.TaskID != "mm-task-1" || created.Status != StatusPending {
		t.Fatalf("minimax nested data create = %#v, err = %v", created, err)
	}
	failed, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "mm-task-1"}, []byte(`{"task":{"id":"mm-task-1","status":"Fail","error":{"code":"invalid_parameter","message":"unsupported resolution"}}}`))
	if err != nil || failed.Status != StatusFailed || failed.Message != "unsupported resolution" {
		t.Fatalf("minimax nested task error poll = %#v, err = %v", failed, err)
	}
	builtinDone, err := parseAsyncMediaPoll(PollContext{TaskID: "mm-task-2"}, map[string]any{
		"data": map[string]any{
			"status": "Success",
			"file": map[string]any{
				"download_url": "https://cdn.example/mm.mp4",
			},
		},
	}, CapabilityVideo)
	if err != nil || builtinDone.Status != StatusSucceeded || builtinDone.Result == nil || len(builtinDone.Result.Videos) != 1 || builtinDone.Result.Videos[0].URL != "https://cdn.example/mm.mp4" {
		t.Fatalf("parseAsyncMediaPoll nested file.download_url = %#v, err = %v", builtinDone, err)
	}
	builtinFailed, err := parseAsyncMediaPoll(PollContext{TaskID: "mm-task-3"}, map[string]any{
		"task": map[string]any{
			"status": "Fail",
			"error": map[string]any{
				"code":    "invalid_parameter",
				"message": "bad input",
			},
		},
	}, CapabilityVideo)
	if err != nil || builtinFailed.Status != StatusFailed || builtinFailed.Message != "bad input" {
		t.Fatalf("parseAsyncMediaPoll nested task.error = %#v, err = %v", builtinFailed, err)
	}
}
