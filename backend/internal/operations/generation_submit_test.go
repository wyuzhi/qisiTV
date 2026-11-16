package operations

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/modelcatalog"
)

type mixedGenerationProbe struct {
	proposeProbe
	admitted []GenerationTarget
}

func (p *mixedGenerationProbe) SubmitAuthorizedGeneration(_, _, _ string, targets []GenerationTarget) (any, error) {
	p.admitted = targets
	return map[string]any{"taskIds": []string{"video-task", "voice-task"}}, nil
}

func TestGenerationSubmitMixedReadyTargetsAndDependencyRejection(t *testing.T) {
	for _, pending := range []bool{false, true} {
		t.Run(map[bool]string{false: "ready", true: "pending-reference"}[pending], func(t *testing.T) {
			frame := imageNode("frame", "image")
			if !pending {
				frame["metadata"].(map[string]any)["storageKey"] = "resource:frame"
			}
			video := imageNode("video", "video")
			video["type"] = "video"
			video["metadata"].(map[string]any)["videoStartFrameNodeId"] = "frame"
			voice := imageNode("voice", "speech")
			voice["type"] = "audio"
			p := &mixedGenerationProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{frame, video, voice})}}
			p.resolve = func(kind, selected string) (AssistantGenerationModel, error) {
				return AssistantGenerationModel{ModelKey: selected}, nil
			}
			_, err := opGenerationSubmit(&Context{TurnID: "turn", UserID: "owner", Domain: p}, json.RawMessage(`{"canvasId":"c1","nodeIds":["video","voice"]}`))
			if pending {
				if err == nil || len(p.admitted) != 0 {
					t.Fatal("unready dependency admitted paid work", err)
				}
			} else if err != nil || len(p.admitted) != 2 || p.admitted[0].Kind != "video" || p.admitted[1].Kind != "audio" {
				t.Fatalf("mixed admission: %+v %v", p.admitted, err)
			}
		})
	}
}

func TestProductionSeedreamUnsupportedOutputsNeverReachAdmission(t *testing.T) {
	for _, tc := range []struct{ name, model, mode, max string }{
		{"layers", "custom::dola-seedream-5-0-pro-260128", "layers", "1"},
		{"flash-layers", "dola-seedream-5-0-flash-260128", "layers", "1"},
		{"group", "custom::seedream-4-5-251128", "image", "4"},
		{"lite-group", "custom::seedream-5-0-260128", "image", "2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n := imageNode("image", tc.model)
			meta := n["metadata"].(map[string]any)
			meta["seedreamMode"], meta["seedreamMaxImages"] = tc.mode, tc.max
			p := &mixedGenerationProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{n})}}
			p.resolve = func(_, selected string) (AssistantGenerationModel, error) {
				return AssistantGenerationModel{Display: selected, ModelKey: selected}, nil
			}
			for _, propose := range []bool{true, false} {
				var result any
				var err error
				ctx := &Context{TurnID: "turn", UserID: "owner", Domain: p}
				if propose {
					result, err = opCanvasGenerationPropose(ctx, json.RawMessage(`{"canvasId":"c1","nodeIds":["image"],"kind":"image","productionNodeIds":["image"]}`))
				} else {
					result, err = opGenerationSubmit(ctx, json.RawMessage(`{"canvasId":"c1","nodeIds":["image"]}`))
				}
				if err == nil || AsError(err).Reason != "production_seedream_multiple_outputs" || result != nil || len(p.admitted) != 0 {
					t.Fatalf("unsupported combination reached paid admission (propose=%v): result=%v targets=%+v err=%v", propose, result, p.admitted, err)
				}
			}
		})
	}
}

func TestProductionSeedreamSingleImageKeepsConfirmedOptions(t *testing.T) {
	for _, model := range []string{"custom::seedream-5-0-260128", "custom::dola-seedream-5-0-pro-260128", "custom::other-image"} {
		t.Run(model, func(t *testing.T) {
			n := imageNode("image", model)
			meta := n["metadata"].(map[string]any)
			options := map[string]string{"seedreamMode": "image", "seedreamMaxImages": "1", "seedreamOutputFormat": "jpeg", "seedreamOptimize": "fast", "seedreamWatermark": "true"}
			for k, v := range options {
				meta[k] = v
			}
			if model == "custom::other-image" {
				meta["seedreamMode"], meta["seedreamMaxImages"] = "layers", "4"
			}
			p := &mixedGenerationProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{n})}}
			p.resolve = func(_, selected string) (AssistantGenerationModel, error) {
				return AssistantGenerationModel{ModelKey: selected}, nil
			}
			_, err := opGenerationSubmit(&Context{TurnID: "turn", UserID: "owner", Domain: p}, json.RawMessage(`{"canvasId":"c1","nodeIds":["image"]}`))
			if err != nil || len(p.admitted) != 1 {
				t.Fatalf("single-image admission: %+v %v", p.admitted, err)
			}
			for k, v := range options {
				want := v
				if model == "custom::other-image" {
					want = ""
				}
				if got := p.admitted[0].Parameters[k]; got != want {
					t.Fatalf("confirmed %s changed: got %q want %q", k, got, want)
				}
			}
		})
	}
}

type catalogGenerationProbe struct {
	mixedGenerationProbe
	catalog *modelcatalog.CatalogResponse
}

func (p *catalogGenerationProbe) AgentModelCatalog() (*modelcatalog.CatalogResponse, error) {
	return p.catalog, nil
}

func TestGenerationTargetsReconcilesStaleVideoOperationWithModelCapabilities(t *testing.T) {
	wanCap := map[string]any{
		"video": map[string]any{
			"defaultOperation": "text_to_video",
			"operations":       []string{"text_to_video", "image_to_video", "reference_to_video"},
			"references":       map[string]any{"maxImages": 10, "maxVideos": 5, "maxAudios": 5},
			"operationReferences": map[string]any{
				"image_to_video":     map[string]any{"maxImages": 2, "maxVideos": 0, "maxAudios": 0},
				"reference_to_video": map[string]any{"maxImages": 10, "maxVideos": 5, "maxAudios": 5},
			},
		},
	}
	agnesCap := map[string]any{
		"video": map[string]any{
			"defaultOperation": "text_to_video",
			"operations":       []string{"text_to_video", "image_to_video", "reference_to_video", "audio_to_video"},
			"references":       map[string]any{"maxImages": 9, "maxVideos": 3, "maxAudios": 3},
		},
	}
	klingCap := map[string]any{
		"video": map[string]any{
			"defaultOperation": "text_to_video",
			"operations":       []string{"text_to_video", "image_to_video"},
			"references":       map[string]any{"maxImages": 1, "maxVideos": 0, "maxAudios": 0},
		},
	}
	hostedH3Cap := map[string]any{
		"video": map[string]any{
			"defaultOperation": "text_to_video",
			"operations":       []string{"text_to_video", "image_to_video", "audio_to_video"},
			"references":       map[string]any{"maxImages": 2, "maxVideos": 0, "maxAudios": 1},
		},
	}
	contractH3MaxCap := map[string]any{
		"video": map[string]any{
			"defaultOperation": "text_to_video",
			"operations":       []string{"text_to_video", "image_to_video", "audio_to_video", "reference_to_video"},
			"references":       map[string]any{"maxImages": 9, "maxVideos": 3, "maxAudios": 3},
			"middleFrame":      true,
			"operationReferences": map[string]any{
				"image_to_video": map[string]any{"maxImages": 2, "maxVideos": 0, "maxAudios": 1},
			},
		},
	}
	versionedH3LiveCap := map[string]any{
		"video": map[string]any{
			"defaultOperation": "text_to_video",
			"operations":       []string{"text_to_video", "image_to_video", "audio_to_video", "reference_to_video"},
			"references":       map[string]any{"maxImages": 9, "maxVideos": 3, "maxAudios": 3},
		},
	}
	explicitNoMidH3MaxCap := map[string]any{
		"video": map[string]any{
			"defaultOperation": "text_to_video",
			"operations":       []string{"text_to_video", "image_to_video", "audio_to_video", "reference_to_video"},
			"references":       map[string]any{"maxImages": 9, "maxVideos": 3, "maxAudios": 3},
			"middleFrame":      false,
		},
	}
	partialOpRefH3Cap := map[string]any{
		"video": map[string]any{
			"defaultOperation": "text_to_video",
			"operations":       []string{"text_to_video", "image_to_video", "audio_to_video", "reference_to_video"},
			"references":       map[string]any{"maxImages": 9, "maxVideos": 3, "maxAudios": 3},
			"operationReferences": map[string]any{
				"image_to_video": map[string]any{"maxImages": 2},
			},
		},
	}
	emptyOpRefH3Cap := map[string]any{
		"video": map[string]any{
			"defaultOperation":    "text_to_video",
			"operations":          []string{"text_to_video", "image_to_video", "audio_to_video", "reference_to_video"},
			"references":          map[string]any{"maxImages": 9, "maxVideos": 3, "maxAudios": 3},
			"operationReferences": map[string]any{},
		},
	}
	customKlingTwoFrameCap := map[string]any{
		"video": map[string]any{
			"defaultOperation": "text_to_video",
			"operations":       []string{"text_to_video", "image_to_video"},
			"references":       map[string]any{"maxImages": 2, "maxVideos": 0, "maxAudios": 0},
		},
	}
	customFrame9Cap := map[string]any{
		"video": map[string]any{
			"defaultOperation": "text_to_video",
			"operations":       []string{"text_to_video", "image_to_video"},
			"references":       map[string]any{"maxImages": 9, "maxVideos": 0, "maxAudios": 0},
		},
	}
	autoDefaultCustomCap := map[string]any{
		"video": map[string]any{
			"defaultOperation": "text_to_video",
			"operations":       []string{"text_to_video", "image_to_video"},
			"references":       map[string]any{"maxImages": 2, "maxVideos": 0, "maxAudios": 0},
		},
	}
	undeclared := false
	managedRoute := true
	customRoute := false
	catalog := modelcatalog.NewCatalogResponse(modelcatalog.CatalogSourceSystem, nil, []modelcatalog.PublicChannelCatalog{
		{
			ID: "beeftv",
			Models: []modelcatalog.PublicChannelModel{
				{ID: "wan3.0-video", ModelKey: "wan3.0-video", Capability: "video", Available: true, ManagedBeefTV: &managedRoute, CapabilityConfig: wanCap},
				{ID: "agnes-2.5", ModelKey: "agnes-2.5", Capability: "video", Available: true, ManagedBeefTV: &managedRoute, CapabilityConfig: agnesCap},
				{ID: "kling-video-v3", ModelKey: "kling-video-v3", Capability: "video", Available: true, ManagedBeefTV: &managedRoute, CapabilityConfig: klingCap},
				{ID: "minimax-h3-max-turbo", ModelKey: "minimax-h3-max-turbo", Capability: "video", Available: true, ManagedBeefTV: &managedRoute, CapabilityConfig: hostedH3Cap},
				{ID: "minimax-h3-max", ModelKey: "minimax-h3-max", Capability: "video", Available: true, ManagedBeefTV: &managedRoute, CapabilityConfig: contractH3MaxCap},
				{ID: "minimax-h3", ModelKey: "minimax-h3", Capability: "video", Available: true, ManagedBeefTV: &managedRoute, CapabilityConfig: versionedH3LiveCap},
			},
		},
		{
			ID: "live",
			Models: []modelcatalog.PublicChannelModel{
				{ID: "minimax-h3-max", ModelKey: "minimax-h3-max", Capability: "video", Available: true, ManagedBeefTV: &managedRoute, CapabilityConfig: hostedH3Cap},
			},
		},
		{
			ID: "beeftv-omni",
			Models: []modelcatalog.PublicChannelModel{
				{ID: "minimax-h3-max", ModelKey: "minimax-h3-max", Capability: "video", Available: true, ManagedBeefTV: &managedRoute, CapabilityConfig: versionedH3LiveCap},
			},
		},
		{
			ID: "partial-beeftv",
			Models: []modelcatalog.PublicChannelModel{
				{ID: "minimax-h3", ModelKey: "minimax-h3", Capability: "video", Available: true, ManagedBeefTV: &managedRoute, CapabilityConfig: partialOpRefH3Cap},
			},
		},
		{
			ID: "empty-beeftv",
			Models: []modelcatalog.PublicChannelModel{
				{ID: "minimax-h3", ModelKey: "minimax-h3", Capability: "video", Available: true, ManagedBeefTV: &managedRoute, CapabilityConfig: emptyOpRefH3Cap},
			},
		},
		{
			ID: "override",
			Models: []modelcatalog.PublicChannelModel{
				{ID: "minimax-h3-max", ModelKey: "minimax-h3-max", Capability: "video", Available: true, ManagedBeefTV: &managedRoute, CapabilityConfig: explicitNoMidH3MaxCap},
			},
		},
		{
			ID: "custom",
			Models: []modelcatalog.PublicChannelModel{
				{ID: "opaque-video", ModelKey: "opaque-video", Capability: "video", Available: true, ManagedBeefTV: &customRoute, CapabilityDeclared: &undeclared, CapabilityConfig: autoDefaultCustomCap},
				{ID: "minimax-h3-max", ModelKey: "minimax-h3-max", Capability: "video", Available: true, ManagedBeefTV: &customRoute, CapabilityConfig: versionedH3LiveCap},
				{ID: "kling-video-v3", ModelKey: "kling-video-v3", Capability: "video", Available: true, ManagedBeefTV: &customRoute, CapabilityConfig: customKlingTwoFrameCap},
				{ID: "frame9-video", ModelKey: "frame9-video", Capability: "video", Available: true, ManagedBeefTV: &customRoute, CapabilityConfig: customFrame9Cap},
			},
		},
	})

	img1 := imageNode("img-1", "image")
	img1["metadata"].(map[string]any)["storageKey"] = "resource:img-1"
	img2 := imageNode("img-2", "image")
	img2["metadata"].(map[string]any)["storageKey"] = "resource:img-2"
	img3 := imageNode("img-3", "image")
	img3["metadata"].(map[string]any)["storageKey"] = "resource:img-3"
	aud1 := imageNode("aud-1", "audio")
	aud1["type"] = "audio"
	aud1["metadata"].(map[string]any)["storageKey"] = "resource:aud-1"
	aud2 := imageNode("aud-2", "audio")
	aud2["type"] = "audio"
	aud2["metadata"].(map[string]any)["storageKey"] = "resource:aud-2"
	charCard := imageNode("char-1", "image")
	charCard["metadata"].(map[string]any)["storageKey"] = "resource:char-1"
	charCard["metadata"].(map[string]any)["workflowKind"] = "character"
	charCard["metadata"].(map[string]any)["characterAssetId"] = "asset:hero"
	drawingRef := map[string]any{"id": "draw-1", "type": "drawing", "title": "草图", "metadata": map[string]any{"drawingId": "draw-1"}}
	colorgradeRef := imageNode("cg-1", "image")
	colorgradeRef["type"] = "colorgrade"
	colorgradeRef["metadata"].(map[string]any)["storageKey"] = "resource:cg-1"
	convVideoRef := map[string]any{"id": "conv-vid", "type": "media-conversion", "title": "转码视频", "metadata": map[string]any{"storageKey": "resource:conv-vid", "mediaConversion": map[string]any{"outputKind": "video"}}}

	wanVideo := imageNode("wan-shot", "beeftv::wan3.0-video")
	wanVideo["type"] = "video"
	wanVideo["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	wanVideo["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"

	agnesVideo := imageNode("agnes-shot", "beeftv::agnes-2.5")
	agnesVideo["type"] = "video"
	agnesVideo["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	agnesVideo["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"

	klingVideo := imageNode("kling-shot", "beeftv::kling-video-v3")
	klingVideo["type"] = "video"
	klingVideo["metadata"].(map[string]any)["videoEditOperation"] = "reference_to_video"
	klingVideo["metadata"].(map[string]any)["videoEndFrameNodeId"] = "img-1"

	hostedH3Lip := imageNode("hosted-h3-lip", "beeftv::minimax-h3-max-turbo")
	hostedH3Lip["type"] = "video"
	hostedH3Lip["metadata"].(map[string]any)["videoEditOperation"] = "reference_to_video"
	hostedH3Lip["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"

	h3FrameAudio := imageNode("h3-lip-shot", "beeftv::minimax-h3-max")
	h3FrameAudio["type"] = "video"
	h3FrameAudio["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	h3FrameAudio["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"

	h3MidFrame := imageNode("h3-mid-shot", "beeftv::minimax-h3-max")
	h3MidFrame["type"] = "video"
	h3MidFrame["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	h3MidFrame["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"
	h3MidFrame["metadata"].(map[string]any)["videoMiddleFrameNodeId"] = "img-2"
	h3MidFrame["metadata"].(map[string]any)["videoEndFrameNodeId"] = "img-3"
	h3MidFrame["metadata"].(map[string]any)["videoMiddleFrameTime"] = 2.5
	h3MidFrame["metadata"].(map[string]any)["videoReferenceOrder"] = []any{"img-3", "img-1"}
	h3MidFrame["metadata"].(map[string]any)["videoH3Options"] = map[string]any{"seed": float64(7)}

	switchedFromH3 := imageNode("wan-from-h3", "beeftv::wan3.0-video")
	switchedFromH3["type"] = "video"
	switchedFromH3["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	switchedFromH3["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"
	switchedFromH3["metadata"].(map[string]any)["videoMiddleFrameNodeId"] = "img-2"
	switchedFromH3["metadata"].(map[string]any)["videoMiddleFrameTime"] = 1.8
	switchedFromH3["metadata"].(map[string]any)["videoReferenceOrder"] = []any{"img-2", "img-1"}
	switchedFromH3["metadata"].(map[string]any)["videoH3Options"] = map[string]any{"seed": float64(7)}

	charAndDrawShot := imageNode("char-draw-shot", "beeftv::agnes-2.5")
	charAndDrawShot["type"] = "video"
	charAndDrawShot["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	charAndDrawShot["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"

	convVideoShot := imageNode("conv-video-shot", "beeftv::wan3.0-video")
	convVideoShot["type"] = "video"
	convVideoShot["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"

	versionedH3Lip := imageNode("versioned-h3-lip", "beeftv::minimax-h3")
	versionedH3Lip["type"] = "video"
	versionedH3Lip["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	versionedH3Lip["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"

	versionedH3TwoAudio := imageNode("versioned-h3-2aud", "beeftv::minimax-h3")
	versionedH3TwoAudio["type"] = "video"
	versionedH3TwoAudio["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	versionedH3TwoAudio["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"

	liveH3MaxMid := imageNode("live-h3max-mid", "live::minimax-h3-max")
	liveH3MaxMid["type"] = "video"
	liveH3MaxMid["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	liveH3MaxMid["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"
	liveH3MaxMid["metadata"].(map[string]any)["videoMiddleFrameNodeId"] = "img-2"
	liveH3MaxMid["metadata"].(map[string]any)["videoMiddleFrameTime"] = 2.5

	omniH3MaxMid := imageNode("omni-h3max-mid", "beeftv-omni::minimax-h3-max")
	omniH3MaxMid["type"] = "video"
	omniH3MaxMid["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	omniH3MaxMid["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"
	omniH3MaxMid["metadata"].(map[string]any)["videoMiddleFrameNodeId"] = "img-2"
	omniH3MaxMid["metadata"].(map[string]any)["videoEndFrameNodeId"] = "img-3"
	omniH3MaxMid["metadata"].(map[string]any)["videoMiddleFrameTime"] = 2.5

	overrideH3MaxNoMid := imageNode("override-h3max-nomid", "override::minimax-h3-max")
	overrideH3MaxNoMid["type"] = "video"
	overrideH3MaxNoMid["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	overrideH3MaxNoMid["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"
	overrideH3MaxNoMid["metadata"].(map[string]any)["videoMiddleFrameNodeId"] = "img-2"
	overrideH3MaxNoMid["metadata"].(map[string]any)["videoMiddleFrameTime"] = 2.5

	opaqueCustomShot := imageNode("opaque-custom-shot", "custom::opaque-video")
	opaqueCustomShot["type"] = "video"
	opaqueCustomShot["metadata"].(map[string]any)["videoEditOperation"] = "reference_to_video"
	opaqueCustomShot["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"
	opaqueCustomShot["metadata"].(map[string]any)["videoMiddleFrameNodeId"] = "img-2"
	opaqueCustomShot["metadata"].(map[string]any)["videoMiddleFrameTime"] = 2.5
	opaqueCustomShot["metadata"].(map[string]any)["videoReferenceOrder"] = []any{"img-2", "img-1"}
	opaqueCustomShot["metadata"].(map[string]any)["videoH3Options"] = map[string]any{"seed": float64(11)}

	customH3MaxShot := imageNode("custom-h3max-shot", "custom::minimax-h3-max")
	customH3MaxShot["type"] = "video"
	customH3MaxShot["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	customH3MaxShot["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"
	customH3MaxShot["metadata"].(map[string]any)["videoMiddleFrameNodeId"] = "img-2"
	customH3MaxShot["metadata"].(map[string]any)["videoMiddleFrameTime"] = 2.5
	customH3MaxShot["metadata"].(map[string]any)["videoReferenceOrder"] = []any{"img-2", "img-1"}
	customH3MaxShot["metadata"].(map[string]any)["videoH3Options"] = map[string]any{"seed": float64(13)}

	customKlingShot := imageNode("custom-kling-shot", "custom::kling-video-v3")
	customKlingShot["type"] = "video"
	customKlingShot["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	customKlingShot["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"
	customKlingShot["metadata"].(map[string]any)["videoEndFrameNodeId"] = "img-2"
	customKlingShot["metadata"].(map[string]any)["videoReferenceOrder"] = []any{"img-2", "img-1"}
	customKlingShot["metadata"].(map[string]any)["videoH3Options"] = map[string]any{"seed": float64(15)}

	partialOpRefH3Shot := imageNode("partial-opref-h3", "partial-beeftv::minimax-h3")
	partialOpRefH3Shot["type"] = "video"
	partialOpRefH3Shot["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	partialOpRefH3Shot["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"

	emptyOpRefH3Shot := imageNode("empty-opref-h3", "empty-beeftv::minimax-h3")
	emptyOpRefH3Shot["type"] = "video"
	emptyOpRefH3Shot["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	emptyOpRefH3Shot["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"

	frame9ThreeImgShot := imageNode("frame9-over-limit", "custom::frame9-video")
	frame9ThreeImgShot["type"] = "video"
	frame9ThreeImgShot["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"

	staleRemovedShot := imageNode("stale-removed-h3", "beeftv::removed-h3-max")
	staleRemovedShot["type"] = "video"
	staleRemovedShot["metadata"].(map[string]any)["videoEditOperation"] = "reference_to_video"
	staleRemovedShot["metadata"].(map[string]any)["videoMiddleFrameNodeId"] = "img-2"
	staleRemovedShot["metadata"].(map[string]any)["videoMiddleFrameTime"] = 2.5

	unqualifiedKlingShot := imageNode("unqualified-kling-shot", "kling-video-v3")
	unqualifiedKlingShot["type"] = "video"
	unqualifiedKlingShot["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	unqualifiedKlingShot["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"
	unqualifiedKlingShot["metadata"].(map[string]any)["videoEndFrameNodeId"] = "img-2"

	unqualifiedH3MaxShot := imageNode("unqualified-h3max-shot", "minimax-h3-max")
	unqualifiedH3MaxShot["type"] = "video"
	unqualifiedH3MaxShot["metadata"].(map[string]any)["videoEditOperation"] = "image_to_video"
	unqualifiedH3MaxShot["metadata"].(map[string]any)["videoStartFrameNodeId"] = "img-1"
	unqualifiedH3MaxShot["metadata"].(map[string]any)["videoMiddleFrameNodeId"] = "img-2"
	unqualifiedH3MaxShot["metadata"].(map[string]any)["videoMiddleFrameTime"] = 2.5

	allNodes := []map[string]any{
		img1, img2, img3, aud1, aud2, charCard, drawingRef, colorgradeRef, convVideoRef,
		wanVideo, agnesVideo, klingVideo, hostedH3Lip, h3FrameAudio, h3MidFrame, switchedFromH3, charAndDrawShot, convVideoShot,
		versionedH3Lip, versionedH3TwoAudio, liveH3MaxMid, omniH3MaxMid, overrideH3MaxNoMid, opaqueCustomShot,
		customH3MaxShot, customKlingShot, partialOpRefH3Shot, emptyOpRefH3Shot, frame9ThreeImgShot, staleRemovedShot,
		unqualifiedKlingShot, unqualifiedH3MaxShot,
	}
	rawNodes := make([]any, 0, len(allNodes))
	for _, item := range allNodes {
		rawNodes = append(rawNodes, item)
	}
	doc := map[string]any{
		"nodes": rawNodes,
		"connections": []any{
			map[string]any{"fromNodeId": "img-1", "toNodeId": "wan-shot"},
			map[string]any{"fromNodeId": "img-2", "toNodeId": "wan-shot"},
			map[string]any{"fromNodeId": "aud-1", "toNodeId": "wan-shot"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "agnes-shot"},
			map[string]any{"fromNodeId": "aud-1", "toNodeId": "agnes-shot"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "kling-shot"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "hosted-h3-lip"},
			map[string]any{"fromNodeId": "aud-1", "toNodeId": "hosted-h3-lip"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "h3-lip-shot"},
			map[string]any{"fromNodeId": "aud-1", "toNodeId": "h3-lip-shot"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "h3-mid-shot"},
			map[string]any{"fromNodeId": "img-2", "toNodeId": "h3-mid-shot"},
			map[string]any{"fromNodeId": "img-3", "toNodeId": "h3-mid-shot"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "wan-from-h3"},
			map[string]any{"fromNodeId": "img-2", "toNodeId": "wan-from-h3"},
			map[string]any{"fromNodeId": "char-1", "toNodeId": "char-draw-shot"},
			map[string]any{"fromNodeId": "draw-1", "toNodeId": "char-draw-shot"},
			map[string]any{"fromNodeId": "cg-1", "toNodeId": "char-draw-shot"},
			map[string]any{"fromNodeId": "conv-vid", "toNodeId": "conv-video-shot"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "versioned-h3-lip"},
			map[string]any{"fromNodeId": "aud-1", "toNodeId": "versioned-h3-lip"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "versioned-h3-2aud"},
			map[string]any{"fromNodeId": "aud-1", "toNodeId": "versioned-h3-2aud"},
			map[string]any{"fromNodeId": "aud-2", "toNodeId": "versioned-h3-2aud"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "live-h3max-mid"},
			map[string]any{"fromNodeId": "img-2", "toNodeId": "live-h3max-mid"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "omni-h3max-mid"},
			map[string]any{"fromNodeId": "img-2", "toNodeId": "omni-h3max-mid"},
			map[string]any{"fromNodeId": "img-3", "toNodeId": "omni-h3max-mid"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "override-h3max-nomid"},
			map[string]any{"fromNodeId": "img-2", "toNodeId": "override-h3max-nomid"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "opaque-custom-shot"},
			map[string]any{"fromNodeId": "img-2", "toNodeId": "opaque-custom-shot"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "custom-h3max-shot"},
			map[string]any{"fromNodeId": "img-2", "toNodeId": "custom-h3max-shot"},
			map[string]any{"fromNodeId": "aud-1", "toNodeId": "custom-h3max-shot"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "custom-kling-shot"},
			map[string]any{"fromNodeId": "img-2", "toNodeId": "custom-kling-shot"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "partial-opref-h3"},
			map[string]any{"fromNodeId": "aud-1", "toNodeId": "partial-opref-h3"},
			map[string]any{"fromNodeId": "aud-2", "toNodeId": "partial-opref-h3"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "empty-opref-h3"},
			map[string]any{"fromNodeId": "aud-1", "toNodeId": "empty-opref-h3"},
			map[string]any{"fromNodeId": "aud-2", "toNodeId": "empty-opref-h3"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "frame9-over-limit"},
			map[string]any{"fromNodeId": "img-2", "toNodeId": "frame9-over-limit"},
			map[string]any{"fromNodeId": "img-3", "toNodeId": "frame9-over-limit"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "stale-removed-h3"},
			map[string]any{"fromNodeId": "img-2", "toNodeId": "stale-removed-h3"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "unqualified-kling-shot"},
			map[string]any{"fromNodeId": "img-2", "toNodeId": "unqualified-kling-shot"},
			map[string]any{"fromNodeId": "img-1", "toNodeId": "unqualified-h3max-shot"},
			map[string]any{"fromNodeId": "img-2", "toNodeId": "unqualified-h3max-shot"},
		},
	}

	probe := &catalogGenerationProbe{
		mixedGenerationProbe: mixedGenerationProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, allNodes)}},
		catalog:              &catalog,
	}
	probe.resolve = func(_, selected string) (AssistantGenerationModel, error) {
		return AssistantGenerationModel{ModelKey: selected, Display: selected}, nil
	}

	shotIDs := []string{
		"wan-shot", "agnes-shot", "kling-shot", "hosted-h3-lip", "h3-lip-shot", "h3-mid-shot", "wan-from-h3", "char-draw-shot", "conv-video-shot",
		"versioned-h3-lip", "versioned-h3-2aud", "live-h3max-mid", "omni-h3max-mid", "override-h3max-nomid", "opaque-custom-shot",
		"custom-h3max-shot", "custom-kling-shot", "partial-opref-h3", "empty-opref-h3", "stale-removed-h3",
		"unqualified-kling-shot", "unqualified-h3max-shot",
	}
	targets, err := GenerationTargets(probe, doc, shotIDs)
	if err != nil {
		t.Fatalf("GenerationTargets error: %v", err)
	}
	byID := map[string]GenerationTarget{}
	for _, target := range targets {
		byID[target.NodeID] = target
	}

	if got := byID["wan-shot"].Metadata["videoEditOperation"]; got != "reference_to_video" {
		t.Fatalf("wan-shot videoEditOperation = %v, want reference_to_video", got)
	}
	if got := byID["wan-shot"].Parameters["videoStartFrameNodeId"]; got != "" {
		t.Fatalf("wan-shot stale videoStartFrameNodeId not cleared: %q", got)
	}
	if got := byID["agnes-shot"].Metadata["videoEditOperation"]; got != "reference_to_video" {
		t.Fatalf("agnes-shot videoEditOperation = %v, want reference_to_video", got)
	}
	if got := byID["agnes-shot"].Parameters["videoStartFrameNodeId"]; got != "" {
		t.Fatalf("agnes-shot stale videoStartFrameNodeId not cleared: %q", got)
	}
	if got := byID["kling-shot"].Metadata["videoEditOperation"]; got != "image_to_video" {
		t.Fatalf("kling-shot videoEditOperation = %v, want image_to_video", got)
	}
	if got := byID["kling-shot"].Parameters["videoEndFrameNodeId"]; got != "" {
		t.Fatalf("kling-shot stale videoEndFrameNodeId not cleared: %q", got)
	}
	if got := byID["hosted-h3-lip"].Metadata["videoEditOperation"]; got != "image_to_video" {
		t.Fatalf("hosted-h3-lip videoEditOperation = %v, want image_to_video", got)
	}
	if got := byID["hosted-h3-lip"].Parameters["videoStartFrameNodeId"]; got != "img-1" {
		t.Fatalf("hosted-h3-lip videoStartFrameNodeId = %q, want img-1", got)
	}
	if got := byID["h3-lip-shot"].Metadata["videoEditOperation"]; got != "image_to_video" {
		t.Fatalf("h3-lip-shot videoEditOperation = %v, want image_to_video", got)
	}
	if got := byID["h3-lip-shot"].Parameters["videoStartFrameNodeId"]; got != "img-1" {
		t.Fatalf("h3-lip-shot videoStartFrameNodeId = %q, want img-1", got)
	}
	if got := byID["h3-mid-shot"].Metadata["videoEditOperation"]; got != "reference_to_video" {
		t.Fatalf("h3-mid-shot videoEditOperation = %v, want reference_to_video", got)
	}
	if got := byID["h3-mid-shot"].Parameters["videoMiddleFrameNodeId"]; got != "img-2" {
		t.Fatalf("h3-mid-shot videoMiddleFrameNodeId = %q, want img-2", got)
	}
	if got := byID["h3-mid-shot"].Metadata["videoMiddleFrameTime"]; got != 2.5 {
		t.Fatalf("h3-mid-shot videoMiddleFrameTime = %v, want 2.5", got)
	}
	if got := byID["h3-mid-shot"].Metadata["videoReferenceOrder"]; got == nil {
		t.Fatal("h3-mid-shot lost videoReferenceOrder")
	}
	if got := byID["wan-from-h3"].Metadata["videoEditOperation"]; got != "image_to_video" {
		t.Fatalf("wan-from-h3 falsely promoted to %v, want image_to_video", got)
	}
	if got := byID["wan-from-h3"].Parameters["videoMiddleFrameNodeId"]; got != "" {
		t.Fatalf("wan-from-h3 leaked videoMiddleFrameNodeId: %q", got)
	}
	if got := byID["wan-from-h3"].Metadata["videoReferenceOrder"]; got != nil {
		t.Fatalf("wan-from-h3 leaked videoReferenceOrder: %#v", got)
	}
	if got := byID["wan-from-h3"].Metadata["videoH3Options"]; got != nil {
		t.Fatalf("wan-from-h3 leaked videoH3Options: %#v", got)
	}
	if _, exists := byID["wan-from-h3"].Metadata["videoMiddleFrameTime"]; exists {
		t.Fatalf("wan-from-h3 leaked videoMiddleFrameTime: %v", byID["wan-from-h3"].Metadata["videoMiddleFrameTime"])
	}
	if got := byID["char-draw-shot"].Metadata["videoEditOperation"]; got != "reference_to_video" {
		t.Fatalf("char-draw-shot videoEditOperation = %v, want reference_to_video", got)
	}
	if got := byID["char-draw-shot"].Parameters["videoStartFrameNodeId"]; got != "" {
		t.Fatalf("char-draw-shot stale videoStartFrameNodeId not cleared: %q", got)
	}
	if got := byID["conv-video-shot"].Metadata["videoEditOperation"]; got != "reference_to_video" {
		t.Fatalf("conv-video-shot videoEditOperation = %v, want reference_to_video", got)
	}
	if got := byID["versioned-h3-lip"].Metadata["videoEditOperation"]; got != "image_to_video" {
		t.Fatalf("versioned-h3-lip videoEditOperation = %v, want image_to_video", got)
	}
	if got := byID["versioned-h3-lip"].Parameters["videoStartFrameNodeId"]; got != "img-1" {
		t.Fatalf("versioned-h3-lip videoStartFrameNodeId = %q, want img-1", got)
	}
	if got := byID["versioned-h3-2aud"].Metadata["videoEditOperation"]; got != "reference_to_video" {
		t.Fatalf("versioned-h3-2aud videoEditOperation = %v, want reference_to_video", got)
	}
	if got := byID["versioned-h3-2aud"].Parameters["videoStartFrameNodeId"]; got != "" {
		t.Fatalf("versioned-h3-2aud videoStartFrameNodeId = %q, want empty", got)
	}
	if got := byID["live-h3max-mid"].Metadata["videoEditOperation"]; got != "image_to_video" {
		t.Fatalf("live-h3max-mid videoEditOperation = %v, want image_to_video", got)
	}
	if got := byID["live-h3max-mid"].Parameters["videoMiddleFrameNodeId"]; got != "img-2" {
		t.Fatalf("live-h3max-mid videoMiddleFrameNodeId = %q, want img-2", got)
	}
	if got := byID["live-h3max-mid"].Metadata["videoMiddleFrameTime"]; got != 2.5 {
		t.Fatalf("live-h3max-mid videoMiddleFrameTime = %v, want 2.5", got)
	}
	if got := byID["omni-h3max-mid"].Metadata["videoEditOperation"]; got != "reference_to_video" {
		t.Fatalf("omni-h3max-mid videoEditOperation = %v, want reference_to_video", got)
	}
	if got := byID["omni-h3max-mid"].Parameters["videoMiddleFrameNodeId"]; got != "img-2" {
		t.Fatalf("omni-h3max-mid videoMiddleFrameNodeId = %q, want img-2", got)
	}
	if got := byID["omni-h3max-mid"].Metadata["videoMiddleFrameTime"]; got != 2.5 {
		t.Fatalf("omni-h3max-mid videoMiddleFrameTime = %v, want 2.5", got)
	}
	if got := byID["override-h3max-nomid"].Metadata["videoEditOperation"]; got != "image_to_video" {
		t.Fatalf("override-h3max-nomid videoEditOperation = %v, want image_to_video", got)
	}
	if got := byID["override-h3max-nomid"].Parameters["videoMiddleFrameNodeId"]; got != "" {
		t.Fatalf("override-h3max-nomid leaked videoMiddleFrameNodeId: %q", got)
	}
	if _, exists := byID["override-h3max-nomid"].Metadata["videoMiddleFrameTime"]; exists {
		t.Fatalf("override-h3max-nomid leaked videoMiddleFrameTime: %v", byID["override-h3max-nomid"].Metadata["videoMiddleFrameTime"])
	}
	if got := byID["opaque-custom-shot"].Metadata["videoEditOperation"]; got != "reference_to_video" {
		t.Fatalf("opaque-custom-shot videoEditOperation = %v, want reference_to_video", got)
	}
	if got := byID["opaque-custom-shot"].Parameters["videoMiddleFrameNodeId"]; got != "img-2" {
		t.Fatalf("opaque-custom-shot videoMiddleFrameNodeId = %q, want img-2", got)
	}
	if got := byID["opaque-custom-shot"].Metadata["videoMiddleFrameTime"]; got != 2.5 {
		t.Fatalf("opaque-custom-shot videoMiddleFrameTime = %v, want 2.5", got)
	}
	if got := byID["opaque-custom-shot"].Metadata["videoReferenceOrder"]; got == nil {
		t.Fatal("opaque-custom-shot lost videoReferenceOrder")
	}
	if got := byID["opaque-custom-shot"].Metadata["videoH3Options"]; got == nil {
		t.Fatal("opaque-custom-shot lost videoH3Options")
	}
	if got := byID["custom-h3max-shot"].Metadata["videoEditOperation"]; got != "reference_to_video" {
		t.Fatalf("custom-h3max-shot videoEditOperation = %v, want reference_to_video", got)
	}
	if got := byID["custom-h3max-shot"].Parameters["videoMiddleFrameNodeId"]; got != "" {
		t.Fatalf("custom-h3max-shot leaked videoMiddleFrameNodeId: %q", got)
	}
	if _, exists := byID["custom-h3max-shot"].Metadata["videoMiddleFrameTime"]; exists {
		t.Fatalf("custom-h3max-shot leaked videoMiddleFrameTime: %v", byID["custom-h3max-shot"].Metadata["videoMiddleFrameTime"])
	}
	if got := byID["custom-h3max-shot"].Metadata["videoReferenceOrder"]; got == nil {
		t.Fatal("custom-h3max-shot lost videoReferenceOrder")
	}
	if got := byID["custom-h3max-shot"].Metadata["videoH3Options"]; got == nil {
		t.Fatal("custom-h3max-shot lost videoH3Options")
	}
	if got := byID["custom-kling-shot"].Parameters["videoEndFrameNodeId"]; got != "img-2" {
		t.Fatalf("custom-kling-shot videoEndFrameNodeId = %q, want img-2", got)
	}
	if got := byID["custom-kling-shot"].Metadata["videoReferenceOrder"]; got != nil {
		t.Fatalf("custom-kling-shot leaked stale videoReferenceOrder: %#v", got)
	}
	if got := byID["custom-kling-shot"].Metadata["videoH3Options"]; got != nil {
		t.Fatalf("custom-kling-shot leaked stale videoH3Options: %#v", got)
	}
	if got := byID["partial-opref-h3"].Metadata["videoEditOperation"]; got != "image_to_video" {
		t.Fatalf("partial-opref-h3 videoEditOperation = %v, want image_to_video", got)
	}
	if got := byID["empty-opref-h3"].Metadata["videoEditOperation"]; got != "image_to_video" {
		t.Fatalf("empty-opref-h3 videoEditOperation = %v, want image_to_video", got)
	}
	if got := byID["stale-removed-h3"].Parameters["videoMiddleFrameNodeId"]; got != "img-2" {
		t.Fatalf("stale-removed-h3 treated as declared or contracted model: %q", got)
	}
	if got := byID["unqualified-kling-shot"].Parameters["videoEndFrameNodeId"]; got != "img-2" {
		t.Fatalf("unqualified-kling-shot matched managed catalog without channel prefix: %q", got)
	}
	if got := byID["unqualified-h3max-shot"].Metadata["videoEditOperation"]; got != "image_to_video" {
		t.Fatalf("unqualified-h3max-shot matched managed catalog without channel prefix: %v", got)
	}
	if got := byID["unqualified-h3max-shot"].Parameters["videoMiddleFrameNodeId"]; got != "img-2" {
		t.Fatalf("unqualified-h3max-shot stripped middle frame as declared model: %q", got)
	}
	if _, err := GenerationTargets(probe, doc, []string{"frame9-over-limit"}); err == nil || !strings.Contains(err.Error(), "最多支持 2 张首尾帧参考图") {
		t.Fatalf("frame9-over-limit expected frame image limit error, got %v", err)
	}
}
