package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/playback"
)

const (
	beefAPISeedanceJSONOverheadBytes = int64(64 << 10)
	beefAPISeedanceImageMaxBytes     = int64(30 << 20)
	beefAPISeedanceVideoMaxBytes     = int64(200 << 20)
	beefAPISeedanceAudioMaxBytes     = int64(15 << 20)
	beefAPISeedanceUploadTimeout     = 15 * time.Minute
)

var (
	errBeefAPISeedanceUploadRedirect    = beefapi.ErrUploadRedirect
	errBeefAPISeedanceUploadUnavailable = errors.New("暂时无法接收参考素材")
	errBeefAPISeedanceUploadIncomplete  = beefapi.ErrUploadIncomplete
	errBeefAPISeedanceUploadFormat      = errors.New("无法识别文件。图片用 PNG、JPEG、WebP、GIF、BMP 或 TIFF。视频用 MP4 或 MOV。音频用 MP3 或 WAV。")
	errBeefAPISeedanceUploadEmpty       = errors.New("参考素材为空，请重新导入")
)

const (
	BeefAPISeedanceImageMaxBytes = beefAPISeedanceImageMaxBytes
	BeefAPISeedanceVideoMaxBytes = beefAPISeedanceVideoMaxBytes
	BeefAPISeedanceUploadTimeout = beefAPISeedanceUploadTimeout
)

var (
	ErrBeefAPISeedanceUploadUnavailable = errBeefAPISeedanceUploadUnavailable
	ErrBeefAPISeedanceUploadIncomplete  = errBeefAPISeedanceUploadIncomplete
)

type BeefAPISeedanceMediaReader func(kind string, media Media) (data []byte, mime string, skip bool, err error)

type BeefAPISeedanceUploadSession = beefapi.UploadSession
type BeefAPISeedanceUploadComplete = beefapi.UploadedMedia
type BeefAPISeedanceUploadRequest = beefapi.UploadRequest
type BeefAPISeedanceMultipartPlan = beefapi.UploadPlan
type BeefAPISeedanceUploadPart = beefapi.UploadPart

// PrepareBeefAPIVideoReferences uploads built-in BeefAPI local/inline
// references through the same generation key, then rewrites each item to the
// completed HTTPS URL. PUT uses only the returned headers and known length.
// Managed uploads must finish before dispatch. Storage failures never send the
// same large bytes back through the gateway as an inline generation request.
func PrepareBeefAPIVideoReferences(ctx context.Context, config Config, input *Input, read BeefAPISeedanceMediaReader) error {
	if input == nil || (input.Mode != "" && input.Mode != "video" && input.Upscale == nil) || (!managedConnection(config) && !IsBeefAPIVideoConfig(ctx, config)) {
		return nil
	}
	runtime, _ := RuntimeFromContext(ctx)
	if read == nil {
		read = ReadBeefAPISeedanceInlineMedia
	}
	for _, group := range BeefAPISeedanceMediaGroups(input) {
		for index := range group.items {
			media := &group.items[index]
			if strings.HasPrefix(media.URL, "asset://") {
				if managedConnection(config) || requiresBeefAPIHTTPReferences(ctx, config) {
					return RequestPreparationError{Cause: errors.New("当前模型需要可访问的参考素材链接，请重新导入。本次尚未开始生成")}
				}
				continue
			}
			uploadCtx := withReferenceUpload(ctx, ReferenceUploadMeta{Kind: group.kind, Index: index + 1})
			client := managedMediaClient(uploadCtx, config)
			client.ReferenceUploaded = func(_ beefapi.LocalMediaReference, uploaded beefapi.UploadedMedia) {
				media.Bytes, media.MimeType = uploaded.Bytes, uploaded.Mime
			}
			client.InspectReference = func(_ context.Context, ref beefapi.LocalMediaReference, source io.ReaderAt, size int64, _ string) error {
				media.Bytes = size
				if group.kind == "image" && (media.Width <= 0 || media.Height <= 0) {
					if w, h, err := imageHeaderDimensions(io.NewSectionReader(source, 0, size)); err == nil {
						media.Width, media.Height = w, h
					}
				}
				if group.kind == "video" && (media.Width <= 0 || media.Height <= 0 || media.DurationMs <= 0) {
					w, h, duration := playback.ProbeVideoReader(source, size)
					if w > 0 && h > 0 {
						media.Width, media.Height = w, h
					}
					if duration > 0 {
						media.DurationMs = duration
					}
				}
				return validateSeedanceReferenceCapability(input, group.kind, index, *media, size)
			}
			if runtime.Resources == nil && read != nil {
				client.Open = func(_ context.Context, _ string) (io.ReadCloser, string, int64, error) {
					data, mime, skip, err := read(group.kind, *media)
					if err != nil {
						return nil, "", 0, err
					}
					if skip {
						return nil, "", 0, errors.New("参考素材未能读取")
					}
					return io.NopCloser(bytes.NewReader(data)), mime, int64(len(data)), nil
				}
			}
			ref := beefapi.LocalMediaReference{MediaReference: beefapi.MediaReference{Kind: group.kind, Role: referenceMediaLabel(group.kind, index), URL: media.URL}, StorageKey: media.StorageKey, DataURL: media.DataURL, MIME: media.MimeType, Bytes: media.Bytes}
			if runtime.Resources == nil && read != nil && !IsPublicMediaURL(ref.URL) && !strings.HasPrefix(firstNonEmpty(ref.DataURL, ref.URL), "data:") {
				ref.StorageKey = "legacy-reader"
			}
			if ref.StorageKey == "" && ref.DataURL == "" && ref.URL == "" {
				ref.StorageKey = "legacy-reader"
			}
			if input.VideoCapability != nil {
				switch group.kind {
				case "image":
					ref.MaxBytes = input.VideoCapability.References.MaxImageBytes
				case "video":
					ref.MaxBytes = input.VideoCapability.References.MaxVideoBytes
				case "audio":
					ref.MaxBytes = input.VideoCapability.References.MaxAudioBytes
				}
			}
			if ref.MaxBytes > 0 && ref.Bytes > ref.MaxBytes {
				return RequestPreparationError{Cause: fmt.Errorf("参考素材文件不能超过 %.0fMB", float64(ref.MaxBytes)/(1<<20))}
			}
			link, err := client.UploadReference(uploadCtx, ref)
			if err != nil {
				upload := referenceMediaUploadError(uploadCtx, err)
				if BeefAPISeedancePreuploadUnavailable(upload) {
					upload.Detail = "参考素材上传暂不可用，本次尚未开始生成。请稍后重试或使用可访问的图片链接"
				}
				return RequestPreparationError{Cause: upload}
			}
			media.URL = link
			media.DataURL = ""
			media.StorageKey = ""
		}
	}
	return nil
}

type BeefAPISeedanceMediaGroup struct {
	kind  string
	items []Media
}

func BeefAPISeedanceMediaGroups(input *Input) []BeefAPISeedanceMediaGroup {
	return []BeefAPISeedanceMediaGroup{
		{"image", input.ReferenceImages},
		{"video", input.ReferenceVideos},
		{"audio", input.ReferenceAudios},
	}
}

func SkipBeefAPISeedanceMedia(media Media) bool {
	value := strings.TrimSpace(media.URL)
	if strings.HasPrefix(value, "asset://") {
		return true
	}
	return IsPublicMediaURL(value)
}

func ReadBeefAPISeedanceInlineMedia(_ string, media Media) ([]byte, string, bool, error) {
	if SkipBeefAPISeedanceMedia(media) {
		return nil, "", true, nil
	}
	if raw := firstNonEmpty(media.DataURL, media.URL); strings.HasPrefix(strings.TrimSpace(raw), "data:") {
		mimeType, data, err := DecodeProviderDataURL(raw)
		if err != nil {
			return nil, "", false, err
		}
		return data, firstNonEmpty(media.MimeType, mimeType), false, nil
	}
	if strings.HasPrefix(media.StorageKey, "resource:") {
		return nil, "", false, errors.New("参考素材未能读取，请重新提交")
	}
	return nil, "", true, nil
}

func ownedSeedanceMediaReader(ctx context.Context, userID string) BeefAPISeedanceMediaReader {
	return func(kind string, media Media) ([]byte, string, bool, error) {
		if SkipBeefAPISeedanceMedia(media) {
			return nil, "", true, nil
		}
		if raw := firstNonEmpty(media.DataURL, media.URL); strings.HasPrefix(strings.TrimSpace(raw), "data:") {
			return ReadBeefAPISeedanceInlineMedia(kind, media)
		}
		if !strings.HasPrefix(media.StorageKey, "resource:") {
			return nil, "", true, nil
		}
		if media.Bytes > 0 {
			if err := ValidateBeefAPISeedanceMediaSize(kind, media.Bytes); err != nil {
				return nil, "", false, err
			}
		}
		runtime, ok := RuntimeFromContext(ctx)
		if !ok || runtime.Resources == nil {
			return nil, "", false, errors.New("读取任务参考资源失败：资源端口未接入")
		}
		resourceID := strings.TrimPrefix(media.StorageKey, "resource:")
		resource, body, err := runtime.Resources.Open(userID, resourceID)
		if err != nil {
			return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
		}
		defer body.Close()
		max := BeefAPISeedanceKindMaxBytes(kind)
		data, err := io.ReadAll(io.LimitReader(body, max+1))
		if err != nil {
			return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
		}
		return data, firstNonEmpty(media.MimeType, resource.MimeType), false, nil
	}
}

func validateSeedanceReferenceCapability(input *Input, kind string, index int, media Media, size int64) error {
	if input.VideoCapability == nil {
		return nil
	}
	media.Bytes = size
	refs := input.VideoCapability.References
	switch kind {
	case "image":
		return validateVideoReferenceImage(refs, index, media)
	case "video":
		return validateVideoReferenceVideo(refs, index, media)
	}
	return nil
}

func CreateBeefAPISeedanceUpload(ctx context.Context, config Config, request BeefAPISeedanceUploadRequest) (BeefAPISeedanceUploadSession, error) {
	session, err := managedMediaClient(ctx, config).CreateUpload(referenceUploadStage(ctx, "create"), request)
	if err != nil {
		return session, referenceMediaUploadError(referenceUploadStage(ctx, "create"), err)
	}
	return session, nil
}

func CompleteBeefAPISeedanceUpload(ctx context.Context, config Config, session BeefAPISeedanceUploadSession, data []byte) (BeefAPISeedanceUploadComplete, error) {
	uploaded, err := managedMediaClient(ctx, config).CompleteUpload(ctx, session, data, "参考素材")
	if err != nil {
		return uploaded, referenceMediaUploadError(ctx, err)
	}
	return uploaded, nil
}

func BeefAPISeedancePutTimeout(ctx context.Context) time.Duration {
	timeout := beefAPISeedanceUploadTimeout
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining > 0 && remaining < timeout {
			return remaining
		}
	}
	return timeout
}

func PutBeefAPISeedanceBytes(ctx context.Context, session BeefAPISeedanceUploadSession, data []byte) error {
	client := managedMediaClient(ctx, Config{})
	var dispatched bool
	var phase string
	observe := client.StorageObserve
	client.StorageObserve = func(value beefapi.UploadObservation) {
		dispatched, phase = value.Dispatched, value.Phase
		if observe != nil {
			observe(value)
		}
	}
	err := client.PutUploadBytes(ctx, session, data)
	if err != nil {
		upload := referenceUploadError(referenceUploadStage(ctx, "put"), legacyMediaError(err))
		upload.Dispatched, upload.TransportPhase = dispatched, phase
		return upload
	}
	return nil
}

func ValidateBeefAPISeedanceSession(ctx context.Context, session BeefAPISeedanceUploadSession) error {
	runtime, _ := RuntimeFromContext(ctx)
	return (&beefapi.MediaClient{AllowHTTPTest: runtime.Endpoints.BeefAPIVideoBaseURL != ""}).ValidateUploadSession(ctx, session, 0)
}

func ValidateBeefAPISeedanceSecureURL(ctx context.Context, raw string) error {
	runtime, _ := RuntimeFromContext(ctx)
	return (&beefapi.MediaClient{AllowHTTPTest: runtime.Endpoints.BeefAPIVideoBaseURL != ""}).ValidateUploadURL(ctx, raw)
}

func BeefAPISeedanceAllowInsecureTestURL(ctx context.Context, parsed *url.URL) bool {
	return parsed != nil && parsed.Scheme == "http" && beefAPITestBaseURL(ctx) != ""
}

func SkipBeefAPISeedancePutHeader(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "authorization", "proxy-authorization", "cookie", "set-cookie", "host", "content-length", "connection", "transfer-encoding", "te", "trailer", "upgrade", "x-api-key", "x-goog-api-key":
		return true
	default:
		return strings.HasPrefix(strings.ToLower(strings.TrimSpace(name)), "x-canvas-")
	}
}

func BeefAPISeedancePreuploadUnavailable(err error) bool {
	var httpErr HTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	return httpErr.StatusCode == http.StatusNotFound || httpErr.StatusCode == http.StatusNotImplemented
}

func MapBeefAPISeedanceUploadError(err error, completing bool) error {
	if err == nil {
		return nil
	}
	var upload *ReferenceUploadError
	if errors.As(err, &upload) {
		return err
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if errors.Is(err, errBeefAPISeedanceUploadRedirect) {
		return errBeefAPISeedanceUploadUnavailable
	}
	var httpErr HTTPError
	if errors.As(err, &httpErr) {
		switch httpErr.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return err
		case http.StatusServiceUnavailable, http.StatusBadGateway, http.StatusGatewayTimeout:
			return errBeefAPISeedanceUploadUnavailable
		case http.StatusBadRequest:
			if message := BeefAPISeedanceUserErrorMessage(httpErr.Body); message != "" {
				return errors.New(message)
			}
			if completing {
				return errBeefAPISeedanceUploadIncomplete
			}
			return errors.New("请检查文件类型、大小后再提交")
		}
	}
	if completing {
		return errBeefAPISeedanceUploadIncomplete
	}
	return errBeefAPISeedanceUploadUnavailable
}

func BeefAPISeedanceUserErrorMessage(body string) string {
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(body), &payload) != nil {
		return ""
	}
	message := strings.TrimSpace(payload.Error.Message)
	if message == "" {
		return ""
	}
	lower := strings.ToLower(message)
	if strings.Contains(lower, "ticket") || strings.Contains(lower, "sha256") || strings.Contains(lower, "r2") || strings.Contains(lower, "upload_url") {
		return ""
	}
	return message
}

func BeefAPISeedanceKindMaxBytes(kind string) int64 {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image":
		return beefAPISeedanceImageMaxBytes
	case "video":
		return beefAPISeedanceVideoMaxBytes
	case "audio":
		return beefAPISeedanceAudioMaxBytes
	default:
		return 0
	}
}

func ValidateBeefAPISeedanceMediaSize(kind string, size int64) error {
	if size <= 0 {
		return errBeefAPISeedanceUploadEmpty
	}
	max := BeefAPISeedanceKindMaxBytes(kind)
	if max <= 0 {
		return errBeefAPISeedanceUploadFormat
	}
	if size > max {
		switch kind {
		case "image":
			return errors.New("参考图片不能超过 30MB")
		case "video":
			return errors.New("参考视频不能超过 200MB")
		case "audio":
			return errors.New("参考音频不能超过 15MB")
		default:
			return errBeefAPISeedanceUploadFormat
		}
	}
	return nil
}

func CanonicalBeefAPISeedanceMime(kind string, declared string, data []byte) (string, error) {
	detected := detectSeedanceMediaContentType(data)
	if mime, ok := CanonicalBeefAPISeedanceDeclaredMime(kind, detected); ok {
		return mime, nil
	}
	if detected != "image/avif" && detected != "image/heic" {
		if mime, ok := CanonicalBeefAPISeedanceDeclaredMime(kind, declared); ok {
			return mime, nil
		}
	}
	return "", errBeefAPISeedanceUploadFormat
}

func detectSeedanceMediaContentType(data []byte) string {
	if len(data) >= 4 && ((data[0] == 'I' && data[1] == 'I' && data[2] == '*' && data[3] == 0) || (data[0] == 'M' && data[1] == 'M' && data[2] == 0 && data[3] == '*')) {
		return "image/tiff"
	}
	if len(data) >= 12 && string(data[4:8]) == "ftyp" {
		switch string(data[8:12]) {
		case "avif", "avis":
			return "image/avif"
		case "heic", "heix", "mif1", "msf1":
			return "image/heic"
		case "qt  ":
			return "video/quicktime"
		}
	}
	return strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
}

func CanonicalBeefAPISeedanceDeclaredMime(kind, raw string) (string, bool) {
	mime := strings.ToLower(strings.TrimSpace(raw))
	if slash := strings.IndexByte(mime, ';'); slash >= 0 {
		mime = strings.TrimSpace(mime[:slash])
	}
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image":
		switch mime {
		case "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff":
			return mime, true
		case "image/jpg", "image/pjpeg":
			return "image/jpeg", true
		case "image/x-png":
			return "image/png", true
		case "image/x-bmp":
			return "image/bmp", true
		}
	case "video":
		switch mime {
		case "video/mp4", "video/quicktime":
			return mime, true
		}
	case "audio":
		switch mime {
		case "audio/mpeg", "audio/mp3":
			return "audio/mpeg", true
		case "audio/wav", "audio/wave", "audio/x-wav":
			return "audio/wav", true
		}
	}
	return "", false
}
