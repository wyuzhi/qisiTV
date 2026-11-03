package generation

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/providerpreset"
)

// Managed connections expose content intent, never a supplier request body.
// Model discovery/validation is server-owned; BYOK still uses its own plugin.
func managedConnection(config Config) bool { return config.CredentialRef == beefapi.CredentialRef }

func legacyMediaError(err error) error {
	var upstream *beefapi.MediaHTTPError
	if errors.As(err, &upstream) {
		body, _ := json.Marshal(map[string]any{"error": upstream.TaskError})
		if upstream.Body != "" {
			body = []byte(upstream.Body)
		}
		return HTTPError{StatusCode: upstream.StatusCode, Body: string(body), RequestID: upstream.RequestID}
	}
	return err
}

func referenceMediaUploadError(ctx context.Context, err error) *ReferenceUploadError {
	var upload *beefapi.UploadError
	if errors.As(err, &upload) {
		ctx = referenceUploadAttempt(referenceUploadStage(ctx, upload.Meta.Stage), upload.Meta.Attempt)
	}
	result := referenceUploadError(ctx, legacyMediaError(err))
	if upload != nil {
		result.Dispatched, result.TransportPhase = upload.Dispatched, upload.Phase
	}
	return result
}

func runManagedImageTask(ctx context.Context, input Input) (map[string]any, error) {
	runtime, _ := RuntimeFromContext(ctx)
	client := managedMediaClient(ctx, input.Config)
	if runtime.ManagedMedia == nil || SubmissionKeyFromContext(ctx) == "" {
		return nil, RequestPreparationError{Cause: errors.New("图片请求缺少持久化提交标识")}
	}
	request := beefapi.MediaRequest{TaskRef: SubmissionKeyFromContext(ctx), MediaType: "image", Model: input.Config.Model, Operation: "generate", Options: managedImageOptions(input)}
	request.Input.Prompt = WithSystemPrompt(input.Config, input.Prompt)
	refs := make([]beefapi.LocalMediaReference, 0, len(input.ReferenceImages)+1)
	for _, image := range input.ReferenceImages {
		refs = append(refs, managedReference(image, "reference"))
	}
	if input.Mask != nil {
		refs = append(refs, managedReference(*input.Mask, "mask"))
	}
	if input.ImageCapability != nil {
		for i := range refs {
			refs[i].MaxBytes = input.ImageCapability.References.MaxImageBytes
		}
	}
	if len(refs) > 0 {
		request.Operation = "edit"
	}
	return executeManagedMedia(ctx, client, request, refs)
}

func executeManagedMedia(ctx context.Context, client *beefapi.MediaClient, request beefapi.MediaRequest, refs []beefapi.LocalMediaReference) (map[string]any, error) {
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.ManagedMedia == nil || request.TaskRef == "" {
		return nil, RequestPreparationError{Cause: errors.New("媒体请求缺少持久化提交标识")}
	}
	result, err := client.Execute(ctx, request, refs)
	if err != nil {
		var task *beefapi.MediaTaskError
		if errors.As(err, &task) {
			if !task.Pending() {
				return nil, err
			}
			return nil, SubmissionUnknownError{Cause: err}
		}
		if beefapi.IsDefiniteMediaRejection(err) {
			return nil, err
		}
		if sent, lookupErr := runtime.ManagedMedia.Sent(ctx); lookupErr == nil && sent {
			return nil, SubmissionUnknownError{Cause: err}
		}
		return nil, RequestPreparationError{Cause: err}
	}
	return result, nil
}

func managedReference(media Media, role string) beefapi.LocalMediaReference {
	return beefapi.LocalMediaReference{MediaReference: beefapi.MediaReference{Kind: "image", Role: role, URL: media.URL}, StorageKey: media.StorageKey, DataURL: media.DataURL, MIME: media.MimeType, Bytes: media.Bytes}
}

func validateManagedImageReference(input *Input, size int64) error {
	if size <= 0 {
		return errors.New("参考素材为空")
	}
	if input.ImageCapability != nil && input.ImageCapability.References.MaxImageBytes > 0 && size > input.ImageCapability.References.MaxImageBytes {
		return errors.New("参考图片文件超过当前模型大小限制")
	}
	return nil
}
func managedImageOptions(input Input) map[string]any {
	config := input.Config
	options := map[string]any{}
	if size := managedImageSize(input.ImageCapability, config.Size); size != "" {
		options["size"] = size
	}
	if quality := managedImageQuality(input.ImageCapability, config.Quality); quality != "" {
		options["quality"] = quality
	}
	if n, err := strconv.Atoi(config.Count); err == nil && n > 0 {
		options["n"] = n
	}
	if config.TransparentBackground == "true" {
		options["background"] = "transparent"
		options["output_format"] = "png"
	}
	if config.SeedreamOutputFormat != "" {
		options["output_format"] = config.SeedreamOutputFormat
	}
	if config.TransparentBackground == "true" {
		options["output_format"] = "png"
	}
	if config.SeedreamMode == "layers" {
		options["layer_decomposition"] = true
	}
	if input.ImageCapability == nil || input.ImageCapability.SequentialGeneration.Supported {
		if n := sequentialMaxImagesForInput(input); n > 1 {
			options["sequential_image_generation"] = "auto"
			options["sequential_image_generation_options"] = map[string]any{"max_images": n}
		}
	}
	if config.SeedreamOptimize != "" {
		options["optimize_prompt_options"] = map[string]any{"mode": config.SeedreamOptimize}
	}
	if providerpreset.SeedreamFamily(config.Model) != "" {
		options["watermark"] = config.SeedreamWatermark == "true"
	}
	return options
}

// ManagedImageSizeAndQuality 返回托管图片请求实际发送的尺寸和画质，费用估算据此取同一个计费档位。
func ManagedImageSizeAndQuality(profile *ImageCapabilityConfig, size, quality string) (string, string) {
	return managedImageSize(profile, size), managedImageQuality(profile, quality)
}

// managedImageQuality 只发送模型目录声明支持的画质；不支持或不在可选值里时交给服务端默认值。
func managedImageQuality(profile *ImageCapabilityConfig, raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" || strings.EqualFold(value, "auto") || !ImageQualitySupported(profile) {
		return ""
	}
	if profile != nil && len(profile.Quality.Values) > 0 {
		for _, allowed := range profile.Quality.Values {
			if strings.EqualFold(allowed, value) {
				return allowed
			}
		}
		return ""
	}
	return value
}

// managedImageSize 把画布尺寸换成模型目录允许的值，不按模型名写规则：
// 目录列出的值原样发送；画布比例（如 16:9）优先用目录预设，否则按旧换算表与目录默认尺寸中
// 面积较大的一个换成同比例像素（宽高取 16 的倍数）；不允许自定义尺寸时取比例最接近的目录值。
func managedImageSize(profile *ImageCapabilityConfig, raw string) string {
	value := strings.TrimSpace(strings.ReplaceAll(raw, "×", "x"))
	if value == "" || strings.EqualFold(value, "auto") {
		return ""
	}
	if profile == nil {
		if normalized := NormalizePixelSize(value); normalized != "" {
			return normalized
		}
		return value
	}
	if profile.Size.Parameter == "aspect_ratio" {
		return NormalizeImageAspectRatio(value)
	}
	ratioW, ratioH, isRatio := parseImageRatio(value)
	pixelW, pixelH, isPixel := parseImagePixels(value)
	if !isRatio {
		for _, allowed := range profile.Size.Values {
			if strings.EqualFold(allowed, value) {
				return allowed
			}
		}
	}
	if !isRatio && !isPixel {
		return ""
	}
	if isRatio {
		defaultTier := strings.TrimSpace(profile.Size.Default)
		for _, preset := range profile.Size.Presets {
			if preset.Ratio == value && preset.Size != "" && (preset.Tier == "" || defaultTier == "" || strings.EqualFold(preset.Tier, defaultTier)) {
				return preset.Size
			}
		}
	}
	if !profile.Size.AllowCustom {
		if !isPixel {
			pixelW, pixelH = ratioW, ratioH
		}
		return closestImageSize(profile.Size.Values, pixelW, pixelH, profile.Size.Default)
	}
	if isPixel {
		return value
	}
	area := imageSizeArea(NormalizePixelSize(value))
	if fallback := imageSizeArea(profile.Size.Default); fallback > area {
		area = fallback
	}
	if area <= 0 {
		area = 1024 * 1024
	}
	width := math.Sqrt(area * float64(ratioW) / float64(ratioH))
	height := math.Sqrt(area * float64(ratioH) / float64(ratioW))
	return strconv.Itoa(roundToSixteen(width)) + "x" + strconv.Itoa(roundToSixteen(height))
}

func parseImageRatio(value string) (int, int, bool) {
	left, right, ok := strings.Cut(value, ":")
	if !ok {
		return 0, 0, false
	}
	w, wErr := strconv.Atoi(strings.TrimSpace(left))
	h, hErr := strconv.Atoi(strings.TrimSpace(right))
	return w, h, wErr == nil && hErr == nil && w > 0 && h > 0
}

func parseImagePixels(value string) (int, int, bool) {
	left, right, ok := strings.Cut(strings.ToLower(value), "x")
	if !ok {
		return 0, 0, false
	}
	w, wErr := strconv.Atoi(strings.TrimSpace(left))
	h, hErr := strconv.Atoi(strings.TrimSpace(right))
	return w, h, wErr == nil && hErr == nil && w > 0 && h > 0
}

// imageSizeArea 读出像素尺寸（1024x1024）或档位（2K、1.5K 指长边 N×1024 的正方形）的面积。
func imageSizeArea(value string) float64 {
	value = strings.TrimSpace(value)
	if w, h, ok := parseImagePixels(value); ok {
		return float64(w * h)
	}
	if strings.HasSuffix(strings.ToUpper(value), "K") {
		if n, err := strconv.ParseFloat(strings.TrimSuffix(strings.ToUpper(value), "K"), 64); err == nil && n > 0 {
			side := n * 1024
			return side * side
		}
	}
	return 0
}

func roundToSixteen(value float64) int {
	return max(16, int(math.Round(value/16))*16)
}

func closestImageSize(values []string, width, height int, fallback string) string {
	best, bestDiff := "", math.MaxFloat64
	want := math.Log(float64(width) / float64(height))
	for _, candidate := range values {
		w, h, ok := parseImagePixels(candidate)
		if !ok {
			continue
		}
		if diff := math.Abs(math.Log(float64(w)/float64(h)) - want); diff < bestDiff {
			best, bestDiff = candidate, diff
		}
	}
	if best == "" {
		if trimmed := strings.TrimSpace(fallback); trimmed != "" {
			if normalized := NormalizePixelSize(trimmed); normalized != "" {
				return normalized
			}
			return trimmed
		}
		if len(values) > 0 {
			return strings.TrimSpace(values[0])
		}
	}
	return best
}

func managedMediaClient(ctx context.Context, config Config) *beefapi.MediaClient {
	runtime, _ := RuntimeFromContext(ctx)
	client := &beefapi.MediaClient{BaseURL: config.BaseURL, APIKey: config.APIKey, State: runtime.ManagedMedia, AllowHTTPTest: runtime.Endpoints.BeefAPIVideoBaseURL != ""}
	client.Headers = make(http.Header)
	if projection, ok := runtime.ManagedMedia.(beefapi.MediaProjectionPort); ok {
		client.Project = projection.Project
	}
	for _, header := range config.Headers {
		client.Headers.Set(header.Name, header.Value)
	}
	client.Open = func(_ context.Context, key string) (io.ReadCloser, string, int64, error) {
		if runtime.Resources == nil || !strings.HasPrefix(key, "resource:") {
			return nil, "", 0, errors.New("参考素材资源端口未接入")
		}
		info, body, err := runtime.Resources.Open(runtime.Call.UserID, strings.TrimPrefix(key, "resource:"))
		return body, info.MimeType, info.Size, err
	}
	observers := map[string]func(int64, int64, string){}
	client.Progress = func(label string, loaded, total int64, phase string) {
		if runtime.ReferenceProgress == nil {
			return
		}
		if reporter, _ := ctx.Value(referenceProgressContext{}).(*referenceReporter); reporter != nil {
			if phase == "resuming" {
				reporter.resumeAt(loaded)
			} else {
				reporter.report(phase, loaded)
			}
			return
		}
		// Reuse the task-bound progress port; no upload journal is introduced.
		observer := observers[label]
		if observer == nil {
			observer = ReferenceUploadObserver(ctx, label)
			observers[label] = observer
		}
		observer(loaded, total, phase)
	}
	client.Observe = func(req *http.Request, resp *http.Response, body []byte, err error) {
		if runtime.ReferenceProgress != nil && strings.Contains(req.URL.Path, "/media/tasks") {
			runtime.ReferenceProgress.ClearReference()
		}
		if runtime.Receipts == nil {
			return
		}
		if meta := beefapi.UploadMetaFromContext(req.Context()); meta.Stage != "" {
			req = req.WithContext(referenceUploadAttempt(referenceUploadStage(req.Context(), meta.Stage), meta.Attempt))
		}
		observation := TransportObservation{Request: req, Body: body, Err: legacyMediaError(err), StartedAt: time.Now(), Dispatched: true, ResponseLimitBytes: 4 << 20, ReceivedBytes: int64(len(body))}
		if resp != nil {
			observation.StatusCode = resp.StatusCode
			observation.HTTPStatus = resp.StatusCode
			observation.DeclaredResponseBytes = resp.ContentLength
			observation.Headers = resp.Header.Clone()
		}
		runtime.Receipts.Observe(observation)
	}
	client.StorageObserve = func(observation beefapi.UploadObservation) {
		if runtime.Receipts == nil {
			return
		}
		req := observation.Request.WithContext(referenceUploadStage(observation.Request.Context(), "put"))
		value := TransportObservation{Request: req, StartedAt: observation.StartedAt, Err: observation.Err, Dispatched: observation.Dispatched, TransportPhase: observation.Phase, TransportRoute: observation.Route, ReceivedBytes: observation.ReceivedBytes, ResponseLimitBytes: 1 << 20}
		if meta := beefapi.UploadMetaFromContext(req.Context()); meta.Attempt > 0 {
			value.Request = value.Request.WithContext(referenceUploadAttempt(value.Request.Context(), meta.Attempt))
		}
		if observation.Response != nil {
			value.StatusCode = observation.Response.StatusCode
			value.HTTPStatus = value.StatusCode
			value.Headers = observation.Response.Header.Clone()
			value.DeclaredResponseBytes = observation.Response.ContentLength
		}
		runtime.Receipts.Observe(value)
	}
	return client
}
