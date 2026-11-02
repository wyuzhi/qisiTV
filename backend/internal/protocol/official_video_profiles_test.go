package protocol

import (
	"context"
	"strings"
	"testing"
)

// 这三个 profile 都曾在官方成功响应上解析出「成功、零个视频」：Runway 的地址在
// output[] 里，Luma 在 assets.video 里，xAI 在 video.url 里。下面的用例按官方
// 成功样例断言取回结果，并锁定创建请求只发官方字段。

func TestOfficialRunwayVideoUsesOfficialFieldsAndReadsTaskOutput(t *testing.T) {
	adapter := officialPackageAdapter(t, "runway-video.qisitv-plugin", "runway-video")

	textOnly, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "gen4.5", Prompt: "a glass cube", Duration: 5, AspectRatio: "9:16",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if textOnly.Path != "/v1/text_to_video" {
		t.Fatalf("prompt-only path = %q, want /v1/text_to_video", textOnly.Path)
	}
	if got := textOnly.Headers["X-Runway-Version"]; got != "2024-11-06" {
		t.Fatalf("X-Runway-Version = %q", got)
	}
	body := manifestTestBody(t, textOnly)
	if body["promptText"] != "a glass cube" || body["ratio"] != "720:1280" || body["duration"] != float64(5) {
		t.Fatalf("runway text_to_video body = %#v", body)
	}
	for _, legacy := range []string{"prompt", "images", "aspect_ratio", "resolution", "parameters"} {
		if _, exists := body[legacy]; exists {
			t.Fatalf("runway body still carries %q: %#v", legacy, body)
		}
	}

	withFrames, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "veo3.1", Prompt: "a glass cube", Duration: 8, AspectRatio: "16:9",
		Images: []MediaReference{
			{URL: "https://cdn.example/last.png", Role: "last_frame", Order: 2},
			{URL: "https://cdn.example/first.png", Role: "first_frame", Order: 1},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if withFrames.Path != "/v1/image_to_video" {
		t.Fatalf("first-frame path = %q, want /v1/image_to_video", withFrames.Path)
	}
	frames, _ := manifestTestBody(t, withFrames)["promptImage"].([]any)
	if len(frames) != 2 {
		t.Fatalf("promptImage = %#v", frames)
	}
	first, _ := frames[0].(map[string]any)
	last, _ := frames[1].(map[string]any)
	if first["uri"] != "https://cdn.example/first.png" || first["position"] != "first" || last["uri"] != "https://cdn.example/last.png" || last["position"] != "last" {
		t.Fatalf("promptImage frames = %#v", frames)
	}

	poll, err := adapter.BuildPoll(context.Background(), PollContext{TaskID: "63fd0f13-f29d-4e58-99d3-1cb9efa14a5b"})
	if err != nil {
		t.Fatal(err)
	}
	if poll.Path != "/v1/tasks/63fd0f13-f29d-4e58-99d3-1cb9efa14a5b" || poll.Headers["X-Runway-Version"] != "2024-11-06" {
		t.Fatalf("runway poll = %#v", poll)
	}

	state, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "63fd0f13-f29d-4e58-99d3-1cb9efa14a5b"}, []byte(`{"id":"63fd0f13-f29d-4e58-99d3-1cb9efa14a5b","status":"SUCCEEDED","completedAt":"2025-11-11T21:50:15.123Z","output":["https://dnznrvs05pmza.cloudfront.net/video.mp4"],"progress":100}`))
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != StatusSucceeded || state.Result == nil || len(state.Result.Videos) != 1 || state.Result.Videos[0].URL != "https://dnznrvs05pmza.cloudfront.net/video.mp4" {
		t.Fatalf("runway succeeded state = %#v", state)
	}

	failed, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "task-2"}, []byte(`{"id":"task-2","status":"FAILED","failure":"content moderation rejected the prompt","failureCode":"SAFETY.INPUT.TEXT"}`))
	if err != nil {
		t.Fatal(err)
	}
	if failed.Status != StatusFailed || failed.Message != "content moderation rejected the prompt" {
		t.Fatalf("runway failed state = %#v", failed)
	}
}

func TestOfficialRunwayVideoRejectsUnsentMediaRoles(t *testing.T) {
	adapter := officialPackageAdapter(t, "runway-video.qisitv-plugin", "runway-video")
	_, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "gen4.5", Prompt: "a glass cube",
		Images: []MediaReference{{URL: "https://cdn.example/character.png", Role: "reference_image"}},
	}})
	if err == nil {
		t.Fatal("reference image must fail instead of being dropped")
	}
	_, err = adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "gen4.5", Prompt: "a glass cube",
		Videos: []MediaReference{{URL: "https://cdn.example/source.mp4"}},
	}})
	if err == nil {
		t.Fatal("reference video must fail instead of being dropped")
	}
}

// gen4.5 的 promptImage 只有一张 position=first；只发首帧时必须照常发送（尾帧被拒
// 的用例见 TestOfficialRunwayVideoRejectsLastFrameForFirstOnlyModels）。
func TestOfficialRunwayVideoKeepsFirstFrameForFirstOnlyModels(t *testing.T) {
	adapter := officialPackageAdapter(t, "runway-video.qisitv-plugin", "runway-video")

	firstOnly, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "gen4.5", Prompt: "a glass cube",
		Images: []MediaReference{{URL: "https://cdn.example/first.png", Role: "first_frame", Order: 1}},
	}})
	if err != nil {
		t.Fatalf("gen4.5 的首帧必须照常发送: %v", err)
	}
	frames, _ := manifestTestBody(t, firstOnly)["promptImage"].([]any)
	if len(frames) != 1 {
		t.Fatalf("gen4.5 promptImage = %#v, want only the first frame", frames)
	}
	if first, _ := frames[0].(map[string]any); first["position"] != "first" || first["uri"] != "https://cdn.example/first.png" {
		t.Fatalf("gen4.5 promptImage frame = %#v", frames[0])
	}
}

// 官方 POST /v1/image_to_video 的 promptImage 能力按 model 区分：gen4.5 这类模型
// 只有 position=first，veo3.1、kling2.5_turbo_pro、seedance2_5、h3_max 等接受
// position=last。校验只拦官方明确限制的单帧模型，其它模型的双帧请求必须原样发送，
// 否则新模型和中转会被本地名单误拦。
func TestOfficialRunwayVideoKeepsLastFrameForModelsThatSupportIt(t *testing.T) {
	adapter := officialPackageAdapter(t, "runway-video.qisitv-plugin", "runway-video")
	for _, model := range []string{"veo3.1", "veo3.1_fast", "kling2.5_turbo_pro", "kling3.0_pro", "seedance2_5", "h3_max", "kling_4", "wan3", "some-future-model"} {
		t.Run(model, func(t *testing.T) {
			spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
				Model: model, Prompt: "a glass cube",
				Images: []MediaReference{
					{URL: "https://cdn.example/first.png", Role: "first_frame", Order: 1},
					{URL: "https://cdn.example/last.png", Role: "last_frame", Order: 2},
				},
			}})
			if err != nil {
				t.Fatalf("%s 的双帧请求被本地校验挡住: %v", model, err)
			}
			frames, _ := manifestTestBody(t, spec)["promptImage"].([]any)
			if len(frames) != 2 {
				t.Fatalf("%s promptImage = %#v, want first + last", model, frames)
			}
			first, _ := frames[0].(map[string]any)
			last, _ := frames[1].(map[string]any)
			if first["position"] != "first" || first["uri"] != "https://cdn.example/first.png" {
				t.Fatalf("%s first frame = %#v", model, frames[0])
			}
			if last["position"] != "last" || last["uri"] != "https://cdn.example/last.png" {
				t.Fatalf("%s last frame = %#v", model, frames[1])
			}
		})
	}
}

// 官方把这些模型的 position 限定为 first，带尾帧必须在校验阶段报错。
func TestOfficialRunwayVideoRejectsLastFrameForFirstOnlyModels(t *testing.T) {
	adapter := officialPackageAdapter(t, "runway-video.qisitv-plugin", "runway-video")
	for _, model := range []string{"gen4.5", "gen4_turbo", "happyhorse_1_0", "gemini_omni_flash", "grok_imagine_1_5", "grok_imagine_1_5_lite"} {
		t.Run(model, func(t *testing.T) {
			_, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
				Model: model, Prompt: "a glass cube",
				Images: []MediaReference{
					{URL: "https://cdn.example/first.png", Role: "first_frame", Order: 1},
					{URL: "https://cdn.example/last.png", Role: "last_frame", Order: 2},
				},
			}})
			if err == nil || !strings.Contains(err.Error(), "尾帧") {
				t.Fatalf("%s 带尾帧必须在校验阶段报错，实际 error = %v", model, err)
			}
		})
	}
}

func TestOfficialLumaReadsGenerationAssetsAndOfficialFields(t *testing.T) {
	adapter := officialPackageAdapter(t, "luma-dream-machine.qisitv-plugin", "luma-dream-machine")
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "ray-2", Prompt: "a tiger walking in snow", Duration: 5, AspectRatio: "16:9", Resolution: "720P",
		Images: []MediaReference{
			{URL: "https://cdn.example/last.png", Role: "last_frame", Order: 2},
			{URL: "https://cdn.example/first.png", Role: "first_frame", Order: 1},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if create.Path != "/dream-machine/v1/generations" || !create.OriginPath {
		t.Fatalf("luma create = %#v", create)
	}
	body := manifestTestBody(t, create)
	if body["duration"] != "5s" || body["resolution"] != "720p" || body["aspect_ratio"] != "16:9" {
		t.Fatalf("luma body = %#v", body)
	}
	if _, exists := body["images"]; exists {
		t.Fatalf("luma must not send a flat images array: %#v", body)
	}
	keyframes, _ := body["keyframes"].(map[string]any)
	frame0, _ := keyframes["frame0"].(map[string]any)
	frame1, _ := keyframes["frame1"].(map[string]any)
	if frame0["type"] != "image" || frame0["url"] != "https://cdn.example/first.png" {
		t.Fatalf("luma frame0 = %#v", keyframes)
	}
	if frame1["type"] != "image" || frame1["url"] != "https://cdn.example/last.png" {
		t.Fatalf("luma frame1 = %#v", keyframes)
	}

	textOnly, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{Model: "ray-2", Prompt: "a tiger"}})
	if err != nil {
		t.Fatal(err)
	}
	if plain := manifestTestBody(t, textOnly); plain["keyframes"] != nil || plain["duration"] != nil || plain["aspect_ratio"] != nil {
		t.Fatalf("luma prompt-only body = %#v", plain)
	}

	dreaming, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "gen-1"}, []byte(`{"id":"gen-1","state":"dreaming","failure_reason":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if dreaming.Status != StatusProcessing || dreaming.Result != nil {
		t.Fatalf("luma dreaming state = %#v", dreaming)
	}

	done, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "gen-1"}, []byte(`{"id":"gen-1","state":"completed","failure_reason":null,"assets":{"video":"https://example.com/video.mp4"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if done.Status != StatusSucceeded || done.Result == nil || len(done.Result.Videos) != 1 || done.Result.Videos[0].URL != "https://example.com/video.mp4" {
		t.Fatalf("luma completed state = %#v", done)
	}
}

func TestOfficialXAIVideoReadsRequestIDAndVideoURL(t *testing.T) {
	adapter := officialPackageAdapter(t, "xai-video.qisitv-plugin", "xai-video")
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "grok-imagine-video-1.5", Prompt: "a paper boat", AspectRatio: "16:9", Resolution: "720p",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if got := manifestTestBody(t, create)["duration"]; got != float64(8) {
		t.Fatalf("xAI default duration = %#v, want the official default 8", got)
	}

	created, err := adapter.ParseCreate(context.Background(), []byte(`{"request_id":"d97415a1-5796-b7ec-379f-4e6819e08fdf"}`))
	if err != nil {
		t.Fatal(err)
	}
	if created.TaskID != "d97415a1-5796-b7ec-379f-4e6819e08fdf" {
		t.Fatalf("xAI task id = %q", created.TaskID)
	}

	done, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "d97415a1-5796-b7ec-379f-4e6819e08fdf"}, []byte(`{"status":"done","video":{"url":"https://vidgen.x.ai/x/video.mp4","duration":8,"respect_moderation":true},"model":"grok-imagine-video-1.5"}`))
	if err != nil {
		t.Fatal(err)
	}
	if done.Status != StatusSucceeded || done.Result == nil || len(done.Result.Videos) != 1 || done.Result.Videos[0].URL != "https://vidgen.x.ai/x/video.mp4" {
		t.Fatalf("xAI done state = %#v", done)
	}

	failed, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "d97415a1"}, []byte(`{"status":"failed","error":{"code":"invalid_argument","message":"prompt rejected"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if failed.Status != StatusFailed || failed.Message != "prompt rejected" {
		t.Fatalf("xAI failed state = %#v", failed)
	}
}
