package modelcatalog

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestSeedance2FamilyIdentifiesRouteByProtocolAndModel(t *testing.T) {
	cases := []struct {
		protocol, model string
		family, native  bool
		is25            bool
	}{
		{"volcengine-ark-video", "doubao-seedance-2-0-pro-260128", true, false, false},
		{"volcengine-ark-video", "doubao-seedance-2-0-fast-260128", true, false, false},
		{"volcengine-ark-video", "dreamina-seedance-2-0-pro", true, true, false},
		{"volcengine-ark-video", "bytedance/dreamina-seedance-2-5-flash", true, true, true},
		{"volcengine-ark-agent-plan-video", "dreamina-seedance-2.5", true, true, true},
		{"newapi-channel-2", "seedance-2.5-pro", true, false, true},
		{"newapi", "doubao-seedance-2-0", true, false, false},
		{"openai", "seedance-2-0-fast", true, false, false},
		{"openai-videos", "SEEDANCE-2-0", true, false, false},
		{"volcengine-ark-video", "doubao-seedance-1-5-pro", false, false, false},
		{"minimax-video", "seedance-2-0", false, false, false},
		{"openai-image", "seedance-2-0", false, false, false},
		{"", "seedance-2-0", false, false, false},
		{"openai", "dreamina-seedance-2-0", true, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.protocol+"/"+tc.model, func(t *testing.T) {
			if got := IsSeedance2Family(tc.protocol, tc.model); got != tc.family {
				t.Errorf("IsSeedance2Family = %v, want %v", got, tc.family)
			}
			if got := isNativeDreaminaSeedance(tc.protocol, tc.model); got != tc.native {
				t.Errorf("isNativeDreaminaSeedance = %v, want %v", got, tc.native)
			}
			if got := IsSeedance25Model(tc.model); got != tc.is25 {
				t.Errorf("IsSeedance25Model = %v, want %v", got, tc.is25)
			}
		})
	}
}

func TestSeedanceDefaultCapabilityFollowsDocumentedLimits(t *testing.T) {
	cases := []struct {
		name, protocol, model                   string
		maxImages, maxVideos, maxAudios, maxDur int
		audioToVideo                            bool
	}{
		{"2.0 Pro", "volcengine-ark-video", "doubao-seedance-2-0-pro", 9, 3, 3, 15, false},
		{"2.0 Flash", "newapi-channel-2", "seedance-2-0-fast", 9, 3, 3, 15, false},
		{"2.5", "volcengine-ark-video", "doubao-seedance-2-5-pro", 30, 10, 10, 30, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			video := DefaultModelCapabilityConfigForModel(tc.protocol, tc.model).Video
			refs := video.References
			if refs.MaxImages != tc.maxImages || refs.MaxVideos != tc.maxVideos || refs.MaxAudios != tc.maxAudios {
				t.Fatalf("reference counts = %d/%d/%d", refs.MaxImages, refs.MaxVideos, refs.MaxAudios)
			}
			if refs.MaxVideoDuration != tc.maxDur || refs.MaxAudioDuration != tc.maxDur {
				t.Fatalf("reference max duration = %d/%d, want %d", refs.MaxVideoDuration, refs.MaxAudioDuration, tc.maxDur)
			}
			if refs.MinVideoDuration != 2 || refs.MinAudioDuration != 2 {
				t.Fatalf("reference min duration = %v/%v, want 2/2", refs.MinVideoDuration, refs.MinAudioDuration)
			}
			if video.Duration.Min < 4 || (video.Duration.Selection == "range" && video.Duration.Default < 4) {
				t.Fatalf("output duration lower bound = %+v", video.Duration)
			}
			if got := slices.Contains(video.Operations, "audio_to_video"); got != tc.audioToVideo {
				t.Fatalf("audio_to_video = %v, want %v", got, tc.audioToVideo)
			}
			if !slices.Contains(video.Operations, "reference_to_video") {
				t.Fatalf("operations = %v", video.Operations)
			}
		})
	}
}

func seedanceVideoTaskInput(protocol, modelName, seconds string) TaskInput {
	return TaskInput{Config: TaskConfig{InterfaceType: protocol, Model: modelName, VideoSeconds: seconds}}
}

func TestSeedanceSavedDurationLowerBoundTightensTo4Seconds(t *testing.T) {
	const arkPro = "doubao-seedance-2-0-pro"
	rangeProfile := func(min, def int) *VideoCapabilityConfig {
		v := DefaultModelCapabilityConfigForModel("volcengine-ark-video", arkPro).Video
		v.Duration = VideoDurationConfig{Selection: "range", Min: min, Max: 15, Step: 1, Default: def}
		return v
	}
	enumProfile := func(values ...int) *VideoCapabilityConfig {
		v := DefaultModelCapabilityConfigForModel("volcengine-ark-video", arkPro).Video
		v.Duration = VideoDurationConfig{Selection: "enum", Values: values, Default: values[0]}
		return v
	}
	cases := []struct {
		name    string
		profile *VideoCapabilityConfig
		seconds string
		wantErr bool
	}{
		{"saved min 1 rejects 3s", rangeProfile(1, 1), "3", true},
		{"saved min 1 accepts 4s", rangeProfile(1, 1), "4", false},
		{"saved min 2 rejects 2s", rangeProfile(2, 5), "2", true},
		{"stricter saved min 6 is kept", rangeProfile(6, 6), "5", true},
		{"enum drops values below 4", enumProfile(1, 2, 5, 10), "2", true},
		{"enum keeps values from 4", enumProfile(1, 2, 5, 10), "5", false},
		{"enum without any legal value rejects", enumProfile(1, 2, 3), "3", true},
		{"enum with automatic still rejects explicit 2s", enumProfile(-1, 2, 8), "2", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateVideoTaskParameters(tc.profile, seedanceVideoTaskInput("volcengine-ark-video", arkPro, tc.seconds))
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}

	t.Run("non-Seedance model keeps saved lower bound", func(t *testing.T) {
		v := DefaultModelCapabilityConfigForModel("volcengine-ark-video", "doubao-seedance-1-5-pro").Video
		v.Duration = VideoDurationConfig{Selection: "range", Min: 1, Max: 12, Step: 1, Default: 5}
		if err := ValidateVideoTaskParameters(v, seedanceVideoTaskInput("volcengine-ark-video", "doubao-seedance-1-5-pro", "2")); err != nil {
			t.Fatal(err)
		}
	})
}

func TestTightenSeedanceOutputDurationKeepsAutomaticAndRepairsDefault(t *testing.T) {
	enum := VideoDurationConfig{Selection: "enum", Values: []int{-1, 1, 5}, Default: 1}
	tightenSeedanceOutputDuration(&enum)
	if !slices.Equal(enum.Values, []int{-1, 5}) || enum.Default != 5 {
		t.Fatalf("enum = %+v", enum)
	}
	onlyAuto := VideoDurationConfig{Selection: "enum", Values: []int{-1, 2}, Default: 2}
	tightenSeedanceOutputDuration(&onlyAuto)
	if !slices.Equal(onlyAuto.Values, []int{-1}) {
		t.Fatalf("onlyAuto = %+v", onlyAuto)
	}
	continuous := VideoDurationConfig{Selection: "range", Continuous: true, FractionalMin: 1.5, Min: 1, Max: 15, Default: 2}
	tightenSeedanceOutputDuration(&continuous)
	if continuous.FractionalMin != 4 || continuous.Min != 4 || continuous.Default != 4 {
		t.Fatalf("continuous = %+v", continuous)
	}
}

func TestSeedanceReferenceMinimumsAndRouteIdentification(t *testing.T) {
	const arkPro = "doubao-seedance-2-0-pro"
	profile := func(protocol, modelName string) *VideoCapabilityConfig {
		return DefaultModelCapabilityConfigForModel(protocol, modelName).Video
	}
	input := func(protocol, modelName string) TaskInput {
		return seedanceVideoTaskInput(protocol, modelName, "5")
	}
	t.Run("audio shorter than 2s is rejected even when saved config allows it", func(t *testing.T) {
		p := profile("volcengine-ark-video", arkPro)
		p.References.MinAudioDuration = 1
		in := input("volcengine-ark-video", arkPro)
		in.ReferenceImages = []MediaRef{{URL: "https://example.com/a.png", Width: 800, Height: 800}}
		in.ReferenceAudios = []MediaRef{{URL: "https://example.com/a.mp3", DurationMs: 1800}}
		if err := ValidateVideoReferenceMedia(p, in); err == nil || !strings.Contains(err.Error(), "音频") {
			t.Fatalf("err = %v", err)
		}
		in.ReferenceAudios[0].DurationMs = 2000
		if err := ValidateVideoReferenceMedia(p, in); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("non-Seedance route keeps saved audio minimum", func(t *testing.T) {
		p := profile("volcengine-ark-video", "doubao-seedance-1-5-pro")
		p.References.MaxAudios = 3
		p.References.MaxAudioDuration = 15
		p.References.MinAudioDuration = 1
		in := input("volcengine-ark-video", "doubao-seedance-1-5-pro")
		in.ReferenceImages = []MediaRef{{URL: "https://example.com/a.png"}}
		in.ReferenceAudios = []MediaRef{{URL: "https://example.com/a.mp3", DurationMs: 1800}}
		if err := ValidateVideoReferenceMedia(p, in); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("reference video under 2s is rejected", func(t *testing.T) {
		p := profile("volcengine-ark-video", arkPro)
		in := input("volcengine-ark-video", arkPro)
		in.ReferenceVideos = []MediaRef{{URL: "https://example.com/a.mp4", DurationMs: 1500, Width: 1280, Height: 720}}
		if err := ValidateVideoReferenceMedia(p, in); err == nil {
			t.Fatal("expected rejection")
		}
		in.ReferenceVideos[0].DurationMs = 2000
		if err := ValidateVideoReferenceMedia(p, in); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("image count follows 2.0 and 2.5 limits", func(t *testing.T) {
		for _, tc := range []struct {
			model string
			count int
			ok    bool
		}{{arkPro, 9, true}, {arkPro, 10, false}, {"doubao-seedance-2-5-pro", 30, true}, {"doubao-seedance-2-5-pro", 31, false}} {
			in := input("volcengine-ark-video", tc.model)
			for i := 0; i < tc.count; i++ {
				in.ReferenceImages = append(in.ReferenceImages, MediaRef{URL: "https://example.com/a.png"})
			}
			err := ValidateVideoReferenceMedia(profile("volcengine-ark-video", tc.model), in)
			if (err == nil) != tc.ok {
				t.Errorf("%s x%d: err = %v", tc.model, tc.count, err)
			}
		}
	})
	t.Run("pixel floor drops to documented value only on ark or material-library hosts", func(t *testing.T) {
		pixels := func(protocol, baseURL string) int64 {
			refs := profile(protocol, arkPro).References
			ApplySeedanceDocumentedVideoPixelFloor(TaskConfig{InterfaceType: protocol, Model: arkPro, BaseURL: baseURL}, &refs)
			return int64(refs.MinVideoPixels)
		}
		if got := pixels("volcengine-ark-video", ""); got != documentedSeedanceVideoMinPixels {
			t.Errorf("ark = %d", got)
		}
		if got := pixels("newapi-channel-2", "https://beefapi.com/v1"); got != documentedSeedanceVideoMinPixels {
			t.Errorf("material host = %d", got)
		}
		if got := pixels("newapi-channel-2", "https://relay.example.com/v1"); got != OfficialSeedanceVideoMinPixels {
			t.Errorf("custom host = %d", got)
		}
	})
	t.Run("inpaint on native 2.5 needs a 4s reference video", func(t *testing.T) {
		const native25 = "dreamina-seedance-2-5-pro"
		p := profile("volcengine-ark-video", native25)
		in := input("volcengine-ark-video", native25)
		in.Metadata = map[string]any{"videoEditOperation": "inpaint"}
		in.ReferenceVideos = []MediaRef{{URL: "https://example.com/a.mp4", DurationMs: 3000, Width: 1280, Height: 720}}
		if err := ValidateVideoReferenceMedia(p, in); err == nil {
			t.Fatal("expected rejection under 4s")
		}
		in.ReferenceVideos[0].DurationMs = 4000
		if err := ValidateVideoReferenceMedia(p, in); err != nil {
			t.Fatal(err)
		}
	})
}

func TestSeedanceProFlashResolutionAndReferenceRolesTable(t *testing.T) {
	cases := []struct {
		name              string
		protocol          string
		model             string
		baseURL           string
		channelID         string
		saved             *ModelCapabilityConfig
		wantResolutions   []string
		wantDefaultRes    string
		wantMinDuration   int
		wantMinAudioDur   float64
		wantMinVideoPixel int64
		wantMaxImages     int
		wantMaxVideos     int
		wantMaxAudios     int
		wantTaskTypeConst bool
	}{
		{
			name:              "2.0 Pro default resolutions include 1080p",
			protocol:          "volcengine-ark-video",
			model:             "doubao-seedance-2-0-pro-260128",
			wantResolutions:   []string{"480p", "720p", "1080p"},
			wantDefaultRes:    "720p",
			wantMinDuration:   4,
			wantMinAudioDur:   2,
			wantMinVideoPixel: documentedSeedanceVideoMinPixels,
			wantMaxImages:     9,
			wantMaxVideos:     3,
			wantMaxAudios:     3,
			wantTaskTypeConst: false,
		},
		{
			name:              "2.0 Fast/Flash resolutions cap at 720p on volcengine-ark-video",
			protocol:          "volcengine-ark-video",
			model:             "dreamina-seedance-2-0-fast-260128",
			wantResolutions:   []string{"480p", "720p"},
			wantDefaultRes:    "720p",
			wantMinDuration:   4,
			wantMinAudioDur:   2,
			wantMinVideoPixel: documentedSeedanceVideoMinPixels,
			wantMaxImages:     9,
			wantMaxVideos:     3,
			wantMaxAudios:     3,
			wantTaskTypeConst: false,
		},
		{
			name:              "2.5 Flash on custom host keeps official pixel floor and sets taskTypeConstraints",
			protocol:          "newapi-channel-2",
			model:             "bytedance/dreamina-seedance-2-5-flash",
			baseURL:           "https://relay.example.com/v1",
			wantResolutions:   []string{"480p", "720p", "1080p", "1440p", "2160p"},
			wantDefaultRes:    "720p",
			wantMinDuration:   4,
			wantMinAudioDur:   2,
			wantMinVideoPixel: OfficialSeedanceVideoMinPixels,
			wantMaxImages:     30,
			wantMaxVideos:     10,
			wantMaxAudios:     10,
			wantTaskTypeConst: true,
		},
		{
			name:      "saved draft with 1s duration and 1s audio is tightened to documented floors",
			protocol:  "newapi-channel-2",
			model:     "seedance-2.0",
			baseURL:   "https://relay.example.com/v1",
			saved: &ModelCapabilityConfig{
				Version: 1,
				Video: &VideoCapabilityConfig{
					Operations:        []string{"text_to_video", "reference_to_video"},
					DefaultOperation:  "text_to_video",
					Duration:          VideoDurationConfig{Selection: "range", Min: 1, Max: 15, Step: 1, Default: 1},
					Ratios:            []string{"16:9"},
					DefaultRatio:      "16:9",
					Resolutions:       []string{"720p"},
					DefaultResolution: "720p",
					References: VideoReferenceConfig{
						MaxImages:        9,
						MaxVideos:        3,
						MaxAudios:        3,
						MinVideoDuration: 1,
						MaxVideoDuration: 15,
						MinAudioDuration: 1,
						MaxAudioDuration: 15,
						MinVideoPixels:   500000,
					},
				},
			},
			wantResolutions:   []string{"720p"},
			wantDefaultRes:    "720p",
			wantMinDuration:   4,
			wantMinAudioDur:   2,
			wantMinVideoPixel: 500000,
			wantMaxImages:     9,
			wantMaxVideos:     3,
			wantMaxAudios:     3,
			wantTaskTypeConst: false,
		},
		{
			name:      "legacy zero-reference BeefAPI profile repairs omni reference slots",
			protocol:  "newapi-channel-2",
			model:     "doubao-seedance-2-0-260128",
			channelID: "beefapi",
			saved: &ModelCapabilityConfig{
				Version: 1,
				Video: &VideoCapabilityConfig{
					Operations:        []string{"text_to_video", "image_to_video"},
					DefaultOperation:  "text_to_video",
					Duration:          VideoDurationConfig{Selection: "range", Min: 4, Max: 15, Step: 1, Default: 5},
					Ratios:            []string{"16:9"},
					DefaultRatio:      "16:9",
					Resolutions:       []string{"720p"},
					DefaultResolution: "720p",
					References:        VideoReferenceConfig{MaxImages: 0, MaxVideos: 0, MaxAudios: 0},
				},
			},
			wantResolutions:   []string{"720p"},
			wantDefaultRes:    "720p",
			wantMinDuration:   4,
			wantMinAudioDur:   2,
			wantMinVideoPixel: documentedSeedanceVideoMinPixels,
			wantMaxImages:     9,
			wantMaxVideos:     3,
			wantMaxAudios:     3,
			wantTaskTypeConst: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeModelCapabilityDraft(ModelCapabilityDraft{
				Capability:       "video",
				Protocol:         tc.protocol,
				Model:            tc.model,
				BaseURL:          tc.baseURL,
				ChannelID:        tc.channelID,
				CapabilityConfig: tc.saved,
			})
			if err != nil {
				t.Fatalf("NormalizeModelCapabilityDraft() error = %v", err)
			}
			if got == nil || got.Video == nil {
				t.Fatalf("expected normalized video capability, got %#v", got)
			}
			video := got.Video
			if !slices.Equal(video.Resolutions, tc.wantResolutions) || video.DefaultResolution != tc.wantDefaultRes {
				t.Fatalf("resolutions = %v (default %q), want %v (default %q)", video.Resolutions, video.DefaultResolution, tc.wantResolutions, tc.wantDefaultRes)
			}
			if video.Duration.Min != tc.wantMinDuration || video.Duration.Default < tc.wantMinDuration {
				t.Fatalf("duration = %+v, want min %d", video.Duration, tc.wantMinDuration)
			}
			if video.References.MinAudioDuration != tc.wantMinAudioDur {
				t.Fatalf("minAudioDuration = %v, want %v", video.References.MinAudioDuration, tc.wantMinAudioDur)
			}
			if video.References.MinVideoPixels != tc.wantMinVideoPixel {
				t.Fatalf("minVideoPixels = %d, want %d", video.References.MinVideoPixels, tc.wantMinVideoPixel)
			}
			if video.References.MaxImages != tc.wantMaxImages || video.References.MaxVideos != tc.wantMaxVideos || video.References.MaxAudios != tc.wantMaxAudios {
				t.Fatalf("reference counts = %d/%d/%d, want %d/%d/%d",
					video.References.MaxImages, video.References.MaxVideos, video.References.MaxAudios,
					tc.wantMaxImages, tc.wantMaxVideos, tc.wantMaxAudios)
			}
			if video.TaskTypeConstraints != tc.wantTaskTypeConst {
				t.Fatalf("taskTypeConstraints = %v, want %v", video.TaskTypeConstraints, tc.wantTaskTypeConst)
			}
		})
	}
}

func TestSeedance25DraftAndDraftToFinalCapabilityAndValidation(t *testing.T) {
	video := DefaultModelCapabilityConfigForModel("volcengine-ark-video", "doubao-seedance-2-5-260628").Video
	if !video.Draft.Supported || video.Draft.Default {
		t.Fatalf("expected Seedance 2.5 draft supported=true default=false, got %+v", video.Draft)
	}
	if !slices.Contains(video.Operations, "draft_to_final") {
		t.Fatalf("expected Seedance 2.5 operations to include draft_to_final, got %v", video.Operations)
	}
	if !slices.Contains(video.Operations, "inpaint") || !slices.Contains(video.Operations, "extend") {
		t.Fatalf("expected domestic Seedance 2.5 on volcengine-ark-video to support inpaint/extend, got %v", video.Operations)
	}

	// Valid draft_to_final request
	validInput := TaskInput{
		Config: TaskConfig{
			InterfaceType: "volcengine-ark-video",
			Model:         "doubao-seedance-2-5-260628",
			VQuality:      "1080p",
		},
		Metadata: map[string]any{
			"videoEditOperation": "draft_to_final",
			"videoDraftTaskId":   "cgt-draft-123",
		},
	}
	if err := ValidateVideoTaskParameters(video, validInput); err != nil {
		t.Fatalf("expected valid draft_to_final parameters, got %v", err)
	}
	if err := ValidateVideoReferenceMedia(video, validInput); err != nil {
		t.Fatalf("expected valid draft_to_final reference media, got %v", err)
	}

	// Reject 480p for draft_to_final
	invalid480 := validInput
	invalid480.Config.VQuality = "480p"
	if err := ValidateVideoTaskParameters(video, invalid480); err == nil {
		t.Fatal("expected 480p draft_to_final to be rejected")
	}

	// Reject missing videoDraftTaskId
	missingID := validInput
	missingID.Metadata = map[string]any{"videoEditOperation": "draft_to_final"}
	if err := ValidateVideoTaskParameters(video, missingID); err == nil {
		t.Fatal("expected missing videoDraftTaskId to be rejected")
	}

	rawCap, err := json.Marshal(video)
	if err != nil {
		t.Fatal(err)
	}
	normalized, ok := NormalizeCatalogVideoCapability(rawCap)
	if !ok {
		t.Fatal("expected NormalizeCatalogVideoCapability to accept Seedance 2.5 video capability")
	}
	if _, hasDraft := normalized["draft"]; !hasDraft {
		t.Fatalf("expected NormalizeCatalogVideoCapability to preserve draft, got %+v", normalized)
	}
	if _, hasLastFrame := normalized["returnLastFrame"]; !hasLastFrame {
		t.Fatalf("expected NormalizeCatalogVideoCapability to preserve returnLastFrame, got %+v", normalized)
	}

	legacy25 := &ModelCapabilityConfig{
		Version: 1,
		Video: &VideoCapabilityConfig{
			Operations:        []string{"text_to_video", "image_to_video"},
			DefaultOperation:  "text_to_video",
			Duration:          VideoDurationConfig{Selection: "range", Min: 4, Max: 15, Step: 1, Default: 5},
			Ratios:            []string{"16:9"},
			DefaultRatio:      "16:9",
			Resolutions:       []string{"720p", "1080p"},
			DefaultResolution: "720p",
			References: VideoReferenceConfig{
				MaxImages:     9,
				MaxVideos:     0,
				MaxAudios:     0,
				MaxVideoBytes: 200 * 1024 * 1024,
				MaxAudioBytes: 15 * 1024 * 1024,
			},
		},
	}
	repaired, err := NormalizeModelCapabilityDraft(ModelCapabilityDraft{
		Capability:       "video",
		Protocol:         "newapi",
		Model:            "seedance-2.5",
		ChannelID:        "beefapi",
		CapabilityConfig: legacy25,
	})
	if err != nil {
		t.Fatalf("NormalizeModelCapabilityDraft on legacy seedance-2.5 failed: %v", err)
	}
	if !repaired.Video.Draft.Supported || !repaired.Video.ReturnLastFrame.Supported || !slices.Equal(repaired.Video.Resolutions, []string{"720p", "1080p", "480p"}) || !slices.Contains(repaired.Video.Operations, "draft_to_final") {
		t.Fatalf("expected NormalizeModelCapabilityDraft on seedance-2.5 to restore draft, returnLastFrame, draft_to_final, and 720p/1080p/480p, got %+v", repaired.Video)
	}
	legacyCustom := repairLegacyEnterpriseSeedanceVideoProfile("newapi", "seedance-2.5-custom", legacy25)
	if !legacyCustom.Video.Draft.Supported || !legacyCustom.Video.ReturnLastFrame.Supported || !slices.Equal(legacyCustom.Video.Resolutions, []string{"720p", "1080p", "480p"}) || !slices.Contains(legacyCustom.Video.Operations, "draft_to_final") {
		t.Fatalf("expected legacy custom seedance-2.5 repair to restore draft, returnLastFrame, draft_to_final, and only 480p without 1440p/2160p, got %+v", legacyCustom.Video)
	}
	nonZeroRefs := *legacy25
	nonZeroVideo := *legacy25.Video
	nonZeroVideo.References.MaxVideos = 3
	nonZeroRefs.Video = &nonZeroVideo
	repairedNonZero, err := NormalizeModelCapabilityDraft(ModelCapabilityDraft{
		Capability:       "video",
		Protocol:         "newapi",
		Model:            "seedance-2.5",
		ChannelID:        "beefapi",
		CapabilityConfig: &nonZeroRefs,
	})
	if err != nil {
		t.Fatalf("NormalizeModelCapabilityDraft on non-zero-refs seedance-2.5 failed: %v", err)
	}
	if !repairedNonZero.Video.Draft.Supported || !repairedNonZero.Video.ReturnLastFrame.Supported || !slices.Contains(repairedNonZero.Video.Resolutions, "480p") || !slices.Contains(repairedNonZero.Video.Operations, "draft_to_final") {
		t.Fatalf("expected non-zero-refs seedance-2.5 to restore draft, returnLastFrame, 480p, and draft_to_final, got %+v", repairedNonZero.Video)
	}
}

func TestSeedance25VendorNeutralBYOKProtocolsExposeBusinessActions(t *testing.T) {
	protocols := []string{
		"volcengine-ark-video",
		"volcengine-ark-agent-plan-video",
		"newapi",
		"openai-videos",
		"newapi-channel-1",
		"newapi-channel-2",
		"video-generations-json",
		"seedance-videos-compatible",
		"full-video",
	}
	for _, proto := range protocols {
		t.Run(proto, func(t *testing.T) {
			video := DefaultModelCapabilityConfigForModel(proto, "seedance-2.5").Video
			if !video.Draft.Supported || !video.ReturnLastFrame.Supported {
				t.Fatalf("%s draft=%+v returnLastFrame=%+v", proto, video.Draft, video.ReturnLastFrame)
			}
			for _, op := range []string{"reference_to_video", "audio_to_video", "draft_to_final", "inpaint", "extend"} {
				if !slices.Contains(video.Operations, op) {
					t.Fatalf("%s missing operation %q in %v", proto, op, video.Operations)
				}
			}
			if !slices.Contains(video.Ratios, "adaptive") {
				t.Fatalf("%s missing adaptive ratio in %v", proto, video.Ratios)
			}
		})
	}
}
