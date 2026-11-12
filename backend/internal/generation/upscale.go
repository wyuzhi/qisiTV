package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"regexp"
	"strings"
	"time"

	"qisitv/backend/internal/beeftv"

	_ "golang.org/x/image/webp"
)

type UpscaleOptions struct {
	Factor       int    `json:"factor"`
	OutputFormat string `json:"outputFormat,omitempty"`
	ModelQuality string `json:"modelQuality,omitempty"`
	Resolution   string `json:"resolution,omitempty"`
}

func UpscaleMediaType(model string) string {
	switch model {
	case "topaz-standard-v2", "topaz-wonder-3.5", "huoshan_image_super_resolution":
		return "image"
	case "topaz-proteus", "topaz-starlight-fast-2", "tengxun_video_super_resolution":
		return "video"
	default:
		return ""
	}
}

func ValidateUpscaleInput(input Input) error {
	if IsLikeAIUpscaleModel(input.Config.Model) {
		return ValidateLikeAIUpscaleInput(input)
	}
	kind := input.Mode
	if (kind != "image" && kind != "video") || input.Config.Model == "" || input.Upscale == nil {
		return errors.New("超分模型、素材类型或参数无效")
	}
	if input.Upscale.Factor < 1 || input.Upscale.Factor > 4 {
		return errors.New("放大倍数须为 1 至 4 的整数")
	}
	if kind == "image" && (len(input.ReferenceImages) != 1 || len(input.ReferenceVideos) != 0) || kind == "video" && (len(input.ReferenceVideos) != 1 || len(input.ReferenceImages) != 0) || len(input.ReferenceAudios) != 0 || input.Mask != nil {
		return errors.New("每个超分任务需要一个同类型素材")
	}
	source := input.ReferenceImages
	if kind == "video" {
		source = input.ReferenceVideos
	}
	if !upscaleOwnedSource.MatchString(source[0].StorageKey) || source[0].URL != "" || source[0].DataURL != "" {
		return errors.New("超分只能使用当前素材库中的图片或视频")
	}
	format := input.Upscale.OutputFormat
	if format != "" && format != "png" && format != "jpeg" {
		return errors.New("图片输出格式须为 PNG 或 JPEG")
	}
	return nil
}

var upscaleOwnedSource = regexp.MustCompile(`^resource:[A-Za-z0-9_-]{1,128}$`)

// Preparation uses the existing owner-scoped media reader and gateway upload.
// Resuming an accepted task never uploads again or calls the create endpoint.
func PrepareUpscale(ctx context.Context, input Input) (Input, error) {
	input, err := prepareOwnedUpscaleSource(ctx, input)
	if err != nil {
		return input, err
	}
	runtime, _ := RuntimeFromContext(ctx)
	if err := PrepareBeefTVVideoReferences(ctx, input.Config, &input, ownedSeedanceMediaReader(ctx, runtime.Call.UserID)); err != nil {
		return input, err
	}
	return input, nil
}

func prepareOwnedUpscaleSource(ctx context.Context, input Input) (Input, error) {
	input.ReferenceImages = append([]Media(nil), input.ReferenceImages...)
	input.ReferenceVideos = append([]Media(nil), input.ReferenceVideos...)
	if err := ValidateUpscaleInput(input); err != nil {
		return input, err
	}
	if !managedConnection(input.Config) && !IsBeefTVVideoConfig(ctx, input.Config) {
		return input, errors.New("AI 超分需要连接官方算力账号")
	}
	runtime, _ := RuntimeFromContext(ctx)
	if err := HydrateMedia(ctx, runtime.Call.UserID, &input, MediaHydrationPolicy{KeepLocal: true}); err != nil {
		return input, err
	}
	kind := input.Mode
	media := input.ReferenceImages
	if kind == "video" {
		media = input.ReferenceVideos
	}
	if media[0].StorageKey == "" {
		return input, errors.New("请先将素材导入素材库，再开始超分")
	}
	data, mime, skip, err := ownedSeedanceMediaReader(ctx, runtime.Call.UserID)(kind, media[0])
	if err != nil {
		return input, err
	}
	if skip {
		return input, errors.New("超分素材未通过素材库归属校验")
	}
	deliveryLimit, err := GeneratedFileLimit(ctx)
	if err != nil {
		return input, err
	}
	factor := int64(input.Upscale.Factor)
	estimatedBytes := int64(len(data))*factor*factor*2 + 1<<20
	limit := 30 << 20
	if kind == "video" {
		limit = 200 << 20
	}
	if len(data) == 0 || len(data) > limit {
		return input, errors.New("素材为空或超过超分文件大小限制")
	}
	if kind == "image" {
		if mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" {
			return input, errors.New("图片仅支持 PNG、JPEG 或 WebP")
		}
		meta, err := upscaleImageConfig(data)
		if err != nil {
			return input, err
		}
		// Estimate common 8-bit PNG/JPEG output; actual bytes remain quota checked.
		estimatedBytes = int64(meta.Width)*int64(meta.Height)*factor*factor*4 + 1<<20
	} else if err := ValidateUpscaleVideoSource(ctx, data); err != nil {
		return input, err
	}
	if estimatedBytes > deliveryLimit {
		return input, fmt.Errorf("预计超分结果可能超过本机单个生成资源上限 %s，请降低放大倍数或调高资源上限后重试", formatStorageLimit(deliveryLimit))
	}
	return input, nil
}

func upscaleImageConfig(data []byte) (image.Config, error) {
	meta, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || meta.Width <= 0 || meta.Height <= 0 || int64(meta.Width)*int64(meta.Height) > 32<<20 {
		return meta, errors.New("图片无法读取或超过 3200 万像素")
	}
	return meta, nil
}

func legacyUpscaleInput(input Input) beeftv.LegacyUpscaleInput {
	request := beeftv.LegacyUpscaleInput{Model: input.Config.Model, MediaType: input.Mode, Factor: input.Upscale.Factor, OutputFormat: input.Upscale.OutputFormat}
	if input.Mode == "image" && len(input.ReferenceImages) > 0 {
		request.SourceURL = input.ReferenceImages[0].URL
	}
	if input.Mode == "video" && len(input.ReferenceVideos) > 0 {
		request.SourceURL = input.ReferenceVideos[0].URL
	}
	return request
}
func upscaleBody(input Input) map[string]any {
	return beeftv.LegacyUpscaleBody(legacyUpscaleInput(input))
}

type UpscaleEstimate = beeftv.UpscaleEstimate

func EstimateUpscale(ctx context.Context, input Input) (UpscaleEstimate, error) {
	var estimate UpscaleEstimate
	prepared, err := PrepareUpscale(ctx, input)
	if err != nil {
		return estimate, RequestPreparationError{Cause: err}
	}
	queryCtx := WithRequestKind(ctx, "estimate")
	return managedMediaClient(queryCtx, prepared.Config).EstimateLegacyUpscale(queryCtx, legacyUpscaleInput(prepared))
}

func upscaleTaskPath(id string) (string, error) { return beeftv.LegacyUpscaleTaskPath(id) }

func RunUpscaleTask(ctx context.Context, input Input) (map[string]any, error) {
	if IsLikeAIUpscaleModel(input.Config.Model) {
		return runLikeAIUpscale(ctx, input)
	}
	if err := ValidateUpscaleInput(input); err != nil {
		return nil, RequestPreparationError{Cause: err}
	}
	if !managedConnection(input.Config) && !IsBeefTVVideoConfig(ctx, input.Config) {
		return nil, RequestPreparationError{Cause: errors.New("AI 超分需要连接官方算力账号")}
	}
	client, unified, err := useManagedMediaEnvelope(ctx, input.Config, "upscale")
	if err != nil {
		return nil, err
	}
	if unified {
		return runManagedUpscaleTask(ctx, client, input)
	}
	id := ResumedProviderRequestID(ctx)
	if id == "" {
		prepared, err := PrepareUpscale(ctx, input)
		if err != nil {
			return nil, RequestPreparationError{Cause: err}
		}
		if SubmissionKeyFromContext(ctx) == "" {
			return nil, RequestPreparationError{Cause: errors.New("超分任务缺少持久操作 ID")}
		}
		createCtx := WithRequestKind(ctx, "create")
		id, err = managedMediaClient(createCtx, prepared.Config).CreateLegacyUpscale(createCtx, SubmissionKeyFromContext(ctx), legacyUpscaleInput(prepared))
		if err != nil {
			return nil, UncertainVideoSubmission(ctx, upscaleSubmissionError(legacyMediaError(err)))
		}
	}
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.ReferenceProgress != nil {
		runtime.ReferenceProgress.ClearReference()
	}
	policy := DefaultVideoPollPolicy()
	policy.QueryStage = "正在确认超分结果"
	policy.InitialDelay, policy.Interval = 0, 5*time.Second
	return RunVideoPollLoop(ctx, id, policy, func(ctx context.Context) (VideoPollOutcome, error) {
		result, _, err := QueryUpscaleResult(ctx, input, id)
		return VideoPollOutcome{Done: result != nil, Result: result}, err
	})
}

func runManagedUpscaleTask(ctx context.Context, client *beeftv.MediaClient, input Input) (map[string]any, error) {
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.ManagedMedia == nil {
		return nil, RequestPreparationError{Cause: errors.New("超分请求缺少持久化提交标识")}
	}
	sent, err := runtime.ManagedMedia.Sent(ctx)
	if err != nil {
		return nil, err
	}
	if !sent {
		input, err = prepareOwnedUpscaleSource(ctx, input)
		if err != nil {
			return nil, RequestPreparationError{Cause: err}
		}
	}
	media := input.ReferenceImages
	if input.Mode == "video" {
		media = input.ReferenceVideos
	}
	ref := managedReference(media[0], "source")
	ref.Kind = input.Mode
	ref.MaxBytes = 30 << 20
	if input.Mode == "video" {
		ref.MaxBytes = 200 << 20
	}
	options := map[string]any{"upscale_factor": input.Upscale.Factor}
	if input.Mode == "image" {
		options["output_format"] = defaultString(input.Upscale.OutputFormat, "png")
		options["face_enhancement"] = false
	} else {
		options["H264_output"] = true
	}
	request := beeftv.MediaRequest{TaskRef: SubmissionKeyFromContext(ctx), MediaType: "upscale", Model: input.Config.Model, Operation: "upscale", Options: options}
	client.ExpectedOutputKind = input.Mode
	return executeManagedMedia(ctx, client, request, []beeftv.LocalMediaReference{ref})
}

// BeefTV owns provider recovery. Client recovery only queries the original task.
func RecoverUpscaleResult(ctx context.Context, input Input, id string) (map[string]any, string, error) {
	if IsLikeAIUpscaleModel(input.Config.Model) {
		adapter, ok := DeclarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType)
		if !ok {
			return nil, "", errors.New("LikeAI 协议插件未安装")
		}
		return QueryProtocolAdapterVideoTask(ctx, input, adapter, id)
	}
	return QueryUpscaleResult(ctx, input, id)
}

func upscaleSubmissionError(err error) error {
	var unknown SubmissionUnknownError
	if errors.As(err, &unknown) {
		return err
	}
	var upstream HTTPError
	if !errors.As(err, &upstream) {
		return err
	}
	var rejection struct {
		TaskID string `json:"task_id"`
		ID     string `json:"id"`
		Error  struct {
			Code string `json:"code"`
		} `json:"error"`
		Code string `json:"code"`
	}
	if json.Unmarshal([]byte(upstream.Body), &rejection) != nil || rejection.TaskID != "" || rejection.ID != "" {
		return err
	}
	code := firstNonEmpty(rejection.Error.Code, rejection.Code)
	if (upstream.StatusCode == 400 || upstream.StatusCode == 422) && code != "" || upstream.StatusCode == 503 && (code == "fal_billing_unavailable" || code == "upscale_unavailable") {
		return SubmissionRejectedError{Cause: err}
	}
	return err
}

// Receipts cannot choose a download host or path. Only the authenticated
// content endpoint for this exact original task is used.
func QueryUpscaleStatus(ctx context.Context, config Config, id string) (string, error) {
	ctx = WithRequestKind(ctx, "poll")
	task, err := managedMediaClient(ctx, config).QueryLegacyUpscale(ctx, id, config.Model, "")
	return task.Status, legacyMediaError(err)
}

func QueryUpscaleResult(ctx context.Context, input Input, id string) (map[string]any, string, error) {
	queryCtx := WithRequestKind(ctx, "poll")
	receipt, err := managedMediaClient(queryCtx, input.Config).QueryLegacyUpscale(queryCtx, id, input.Config.Model, input.Mode)
	status := receipt.Status
	if err != nil {
		return nil, "", err
	}
	switch status {
	case "queued", "in_progress", "cancelling", "unknown":
		return nil, status, nil
	case "failed", "cancelled":
		return nil, status, errors.New("超分任务未完成，请查看任务详情")
	case "completed":
	default:
		return nil, status, StatePendingError{TaskID: id, Cause: fmt.Errorf("unknown upscale status")}
	}
	ctx = WithRequestKind(ctx, "download")
	data, mime, err := RunVideoDownload(ctx, id, DefaultVideoPollPolicy(), func(ctx context.Context) ([]byte, string, error) {
		limit, limitErr := GeneratedFileLimit(ctx)
		if limitErr != nil {
			return nil, "", limitErr
		}
		return managedMediaClient(ctx, input.Config).LegacyUpscaleContent(ctx, id, limit)
	})
	if err != nil {
		return nil, status, VideoDownloadError{TaskID: id, Cause: err}
	}
	mime = NormalizedMediaMIMEType(mime, data)
	if input.Mode == "image" {
		if err := ValidateImageArtifact(data, mime); err != nil {
			return nil, status, VideoDownloadError{TaskID: id, Cause: err}
		}
		return map[string]any{"mode": "image", "images": []map[string]any{{"dataUrl": DataURL(mime, data), "mimeType": mime}}}, status, nil
	}
	if !strings.HasPrefix(mime, "video/") {
		return nil, status, VideoDownloadError{TaskID: id, Cause: errors.New("超分结果不是有效视频")}
	}
	data, err = RestoreUpscaleSourceAudio(ctx, input, data)
	if err != nil {
		return nil, status, VideoDownloadError{TaskID: id, Cause: err}
	}
	return map[string]any{"mode": "video", "video": map[string]any{"dataUrl": DataURL("video/mp4", data), "mimeType": "video/mp4"}}, status, nil
}

func RestoreUpscaleSourceAudio(ctx context.Context, input Input, data []byte) ([]byte, error) {
	if input.Upscale == nil || input.Mode != "video" {
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

func CancelUpscale(ctx context.Context, config Config, id string) error {
	return managedMediaClient(ctx, config).CancelLegacyUpscale(ctx, id)
}
