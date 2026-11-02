package protocol

import (
	"context"
	"testing"
)

func TestSeedanceInstalledPluginsSendAdaptive(t *testing.T) {
	for _, tc := range []struct{ file, id, ratioKey string }{
		{"volcengine-ark-seedance.qisitv-plugin", "volcengine-ark-video", "ratio"},
		{"volcengine-ark-agent-plan-seedance.qisitv-plugin", "volcengine-ark-agent-plan-video", "ratio"},
		{"seedance-videos-compatible.qisitv-plugin", "seedance-videos-compatible", "aspect_ratio"},
	} {
		a := officialPackageAdapter(t, tc.file, tc.id)
		spec, err := a.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{Capability: CapabilityVideo, Model: "seedance-2.5-official", Prompt: "move", AspectRatio: "9:16", Duration: 6, Images: []MediaReference{{URL: "https://example.com/first.png", Role: "first_frame"}}}})
		if err != nil {
			t.Fatal(err)
		}
		if body := manifestTestBody(t, spec); body[tc.ratioKey] != "adaptive" {
			t.Fatalf("%s sent wrong ratio: %#v", tc.id, body)
		}
	}
}

func TestSeedanceTaskConstraints(t *testing.T) {
	for _, tc := range []struct {
		name, model, role, operation, ratio string
		videos, duration                    int
	}{
		{"official first frame", "seedance-2.5-official", "first_frame", "", "adaptive", 0, 6},
		{"native last frame", "doubao-seedance-2-5-260628", "last_frame", "", "adaptive", 0, 6},
		{"reference image", "seedance-2.5", "reference_image", "reference_to_video", "9:16", 0, 6},
		{"reference video", "seedance-2.5", "", "reference_to_video", "9:16", 1, 6},
		{"edit", "seedance-2.5", "", "inpaint", "adaptive", 1, -1},
		{"extend", "seedance-2.5", "", "extend", "adaptive", 1, 6},
		{"no video edit", "seedance-2.5", "", "inpaint", "9:16", 0, 6},
		{"2.0 unaffected", "seedance-2.0-fast", "first_frame", "", "9:16", 0, 6},
		{"unrelated model", "other-model", "first_frame", "", "9:16", 0, 6},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := GenerationRequest{Model: tc.model, Prompt: "edit this video", AspectRatio: "9:16", Duration: 6, Operation: tc.operation, Images: []MediaReference{{Role: tc.role}}, Videos: make([]MediaReference, tc.videos)}
			got := NormalizeSeedanceTaskOptions(r)
			if got.AspectRatio != tc.ratio || got.Duration != tc.duration {
				t.Fatalf("got ratio=%s duration=%d", got.AspectRatio, got.Duration)
			}
		})
	}
}

func TestInstalledSeedancePluginsPreserveExplicitTaskType(t *testing.T) {
	for _, plugin := range []struct{ file, id string }{
		{"volcengine-ark-seedance.qisitv-plugin", "volcengine-ark-video"},
		{"volcengine-ark-agent-plan-seedance.qisitv-plugin", "volcengine-ark-agent-plan-video"},
		{"seedance-videos-compatible.qisitv-plugin", "seedance-videos-compatible"},
	} {
		a := officialPackageAdapter(t, plugin.file, plugin.id)
		for _, tc := range []struct{ model, op, want string }{
			{"seedance-2.5", "reference_to_video", "reference"}, {"seedance-2.5", "inpaint", "edit"}, {"seedance-2.5", "extend", "extend"}, {"seedance-2.5", "", ""}, {"seedance-2.0", "reference_to_video", ""},
		} {
			spec, err := a.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{Capability: CapabilityVideo, Model: tc.model, Prompt: "test", Operation: tc.op, Duration: 5, AspectRatio: "16:9", Videos: []MediaReference{{URL: "https://example.com/a.mp4"}}}})
			if err != nil {
				t.Fatal(err)
			}
			body := manifestTestBody(t, spec)
			if tc.want == "" {
				if _, ok := body["omni_reference_task_type"]; ok {
					t.Fatalf("unexpected field: %v", body)
				}
			} else if body["omni_reference_task_type"] != tc.want {
				t.Fatalf("%s %s got %v", plugin.id, tc.op, body)
			}
		}
	}
}

func TestInstalledSeedancePluginsSupportDraftAndDraftToFinal(t *testing.T) {
	for _, plugin := range []struct{ file, id string }{
		{"volcengine-ark-seedance.qisitv-plugin", "volcengine-ark-video"},
		{"volcengine-ark-agent-plan-seedance.qisitv-plugin", "volcengine-ark-agent-plan-video"},
		{"seedance-videos-compatible.qisitv-plugin", "seedance-videos-compatible"},
	} {
		a := officialPackageAdapter(t, plugin.file, plugin.id)

		draftSpec, err := a.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Capability:  CapabilityVideo,
			Model:       "doubao-seedance-2-5-260628",
			Prompt:      "preview shot",
			AspectRatio: "16:9",
			Duration:    5,
			Quality:     "480p",
			Extra:       map[string]any{"draft": true},
		}})
		if err != nil {
			t.Fatal(err)
		}
		draftBody := manifestTestBody(t, draftSpec)
		if draftBody["draft"] != true {
			t.Fatalf("%s draft body missing draft=true: %#v", plugin.id, draftBody)
		}

		finalSpec, err := a.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Capability: CapabilityVideo,
			Model:      "doubao-seedance-2-5-260628",
			Operation:  "draft_to_final",
			Quality:    "1080p",
			Extra:      map[string]any{"draft_task_id": "cgt-draft-123"},
		}})
		if err != nil {
			t.Fatal(err)
		}
		finalBody := manifestTestBody(t, finalSpec)
		content, ok := finalBody["content"].([]any)
		if !ok || len(content) != 1 {
			t.Fatalf("%s draft_to_final content invalid: %#v", plugin.id, finalBody)
		}
		item, ok := content[0].(map[string]any)
		if !ok || item["type"] != "draft_task" {
			t.Fatalf("%s draft_to_final item invalid: %#v", plugin.id, item)
		}
		draftTask, ok := item["draft_task"].(map[string]any)
		if !ok || draftTask["id"] != "cgt-draft-123" {
			t.Fatalf("%s draft_to_final id invalid: %#v", plugin.id, item)
		}
		for _, forbidden := range []string{"prompt", "ratio", "aspect_ratio", "duration", "draft"} {
			if _, exists := finalBody[forbidden]; exists {
				t.Fatalf("%s draft_to_final retained forbidden field %q: %#v", plugin.id, forbidden, finalBody)
			}
		}
	}
}

func TestVendorNeutralBYOKProtocolsSupportBusinessActionsAndLastFramePoll(t *testing.T) {
	for _, plugin := range []struct{ file, id string }{
		{"newapi-media-task-v1.qisitv-plugin", "newapi-channel-1"},
		{"newapi-video-generations-v1.qisitv-plugin", "newapi-channel-2"},
		{"video-generations-json.qisitv-plugin", "video-generations-json"},
	} {
		a := officialPackageAdapter(t, plugin.file, plugin.id)
		spec, err := a.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Capability:  CapabilityVideo,
			Model:       "seedance-2.5",
			Prompt:      "edit video",
			Operation:   "inpaint",
			AspectRatio: "16:9",
			Duration:    5,
			Videos:      []MediaReference{{URL: "https://example.com/ref.mp4"}},
			Extra:       map[string]any{"draft": true, "return_last_frame": true, "taskTypeConstraints": true},
		}})
		if err != nil {
			t.Fatalf("%s BuildCreate failed: %v", plugin.id, err)
		}
		body := manifestTestBody(t, spec)
		if body["draft"] != true || body["return_last_frame"] != true || body["omni_reference_task_type"] != "edit" {
			t.Fatalf("%s missing vendor-neutral body fields: %#v", plugin.id, body)
		}
		if params, ok := body["parameters"].(map[string]any); ok {
			if params["ratio"] != "adaptive" || params["duration"] != float64(-1) {
				t.Fatalf("%s parameters did not normalize ratio/duration: %#v", plugin.id, params)
			}
		} else {
			ratio := body["ratio"]
			if ratio == nil {
				ratio = body["aspect_ratio"]
			}
			duration := body["duration"]
			if duration == nil {
				duration = body["seconds"]
			}
			if ratio != "adaptive" || (duration != float64(-1) && duration != "-1") {
				t.Fatalf("%s body did not normalize ratio/duration: %#v", plugin.id, body)
			}
		}

		finalSpec, err := a.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Capability: CapabilityVideo,
			Model:      "seedance-2.5",
			Operation:  "draft_to_final",
			Resolution: "1080p",
			Extra:      map[string]any{"draft_task_id": "cgt-draft-999"},
		}})
		if err != nil {
			t.Fatalf("%s draft_to_final BuildCreate failed: %v", plugin.id, err)
		}
		finalBody := manifestTestBody(t, finalSpec)
		if _, ok := finalBody["content"].([]any); !ok {
			t.Fatalf("%s draft_to_final missing content: %#v", plugin.id, finalBody)
		}

		poll, err := a.ParsePoll(context.Background(), PollContext{TaskID: "t1"}, []byte(`{"status":"completed","video_url":"https://example.com/out.mp4","data":[{"url":"https://example.com/out.mp4","last_frame_url":"https://example.com/last.png"}]}`))
		if err != nil || poll.Result == nil || len(poll.Result.Videos) == 0 {
			t.Fatalf("%s ParsePoll failed: %+v err=%v", plugin.id, poll, err)
		}
		if poll.Result.Videos[0].Metadata["last_frame_url"] != "https://example.com/last.png" {
			t.Fatalf("%s ParsePoll did not extract last_frame_url: %+v", plugin.id, poll.Result.Videos[0])
		}
	}
}
