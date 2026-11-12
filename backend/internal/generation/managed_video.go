package generation

import (
	"context"
	"errors"
	"strings"

	"qisitv/backend/internal/beeftv"
)

func managedLegacyVideoInput(input Input) beeftv.LegacyVideoInput {
	resolution := videoResolutionNameRequest(input.VideoCapability, input.Config.VQuality)
	if input.VideoCapability == nil && !isAutomaticVideoResolution(input.Config.VQuality) {
		resolution = NormalizeVideoResolution(input.Config.VQuality)
	}
	request := beeftv.LegacyVideoInput{Model: input.Config.Model, Prompt: WithSystemPrompt(input.Config, strings.TrimSpace(input.Prompt)), Seconds: input.Config.VideoSeconds, Resolution: resolution, AspectRatio: input.Config.Size, Metadata: input.Metadata}
	serverOwned := input.Config.VideoCapabilitiesVersion != nil && strings.TrimSpace(*input.Config.VideoCapabilitiesVersion) != "" && input.VideoCapability != nil
	if serverOwned {
		if input.VideoCapability.DurationSupported != nil && !*input.VideoCapability.DurationSupported {
			request.Seconds = ""
		}
		if len(input.VideoCapability.Ratios) == 0 {
			request.AspectRatio = ""
		}
		if len(input.VideoCapability.Resolutions) == 0 {
			request.Resolution = ""
		}
	}
	if input.Config.VideoGenerateAudio != "" && (!serverOwned || input.VideoCapability.GenerateAudio.Supported) {
		value := ParseBool(input.Config.VideoGenerateAudio, true)
		request.GenerateAudio = &value
	}
	if input.Config.VideoWatermark != "" && (!serverOwned || input.VideoCapability.Watermark.Supported) {
		value := ParseBool(input.Config.VideoWatermark, false)
		request.Watermark = &value
	}
	if VideoRequestsReturnLastFrame(input) && (!serverOwned || input.VideoCapability.ReturnLastFrame.Supported) {
		value := true
		request.ReturnLastFrame = &value
	}
	if draftTaskID := metadataString(input.Metadata, "videoDraftTaskId"); draftTaskID != "" {
		request.DraftTaskID = draftTaskID
		request.Draft = nil
		request.Prompt = ""
		request.Seconds = ""
		request.AspectRatio = ""
		request.GenerateAudio = nil
		return request
	}
	if ParseBool(input.Config.VideoDraft, false) && (!serverOwned || input.VideoCapability.Draft.Supported) {
		value := true
		request.Draft = &value
		request.Resolution = "480p"
	}
	for _, group := range BeefTVSeedanceMediaGroups(&input) {
		for _, media := range group.items {
			request.References = append(request.References, beeftv.LegacyVideoReference{ID: media.ID, Kind: group.kind, URL: firstNonEmpty(media.URL, media.DataURL)})
		}
	}
	return request
}

func runManagedLegacyVideo(ctx context.Context, input Input, policy VideoPollPolicy) (map[string]any, error) {
	id := ResumedProviderRequestID(ctx)
	if id == "" {
		if SubmissionKeyFromContext(ctx) == "" {
			return nil, RequestPreparationError{Cause: errors.New("视频任务缺少持久化提交编号")}
		}
		createCtx := WithRequestKind(ctx, "create")
		var err error
		id, err = managedMediaClient(createCtx, input.Config).CreateLegacyVideo(createCtx, SubmissionKeyFromContext(ctx), managedLegacyVideoInput(input))
		if err != nil {
			if errors.Is(err, beeftv.ErrReferencesNotUploaded) || errors.Is(err, beeftv.ErrInvalidVideoReferences) {
				return nil, RequestPreparationError{Cause: err}
			}
			return nil, SubmissionUnknownError{Cause: legacyMediaError(err)}
		}
	}
	return RunVideoPollLoop(ctx, id, policy, func(ctx context.Context) (VideoPollOutcome, error) {
		result, _, _, err := queryManagedLegacyVideoWithPolicy(ctx, input, id, policy)
		return VideoPollOutcome{Done: result != nil, Result: result}, err
	})
}
