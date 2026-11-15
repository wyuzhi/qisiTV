package generation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/model"
)

func SubtitleEraseTaskInput(ctx context.Context, user string, request SubtitleEraseRequest, ensureMetadata func(context.Context, string, string) (*model.Resource, error), lookupCred func() (string, string, string, string, error)) (Input, *model.Resource, error) {
	var input Input
	if strings.TrimSpace(request.ResourceID) == "" || (request.ChannelID != "" && request.ChannelID != "beeftv") {
		return input, nil, BadAuthRequest("请选择视频素材与官方算力")
	}
	opts, err := normalizeSmartEraseOptions(requestToOptions(request))
	if err != nil {
		return input, nil, BadAuthRequest(err.Error())
	}
	resource, err := ensureMetadata(ctx, user, request.ResourceID)
	if err != nil || resource == nil || resource.Status != model.ResourceStatusReady {
		return input, nil, BadAuthRequest("输入视频不存在或未就绪")
	}
	if localasset.NormalizeKind(resource.Kind, resource.MimeType) != "video" {
		return input, nil, BadAuthRequest("视频智能擦除仅支持视频素材")
	}
	targetModel := smartEraseModelForOptions(opts)
	config, err := UpscaleConfig(targetModel, lookupCred)
	if err != nil {
		return input, nil, err
	}
	prompt, _ := smartErasePromptAndStage(&opts, targetModel)
	input = Input{
		Mode:          "video",
		Prompt:        prompt,
		Config:        config,
		SubtitleErase: &opts,
		ReferenceVideos: []Media{{
			StorageKey: "resource:" + resource.ID,
			MimeType:   resource.MimeType,
			Width:      resource.Width,
			Height:     resource.Height,
			DurationMs: resource.DurationMs,
		}},
	}
	return input, resource, nil
}

func prepareOwnedSubtitleEraseSource(ctx context.Context, input Input) (Input, error) {
	input.ReferenceVideos = append([]Media(nil), input.ReferenceVideos...)
	if err := ValidateSubtitleEraseInput(input); err != nil {
		return input, err
	}
	label := resolveSmartEraseSpec(input.SubtitleErase, input.Config.Model).Prompt
	if !managedConnection(input.Config) && !IsBeefTVVideoConfig(ctx, input.Config) {
		return input, fmt.Errorf("%s需要连接官方算力账号", label)
	}
	runtime, _ := RuntimeFromContext(ctx)
	if err := HydrateMedia(ctx, runtime.Call.UserID, &input, MediaHydrationPolicy{KeepLocal: true}); err != nil {
		return input, err
	}
	if len(input.ReferenceVideos) == 0 || input.ReferenceVideos[0].StorageKey == "" {
		return input, errors.New("请先将视频导入素材库，再开始处理")
	}
	data, _, skip, err := ownedSeedanceMediaReader(ctx, runtime.Call.UserID)("video", input.ReferenceVideos[0])
	if err != nil {
		return input, err
	}
	if skip {
		return input, errors.New("视频素材未通过素材库归属校验")
	}
	if len(data) == 0 {
		return input, errors.New("视频素材内容为空")
	}
	deliveryLimit, err := GeneratedFileLimit(ctx)
	if err != nil {
		return input, err
	}
	if int64(len(data)) > deliveryLimit {
		return input, fmt.Errorf("视频大小超过本机单个生成资源上限 %s，请调高资源上限后重试", formatStorageLimit(deliveryLimit))
	}
	return input, nil
}

func PrepareSubtitleErase(ctx context.Context, input Input) (Input, error) {
	input, err := prepareOwnedSubtitleEraseSource(ctx, input)
	if err != nil {
		return input, err
	}
	runtime, _ := RuntimeFromContext(ctx)
	if err := PrepareBeefTVVideoReferences(ctx, input.Config, &input, ownedSeedanceMediaReader(ctx, runtime.Call.UserID)); err != nil {
		return input, err
	}
	return input, nil
}

func subtitleEraseInputFromPrepared(input Input) beeftv.SubtitleEraseInput {
	req := beeftv.SubtitleEraseInput{Model: input.Config.Model}
	if input.SubtitleErase != nil {
		opts := *input.SubtitleErase
		if normalized, err := normalizeSmartEraseOptions(opts); err == nil {
			opts = normalized
		}
		req.EraseType = opts.EraseType
		req.EraseMethod = opts.EraseMethod
		req.SubtitleModel = opts.SubtitleModel
		req.WatermarkModel = opts.WatermarkModel
		req.PrivacyModel = opts.PrivacyModel
		req.PrivacyTargets = append([]string(nil), opts.PrivacyTargets...)
		req.Region = toBeefTVSubtitleRegion(opts.Region)
		req.OCRExtract = opts.OCRExtract
		req.SubtitleLang = opts.SubtitleLang
		req.SubtitleFormat = opts.SubtitleFormat
		req.Translate = opts.Translate
		req.TranslateDstLang = opts.TranslateDstLang
		req.SubtitleEmbedID = opts.SubtitleEmbedID
		req.UseOriginalPos = opts.UseOriginalPos
		req.UseOriginalSize = opts.UseOriginalSize
	}
	if len(input.ReferenceVideos) > 0 {
		v := input.ReferenceVideos[0]
		req.SourceURL = v.URL
		req.Width, req.Height = v.Width, v.Height
		if v.DurationMs > 0 {
			req.DurationSeconds = float64(v.DurationMs) / 1000.0
		}
	}
	return req
}

func EstimateVideoSubtitleErase(ctx context.Context, user string, request SubtitleEraseRequest, ensureMetadata func(context.Context, string, string) (*model.Resource, error), lookupCred func() (string, string, string, string, error), bindRuntime func(context.Context, CallMeta) context.Context) (map[string]any, error) {
	input, resource, err := SubtitleEraseTaskInput(ctx, user, request, ensureMetadata, lookupCred)
	if err != nil {
		return nil, err
	}
	if bindRuntime != nil {
		ctx = bindRuntime(ctx, CallMeta{UserID: user, RequestKind: "estimate"})
	}
	var req beeftv.SubtitleEraseInput
	if resource.Width > 0 && resource.Height > 0 && resource.DurationMs > 0 {
		prepared, prepErr := prepareOwnedSubtitleEraseSource(ctx, input)
		if prepErr != nil {
			return nil, BadAuthRequest(ClassifyError(RequestPreparationError{Cause: prepErr}).UserMessage())
		}
		req = subtitleEraseInputFromPrepared(prepared)
	} else {
		prepared, prepErr := PrepareSubtitleErase(ctx, input)
		if prepErr != nil {
			return nil, BadAuthRequest(ClassifyError(RequestPreparationError{Cause: prepErr}).UserMessage())
		}
		req = subtitleEraseInputFromPrepared(prepared)
	}
	queryCtx := WithRequestKind(ctx, "estimate")
	estimate, err := managedMediaClient(queryCtx, input.Config).EstimateSubtitleErase(queryCtx, req)
	if err != nil {
		return nil, BadAuthRequest(ClassifyError(legacyMediaError(err)).UserMessage())
	}
	tier := firstNonEmpty(estimate.Tier, estimate.ResolutionTier)
	ratePerMinute := estimate.RatePerMinuteCNY
	if ratePerMinute <= 0 {
		ratePerMinute = estimate.RateCNYPerMinute
	}
	return map[string]any{
		"mediaType":           "video",
		"model":               firstNonEmpty(estimate.Model, input.Config.Model),
		"source":              map[string]any{"width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs},
		"reservation":         estimate.Reservation,
		"currency":            estimate.Currency,
		"tier":                tier,
		"billedSeconds":       estimate.BilledSeconds,
		"ratePerMinuteCny":    ratePerMinute,
		"billingMode":         estimate.BillingMode,
		"billingSummary":      strings.TrimSpace(estimate.BillingSummary),
		"generationSubmitted": estimate.GenerationSubmitted,
		"cloudProcessing":     true,
	}, nil
}

func BuildVideoSubtitleEraseTaskPayload(ctx context.Context, user string, request SubtitleEraseRequest, ensureMetadata func(context.Context, string, string) (*model.Resource, error), lookupCred func() (string, string, string, string, error)) (Input, map[string]any, error) {
	if strings.TrimSpace(request.ClientOperationID) == "" {
		return Input{}, nil, BadAuthRequest("缺少本次确认的操作 ID")
	}
	input, _, err := SubtitleEraseTaskInput(ctx, user, request, ensureMetadata, lookupCred)
	if err != nil {
		return Input{}, nil, err
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return Input{}, nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return Input{}, nil, err
	}
	config := payload["config"].(map[string]any)
	config["credentialRef"] = beeftv.CredentialRef
	payload["metadata"] = map[string]any{
		"clientOperationId": request.ClientOperationID,
		"nodeId":            request.NodeID,
		"source":            "canvas",
		"operation":         input.SmartEraseTaskOperation(),
	}
	return input, payload, nil
}

func useManagedMediaEnvelopeForSubtitleErase(ctx context.Context, config Config, managedOp string) (*beeftv.MediaClient, bool, error) {
	if !managedConnection(config) {
		return nil, false, nil
	}
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.ManagedMedia == nil {
		return nil, false, nil
	}
	client, _ := ctx.Value(managedClientContextKey{}).(*beeftv.MediaClient)
	if client == nil {
		client = managedMediaClient(ctx, config)
	}
	sent, err := runtime.ManagedMedia.Sent(ctx)
	if err != nil || sent {
		return client, sent, err
	}
	if config.MediaProtocolVersion != beeftv.MediaProtocolVersion || ResumedProviderRequestID(ctx) != "" {
		return nil, false, nil
	}
	discovery, err := client.Discover(ctx)
	if err != nil {
		return nil, false, nil
	}
	if !slices.Contains(discovery.SupportedMediaTypes, "video") {
		return client, false, nil
	}
	modelCap, ok := discovery.Models[config.Model]
	if !ok {
		return client, false, nil
	}
	videoCap, ok := modelCap.Capabilities["video"]
	if !ok || !slices.Contains(videoCap.Operations, managedOp) {
		return client, false, nil
	}
	return client, true, nil
}

func RunSubtitleEraseTask(ctx context.Context, input Input) (map[string]any, error) {
	if err := ValidateSubtitleEraseInput(input); err != nil {
		return nil, RequestPreparationError{Cause: err}
	}
	label := resolveSmartEraseSpec(input.SubtitleErase, input.Config.Model).Prompt
	if !managedConnection(input.Config) && !IsBeefTVVideoConfig(ctx, input.Config) {
		return nil, RequestPreparationError{Cause: fmt.Errorf("%s需要连接官方算力账号", label)}
	}
	managedOp := smartEraseManagedOperation(input.SubtitleErase, input.Config.Model)
	client, unified, err := useManagedMediaEnvelopeForSubtitleErase(ctx, input.Config, managedOp)
	if err != nil {
		return nil, err
	}
	if unified {
		return runManagedSubtitleEraseTask(ctx, client, input, managedOp)
	}
	id := ResumedProviderRequestID(ctx)
	if id == "" {
		prepared, err := PrepareSubtitleErase(ctx, input)
		if err != nil {
			return nil, RequestPreparationError{Cause: err}
		}
		if SubmissionKeyFromContext(ctx) == "" {
			return nil, RequestPreparationError{Cause: fmt.Errorf("%s任务缺少持久操作 ID", label)}
		}
		createCtx := WithRequestKind(ctx, "create")
		id, err = managedMediaClient(createCtx, prepared.Config).CreateSubtitleErase(createCtx, SubmissionKeyFromContext(ctx), subtitleEraseInputFromPrepared(prepared))
		if err != nil {
			return nil, UncertainVideoSubmission(ctx, upscaleSubmissionError(legacyMediaError(err)))
		}
	}
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.ReferenceProgress != nil {
		runtime.ReferenceProgress.ClearReference()
	}
	_, queryStage := smartErasePromptAndStage(input.SubtitleErase, input.Config.Model)
	policy := DefaultVideoPollPolicy()
	policy.QueryStage = queryStage
	policy.InitialDelay, policy.Interval = 0, 5*time.Second
	return RunVideoPollLoop(ctx, id, policy, func(ctx context.Context) (VideoPollOutcome, error) {
		result, _, err := QuerySubtitleEraseResult(ctx, input, id)
		return VideoPollOutcome{Done: result != nil, Result: result}, err
	})
}

func runManagedSubtitleEraseTask(ctx context.Context, client *beeftv.MediaClient, input Input, managedOp string) (map[string]any, error) {
	label := resolveSmartEraseSpec(input.SubtitleErase, input.Config.Model).Prompt
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.ManagedMedia == nil {
		return nil, RequestPreparationError{Cause: fmt.Errorf("%s请求缺少持久化提交标识", label)}
	}
	sent, err := runtime.ManagedMedia.Sent(ctx)
	if err != nil {
		return nil, err
	}
	if !sent {
		input, err = prepareOwnedSubtitleEraseSource(ctx, input)
		if err != nil {
			return nil, RequestPreparationError{Cause: err}
		}
	}
	ref := managedReference(input.ReferenceVideos[0], "source")
	ref.Kind = "video"
	options := beeftv.SubtitleEraseBody(subtitleEraseInputFromPrepared(input))
	delete(options, "model")
	delete(options, "video_url")
	request := beeftv.MediaRequest{
		TaskRef:   SubmissionKeyFromContext(ctx),
		MediaType: "video",
		Model:     input.Config.Model,
		Operation: managedOp,
		Options:   options,
	}
	client.ExpectedOutputKind = "video"
	result, err := executeManagedMedia(ctx, client, request, []beeftv.LocalMediaReference{ref})
	if err != nil {
		return nil, err
	}
	attachSmartEraseSubtitles(ctx, client, input, client.LastTaskID, result)
	return result, nil
}
