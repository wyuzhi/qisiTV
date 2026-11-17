package generation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	localasset "qisitv/backend/internal/asset"
	"qisitv/backend/internal/beeftv"
	"qisitv/backend/internal/model"
)

const SubtitleEraseModelName = "video-subtitle-erase"

type SubtitleEraseRegion struct {
	X      *float64 `json:"x,omitempty"`
	Y      *float64 `json:"y,omitempty"`
	Width  *float64 `json:"width,omitempty"`
	Height *float64 `json:"height,omitempty"`
}

type SubtitleEraseOptions struct {
	EraseMethod   string               `json:"eraseMethod"`
	SubtitleModel string               `json:"subtitleModel,omitempty"`
	Region        *SubtitleEraseRegion `json:"region,omitempty"`
}

type SubtitleEraseRequest struct {
	ResourceID        string               `json:"resourceId"`
	ChannelID         string               `json:"channelId"`
	EraseMethod       string               `json:"eraseMethod"`
	SubtitleModel     string               `json:"subtitleModel,omitempty"`
	Region            *SubtitleEraseRegion `json:"region,omitempty"`
	ClientOperationID string               `json:"clientOperationId,omitempty"`
	ProjectID         string               `json:"projectId,omitempty"`
	NodeID            string               `json:"nodeId,omitempty"`
}

func validateSubtitleEraseRegion(region *SubtitleEraseRegion, required bool) error {
	if region == nil {
		if required {
			return errors.New("框选字幕区域模式必须指定区域坐标")
		}
		return nil
	}
	if region.X == nil || region.Y == nil || region.Width == nil || region.Height == nil {
		return errors.New("字幕区域坐标不完整")
	}
	x, y, w, h := *region.X, *region.Y, *region.Width, *region.Height
	for _, v := range []float64{x, y, w, h} {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return errors.New("字幕区域坐标无效")
		}
	}
	if x < 0 || y < 0 || w <= 0 || h <= 0 || x+w > 1.000001 || y+h > 1.000001 {
		return errors.New("字幕区域超出视频画面范围")
	}
	return nil
}

func normalizeSubtitleEraseOptions(method, subModel string, region *SubtitleEraseRegion) (SubtitleEraseOptions, error) {
	m := strings.ToLower(strings.TrimSpace(method))
	if m == "" {
		m = "auto"
	}
	if m != "auto" && m != "custom" {
		return SubtitleEraseOptions{}, errors.New("去字幕方式仅支持自动识别或框选区域")
	}
	sm := strings.ToLower(strings.TrimSpace(subModel))
	if sm == "" {
		sm = "standard"
	}
	if sm != "standard" && sm != "area" {
		return SubtitleEraseOptions{}, errors.New("字幕样式仅支持标准无痕或花字大范围")
	}
	if err := validateSubtitleEraseRegion(region, m == "custom"); err != nil {
		return SubtitleEraseOptions{}, err
	}
	return SubtitleEraseOptions{EraseMethod: m, SubtitleModel: sm, Region: region}, nil
}

func ValidateSubtitleEraseInput(input Input) error {
	if input.Mode != "video" || strings.TrimSpace(input.Config.Model) == "" || input.SubtitleErase == nil {
		return errors.New("去字幕任务参数无效")
	}
	if len(input.ReferenceVideos) != 1 || len(input.ReferenceImages) != 0 || len(input.ReferenceAudios) != 0 || input.Mask != nil {
		return errors.New("视频去字幕需要且仅需要一个源视频")
	}
	source := input.ReferenceVideos[0]
	if !upscaleOwnedSource.MatchString(source.StorageKey) || source.URL != "" || source.DataURL != "" {
		return errors.New("视频去字幕只能使用当前素材库中的视频")
	}
	_, err := normalizeSubtitleEraseOptions(input.SubtitleErase.EraseMethod, input.SubtitleErase.SubtitleModel, input.SubtitleErase.Region)
	return err
}

func toBeefTVSubtitleRegion(region *SubtitleEraseRegion) *beeftv.SubtitleEraseRegion {
	if region == nil {
		return nil
	}
	return &beeftv.SubtitleEraseRegion{X: region.X, Y: region.Y, Width: region.Width, Height: region.Height}
}

func SubtitleEraseCapabilities(ctx context.Context, lookupCred func() (string, string, string, string, error), bindRuntime func(context.Context, CallMeta) context.Context) map[string]any {
	out := map[string]any{
		"model":              SubtitleEraseModelName,
		"eraseMethods":       []string{"auto", "custom"},
		"subtitleModels":     []string{"standard", "area"},
		"maxVideoDurationMs": 600000,
		"cloudProcessing":    true,
		"available":          false,
	}
	if lookupCred == nil {
		return out
	}
	cfg, err := UpscaleConfig(SubtitleEraseModelName, lookupCred)
	if err != nil {
		return out
	}
	qctx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	defer cancel()
	if bindRuntime != nil {
		qctx = bindRuntime(qctx, CallMeta{RequestKind: "capabilities"})
	}
	qctx = WithRequestKind(qctx, "capabilities")
	caps, err := managedMediaClient(qctx, cfg).GetSubtitleEraseCapabilities(qctx)
	if err != nil {
		return out
	}
	available := true
	if caps.Available != nil {
		available = *caps.Available
	} else if caps.Enabled != nil {
		available = *caps.Enabled
	}
	out["available"] = available
	if caps.Model != "" {
		out["model"] = caps.Model
	}
	if len(caps.EraseMethods) > 0 {
		out["eraseMethods"] = caps.EraseMethods
	}
	if len(caps.SubtitleModels) > 0 {
		out["subtitleModels"] = caps.SubtitleModels
	}
	if caps.MaxVideoSeconds > 0 {
		out["maxVideoDurationMs"] = caps.MaxVideoSeconds * 1000
	}
	if strings.TrimSpace(caps.BillingMode) != "" {
		out["billingMode"] = strings.TrimSpace(caps.BillingMode)
	}
	if strings.TrimSpace(caps.BillingSummary) != "" {
		out["billingSummary"] = strings.TrimSpace(caps.BillingSummary)
	}
	if caps.Billing != nil {
		out["billing"] = caps.Billing
	}
	return out
}

func SubtitleEraseTaskInput(ctx context.Context, user string, request SubtitleEraseRequest, ensureMetadata func(context.Context, string, string) (*model.Resource, error), lookupCred func() (string, string, string, string, error)) (Input, *model.Resource, error) {
	var input Input
	if strings.TrimSpace(request.ResourceID) == "" || (request.ChannelID != "" && request.ChannelID != "beeftv") {
		return input, nil, BadAuthRequest("请选择视频素材与官方算力")
	}
	opts, err := normalizeSubtitleEraseOptions(request.EraseMethod, request.SubtitleModel, request.Region)
	if err != nil {
		return input, nil, BadAuthRequest(err.Error())
	}
	resource, err := ensureMetadata(ctx, user, request.ResourceID)
	if err != nil || resource == nil || resource.Status != model.ResourceStatusReady {
		return input, nil, BadAuthRequest("输入视频不存在或未就绪")
	}
	if localasset.NormalizeKind(resource.Kind, resource.MimeType) != "video" {
		return input, nil, BadAuthRequest("视频去字幕仅支持视频素材")
	}
	config, err := UpscaleConfig(SubtitleEraseModelName, lookupCred)
	if err != nil {
		return input, nil, err
	}
	input = Input{
		Mode:          "video",
		Prompt:        "视频去字幕",
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
	if !managedConnection(input.Config) && !IsBeefTVVideoConfig(ctx, input.Config) {
		return input, errors.New("视频去字幕需要连接官方算力账号")
	}
	runtime, _ := RuntimeFromContext(ctx)
	if err := HydrateMedia(ctx, runtime.Call.UserID, &input, MediaHydrationPolicy{KeepLocal: true}); err != nil {
		return input, err
	}
	if len(input.ReferenceVideos) == 0 || input.ReferenceVideos[0].StorageKey == "" {
		return input, errors.New("请先将视频导入素材库，再开始去字幕")
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
		req.EraseMethod = input.SubtitleErase.EraseMethod
		req.SubtitleModel = input.SubtitleErase.SubtitleModel
		req.Region = toBeefTVSubtitleRegion(input.SubtitleErase.Region)
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
		"operation":         "media.video.subtitle_erase",
	}
	return input, payload, nil
}

func useManagedMediaEnvelopeForSubtitleErase(ctx context.Context, config Config) (*beeftv.MediaClient, bool, error) {
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
	if !ok || !slices.Contains(videoCap.Operations, "subtitle_erase") {
		return client, false, nil
	}
	return client, true, nil
}

func RunSubtitleEraseTask(ctx context.Context, input Input) (map[string]any, error) {
	if err := ValidateSubtitleEraseInput(input); err != nil {
		return nil, RequestPreparationError{Cause: err}
	}
	if !managedConnection(input.Config) && !IsBeefTVVideoConfig(ctx, input.Config) {
		return nil, RequestPreparationError{Cause: errors.New("视频去字幕需要连接官方算力账号")}
	}
	client, unified, err := useManagedMediaEnvelopeForSubtitleErase(ctx, input.Config)
	if err != nil {
		return nil, err
	}
	if unified {
		return runManagedSubtitleEraseTask(ctx, client, input)
	}
	id := ResumedProviderRequestID(ctx)
	if id == "" {
		prepared, err := PrepareSubtitleErase(ctx, input)
		if err != nil {
			return nil, RequestPreparationError{Cause: err}
		}
		if SubmissionKeyFromContext(ctx) == "" {
			return nil, RequestPreparationError{Cause: errors.New("视频去字幕任务缺少持久操作 ID")}
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
	policy := DefaultVideoPollPolicy()
	policy.QueryStage = "正在消除视频字幕"
	policy.InitialDelay, policy.Interval = 0, 5*time.Second
	return RunVideoPollLoop(ctx, id, policy, func(ctx context.Context) (VideoPollOutcome, error) {
		result, _, err := QuerySubtitleEraseResult(ctx, input, id)
		return VideoPollOutcome{Done: result != nil, Result: result}, err
	})
}

func runManagedSubtitleEraseTask(ctx context.Context, client *beeftv.MediaClient, input Input) (map[string]any, error) {
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.ManagedMedia == nil {
		return nil, RequestPreparationError{Cause: errors.New("视频去字幕请求缺少持久化提交标识")}
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
	options := map[string]any{
		"erase_method":   input.SubtitleErase.EraseMethod,
		"subtitle_model": defaultString(input.SubtitleErase.SubtitleModel, "standard"),
	}
	if input.SubtitleErase.Region != nil {
		options["region"] = toBeefTVSubtitleRegion(input.SubtitleErase.Region)
	}
	request := beeftv.MediaRequest{
		TaskRef:   SubmissionKeyFromContext(ctx),
		MediaType: "video",
		Model:     input.Config.Model,
		Operation: "subtitle_erase",
		Options:   options,
	}
	client.ExpectedOutputKind = "video"
	result, err := executeManagedMedia(ctx, client, request, []beeftv.LocalMediaReference{ref})
	if err != nil {
		return nil, err
	}
	if videoMap, ok := result["video"].(map[string]any); ok {
		if rawDataURL, _ := videoMap["dataUrl"].(string); rawDataURL != "" {
			if _, binary, decErr := DecodeProviderDataURL(rawDataURL); decErr == nil && len(binary) > 0 {
				restored, muxErr := RestoreSubtitleEraseSourceAudio(ctx, input, binary)
				if muxErr != nil {
					return nil, VideoDownloadError{TaskID: request.TaskRef, Cause: muxErr}
				}
				videoMap["dataUrl"] = DataURL("video/mp4", restored)
				videoMap["mimeType"] = "video/mp4"
			}
		}
	}
	return result, nil
}

func RecoverSubtitleEraseResult(ctx context.Context, input Input, id string) (map[string]any, string, error) {
	return QuerySubtitleEraseResult(ctx, input, id)
}

func QuerySubtitleEraseStatus(ctx context.Context, config Config, id string) (string, error) {
	ctx = WithRequestKind(ctx, "poll")
	task, err := managedMediaClient(ctx, config).QuerySubtitleErase(ctx, id, config.Model)
	return task.Status, legacyMediaError(err)
}

func QuerySubtitleEraseResult(ctx context.Context, input Input, id string) (map[string]any, string, error) {
	queryCtx := WithRequestKind(ctx, "poll")
	receipt, err := managedMediaClient(queryCtx, input.Config).QuerySubtitleErase(queryCtx, id, input.Config.Model)
	status := receipt.Status
	if err != nil {
		return nil, "", legacyMediaError(err)
	}
	switch status {
	case "queued", "in_progress", "cancelling", "unknown":
		return nil, status, nil
	case "failed", "cancelled":
		if receipt.Error != nil && strings.TrimSpace(receipt.Error.UserMessage) != "" {
			return nil, status, errors.New(strings.TrimSpace(receipt.Error.UserMessage))
		}
		if receipt.Error != nil && strings.TrimSpace(receipt.Error.Message) != "" {
			return nil, status, errors.New(strings.TrimSpace(receipt.Error.Message))
		}
		return nil, status, errors.New("视频去字幕未完成，请查看任务详情")
	case "completed":
	default:
		return nil, status, StatePendingError{TaskID: id, Cause: fmt.Errorf("unknown subtitle erase status")}
	}
	ctx = WithRequestKind(ctx, "download")
	data, mime, err := RunVideoDownload(ctx, id, DefaultVideoPollPolicy(), func(ctx context.Context) ([]byte, string, error) {
		limit, limitErr := GeneratedFileLimit(ctx)
		if limitErr != nil {
			return nil, "", limitErr
		}
		return managedMediaClient(ctx, input.Config).SubtitleEraseContent(ctx, id, limit)
	})
	if err != nil {
		return nil, status, VideoDownloadError{TaskID: id, Cause: err}
	}
	mime = NormalizedMediaMIMEType(mime, data)
	if !strings.HasPrefix(mime, "video/") {
		return nil, status, VideoDownloadError{TaskID: id, Cause: errors.New("去字幕结果不是有效视频")}
	}
	data, err = RestoreSubtitleEraseSourceAudio(ctx, input, data)
	if err != nil {
		return nil, status, VideoDownloadError{TaskID: id, Cause: err}
	}
	return map[string]any{"mode": "video", "video": map[string]any{"dataUrl": DataURL("video/mp4", data), "mimeType": "video/mp4"}}, status, nil
}

func RestoreSubtitleEraseSourceAudio(ctx context.Context, input Input, data []byte) ([]byte, error) {
	if input.SubtitleErase == nil || input.Mode != "video" {
		return data, nil
	}
	if len(input.ReferenceVideos) != 1 {
		return nil, errors.New("缺少原视频，无法检查音轨")
	}
	runtime, _ := RuntimeFromContext(ctx)
	source, _, skip, err := ownedSeedanceMediaReader(ctx, runtime.Call.UserID)("video", Media{StorageKey: input.ReferenceVideos[0].StorageKey})
	if err != nil || skip {
		return nil, errors.New("原视频无法读取，暂时不能保留音轨")
	}
	return PreserveUpscaleAudio(ctx, source, data)
}

func CancelSubtitleErase(ctx context.Context, config Config, id string) error {
	return managedMediaClient(ctx, config).CancelSubtitleErase(ctx, id)
}
