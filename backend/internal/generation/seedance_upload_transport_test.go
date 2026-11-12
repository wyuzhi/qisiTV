package generation

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"qisitv/backend/internal/beeftv"
	"qisitv/backend/internal/model"
)

func TestReferenceUploadGateway4xxKeepsRequestIDAndCategory(t *testing.T) {
	for _, stage := range []string{"create", "complete"} {
		for _, status := range []int{400, 401, 402, 403} {
			t.Run(stage+http.StatusText(status), func(t *testing.T) {
				cause := HTTPError{StatusCode: status}
				err := &ReferenceUploadError{Meta: ReferenceUploadMeta{Kind: "image", Index: 1, Stage: stage}, HTTPStatus: status, RequestID: "gateway-request-123456", Cause: cause}
				failure := ClassifyError(err)
				if failure.Category != ClassifyError(cause).Category || failure.HTTPStatus != status || failure.RequestID != err.RequestID || failure.Uncertain || !failure.BlocksAutomaticRetry() {
					t.Fatalf("lost gateway classification or upload request ID: %+v", failure)
				}
			})
		}
	}
}

func TestReferenceUploadTLSDeadlineIsRecordedBeforeGeneration(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	// The deadline measures the stalled TLS handshake, not system proxy lookup.
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("NO_PROXY", "*")
	address, closeServer := stalledTLS(t)
	defer closeServer()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	receipts := &recordingReceipts{}
	ctx = WithRuntime(ctx, Runtime{Receipts: receipts, Endpoints: Endpoints{BeefTVVideoBaseURL: address}})
	ctx = withReferenceUpload(ctx, ReferenceUploadMeta{Kind: "image", Index: 2})
	err := PutBeefTVSeedanceBytes(ctx, BeefTVSeedanceUploadSession{UploadURL: address + "/?X-Amz-Signature=PRIVATE"}, []byte("owned-fixture"))
	var upload *ReferenceUploadError
	if !errors.As(err, &upload) || !errors.Is(err, context.DeadlineExceeded) || upload.Meta.Index != 2 || strings.Contains(err.Error(), "PRIVATE") {
		t.Fatalf("upload cause lost or unsafe: %v", err)
	}
	seen := receipts.snapshot()
	if len(seen) != 1 || seen[0].Dispatched || seen[0].TransportPhase != "tls" || seen[0].TransportRoute != "direct" || len(seen[0].Body) != 0 {
		t.Fatalf("missing safe PUT receipt: %+v", seen)
	}
	if call, _ := CallMetaFromContext(seen[0].Request.Context()); call.RequestKind != "reference_put" {
		t.Fatalf("storage upload counted as model creation: %+v", call)
	}
	failure := ClassifyError(err)
	if failure.Uncertain || failure.BlocksManualRetry() || !failure.BlocksAutomaticRetry() || failure.ProviderCode != "reference_preupload_failed" {
		t.Fatalf("upload timeout confused with paid generation: %+v", failure)
	}
}

func TestReferenceUpload400PrependsReferenceIndexAndSupportsTIFF(t *testing.T) {
	mime, err := CanonicalBeefTVSeedanceMime("image", "application/octet-stream", []byte{'I', 'I', '*', 0, 8, 0, 0, 0})
	if err != nil || mime != "image/tiff" {
		t.Fatalf("TIFF detection = %q, %v", mime, err)
	}
	if _, err := CanonicalBeefTVSeedanceMime("image", "image/png", []byte{0, 0, 0, 28, 'f', 't', 'y', 'p', 'a', 'v', 'i', 'f'}); err == nil {
		t.Fatal("raw AVIF masquerading as image/png was accepted without conversion")
	}
	cause := HTTPError{
		StatusCode: 400,
		Body:       `{"error":{"code":"invalid_media_format","message":"无法识别文件。图片用 PNG、JPEG、WebP、GIF、BMP 或 TIFF。视频用 MP4 或 MOV。音频用 MP3 或 WAV。"}}`,
	}
	uploadErr := &ReferenceUploadError{
		Meta:       ReferenceUploadMeta{Kind: "image", Index: 3, Stage: "complete"},
		HTTPStatus: 400,
		RequestID:  "req-ref-3",
		Cause:      cause,
	}
	failure := ClassifyError(uploadErr)
	if failure.Reason != "参考图片 3：无法识别文件" || failure.Action != "图片用 PNG、JPEG、WebP、GIF、BMP 或 TIFF。视频用 MP4 或 MOV。音频用 MP3 或 WAV" || !strings.HasPrefix(failure.ProviderMessage, "参考图片 3：无法识别文件") {
		t.Fatalf("reason=%q action=%q message=%q, want server passthrough with 参考图片 3：", failure.Reason, failure.Action, failure.ProviderMessage)
	}
}

type stubManagedMediaState struct{}

func (stubManagedMediaState) Sent(context.Context) (bool, error) { return false, nil }
func (stubManagedMediaState) Begin(*http.Request) (bool, error)  { return false, nil }

func TestManagedMediaUpload400PreservesReferenceAudioIndexAndServerMessage(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			w.Header().Set(beeftv.MediaProtocolHeader, beeftv.MediaProtocolVersion)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"media_protocol":{"version":"managed-media-v1","supported_media_types":["video"],"task_submit_url":"/v1/media/tasks","task_query_url_template":"/v1/media/tasks/{task_ref}","uploads_url":"/v1/media/uploads"},"data":[]}`))
		case "/v1/media/uploads":
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Request-Id", "req-upload-audio-1")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"无法识别文件。图片用 PNG、JPEG、WebP、GIF、BMP 或 TIFF。视频用 MP4 或 MOV。音频用 MP3 或 WAV。","type":"video_reference_upload_invalid","code":"video_reference_upload_invalid"}}`))
		default:
			t.Fatalf("unexpected request path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	receipts := &recordingReceipts{}
	ctx := WithRuntime(context.Background(), Runtime{
		ManagedMedia: stubManagedMediaState{},
		Receipts:     receipts,
		Endpoints:    Endpoints{BeefTVVideoBaseURL: server.URL},
	})
	client := managedMediaClient(ctx, Config{BaseURL: server.URL, APIKey: "test-key"})
	request := beeftv.MediaRequest{TaskRef: "task-ref-upload-audio", MediaType: "video", Model: "video-test-model", Operation: "reference_to_video"}
	refs := []beeftv.LocalMediaReference{
		{MediaReference: beeftv.MediaReference{Kind: "image", Role: "reference", URL: server.URL + "/ref-1.png"}},
		{MediaReference: beeftv.MediaReference{Kind: "image", Role: "reference", URL: server.URL + "/ref-2.png"}},
		{MediaReference: beeftv.MediaReference{Kind: "audio", Role: "reference"}, DataURL: "data:audio/mp4;base64,AAAAIGZ0eXBNNEEg"},
	}

	_, err := executeManagedMedia(ctx, client, request, refs)
	if !SafeRouteRejection(err) {
		t.Fatalf("expected pre-submission route rejection, got %#v", err)
	}
	failure := ClassifyError(err)
	if failure.Category != CategoryInvalidParams || failure.Uncertain || !failure.BlocksAutomaticRetry() {
		t.Fatalf("unexpected failure classification: %+v", failure)
	}
	if failure.Reason != "参考音频 1：无法识别文件" || !strings.Contains(failure.Action, "音频用 MP3 或 WAV") || failure.RequestID != "req-upload-audio-1" {
		t.Fatalf("upload 400 passthrough mismatch: %+v", failure)
	}
	task := &model.Task{Stage: "准备中"}
	CaptureTaskFailureDiagnostics(task, err, "provider_request")
	if task.FailureDiagnostics == nil || task.FailureDiagnostics.Source != "reference_upload" {
		t.Fatalf("diagnostics = %+v, want source reference_upload", task.FailureDiagnostics)
	}
	persisted := ClassifyText(failure.UserMessage())
	if persisted.Category != CategoryInvalidParams || persisted.Reason != failure.Reason || persisted.Action != failure.Action || persisted.RequestID != failure.RequestID {
		t.Fatalf("persisted round-trip mismatch: %+v -> %+v", failure, persisted)
	}
}

func TestServerChineseReferenceCountAndRequestIDSuffixPassthrough(t *testing.T) {
	raw := `{"error":{"message":"当前模型最多支持 9 个参考图片，请减少参考图片（本次传入 10 个）后再提交 (请求编号: req_ref_count_10)","type":"invalid_request_error","code":"invalid_video_parameters"}}`
	failure := ClassifyHTTP(http.StatusBadRequest, "400 Bad Request", raw)
	if failure.Category != CategoryInvalidParams || !failure.FromCode || failure.RequestID != "req_ref_count_10" {
		t.Fatalf("unexpected classification: %+v", failure)
	}
	if failure.Reason != "当前模型最多支持 9 个参考图片" || failure.Action != "请减少参考图片（本次传入 10 个）后再提交" {
		t.Fatalf("unexpected copy: reason=%q action=%q", failure.Reason, failure.Action)
	}
	if strings.Contains(failure.UserMessage(), "请求编号:") {
		t.Fatalf("duplicate raw request ID suffix remained in UserMessage: %q", failure.UserMessage())
	}
	persisted := ClassifyText(failure.UserMessage())
	if persisted.Category != CategoryInvalidParams || persisted.Reason != failure.Reason || persisted.Action != failure.Action || persisted.RequestID != "req_ref_count_10" {
		t.Fatalf("persisted round-trip mismatch: %+v -> %+v", failure, persisted)
	}

	futureServerCopy := ClassifyHTTP(http.StatusBadRequest, "400 Bad Request", `{"error":{"message":"当前模型不支持同时传入首尾帧和参考音频，请移除其一后再提交","type":"invalid_request_error","code":"invalid_video_parameters"}} (请求编号: req_outer_zh_888)`)
	if futureServerCopy.Category != CategoryInvalidParams || futureServerCopy.Reason != "当前模型不支持同时传入首尾帧和参考音频" || futureServerCopy.Action != "请移除其一后再提交" || futureServerCopy.RequestID != "req_outer_zh_888" {
		t.Fatalf("unmatched server Chinese 400 message was not passed through: %+v", futureServerCopy)
	}
	reloadedFuture := ClassifyText(futureServerCopy.UserMessage())
	if reloadedFuture.Category != CategoryInvalidParams || reloadedFuture.Reason != futureServerCopy.Reason || reloadedFuture.Action != futureServerCopy.Action || reloadedFuture.RequestID != "req_outer_zh_888" {
		t.Fatalf("persisted future Chinese 400 copy lost category or fields: %+v -> %+v", futureServerCopy, reloadedFuture)
	}
	if code := PersistedFailureErrorCode(futureServerCopy.UserMessage(), "provider_request"); code != string(CategoryInvalidParams) {
		t.Fatalf("PersistedFailureErrorCode = %q, want %q", code, CategoryInvalidParams)
	}

	// Both code-level invalid_request_error and OpenAI type wrapper must defer to non-400/409/422 HTTP statuses.
	for _, body := range []string{
		`{"error":{"code":"invalid_request_error","message":"当前服务繁忙，请稍后再试"}}`,
		`{"error":{"type":"invalid_request_error","code":"custom_gateway_code","message":"当前服务繁忙，请稍后再试"}}`,
	} {
		busy503 := ClassifyHTTP(http.StatusServiceUnavailable, "503 Service Unavailable", body)
		if busy503.Category != CategoryProviderUnavailable || !busy503.Retryable {
			t.Fatalf("HTTP 503 generic wrapper %s misclassified: %+v", body, busy503)
		}
	}
	perm403 := ClassifyHTTP(http.StatusForbidden, "403 Forbidden", `{"error":{"code":"invalid_request_error","message":"当前账号暂无权限使用该模型，请联系管理员"}}`)
	if perm403.Category != CategoryPermission || perm403.Retryable {
		t.Fatalf("HTTP 403 generic invalid_request_error misclassified: %+v", perm403)
	}

	// Transient and generic Chinese strings must not be promoted to invalid_params.
	for _, transient := range []string{"当前模型服务暂时不可用，请稍后重试", "生成失败，请重试", "生成失败，请调整后重试", "请求频率过高，请调整请求时间后重试"} {
		if got := ClassifyText(transient); got.Category == CategoryInvalidParams {
			t.Fatalf("transient/generic Chinese text %q promoted to invalid_params: %+v", transient, got)
		}
	}

	// Structured JSON terminal messages retain their terminal category under HTTP 400 (with or without generic invalid_request_error code/type).
	for body, want := range map[string]FailureCategory{
		`{"error":{"message":"视频结果下载失败，请稍后重试"}}`:                                 CategoryDownloadFailed,
		`{"error":{"code":"invalid_request_error","message":"视频结果下载失败，请稍后重试"}}`:  CategoryDownloadFailed,
		`{"error":{"type":"invalid_request_error","message":"接口没有返回图片"}}`:        CategoryResultsMissing,
		`{"error":{"code":"invalid_request_error","message":"failed to fetch"}}`: CategoryNetwork,
		`{"error":{"type":"invalid_request_error","message":"任务已取消"}}`:           CategoryCancelled,
	} {
		if got := ClassifyHTTP(http.StatusBadRequest, "400 Bad Request", body); got.Category != want {
			t.Fatalf("structured terminal message %s = %+v, want %s", body, got, want)
		}
	}

	// Untrusted HTTP statuses (e.g. 503/403) still win over non-authoritative terminal message wrappers, while declared invalid_request stays authoritative.
	if got := ClassifyHTTP(http.StatusServiceUnavailable, "503 Service Unavailable", `{"error":{"code":"invalid_request_error","message":"视频结果下载失败，请稍后重试"}}`); got.Category != CategoryProviderUnavailable {
		t.Fatalf("HTTP 503 generic wrapper with terminal message = %+v, want provider_unavailable", got)
	}
	if got := ClassifyHTTP(http.StatusForbidden, "403 Forbidden", `{"error":{"code":"invalid_request_error","message":"failed to fetch"}}`); got.Category != CategoryPermission {
		t.Fatalf("HTTP 403 generic wrapper with terminal message = %+v, want permission", got)
	}
	if got := ClassifyHTTP(http.StatusBadRequest, "400 Bad Request", `{"error":{"code":"invalid_request","message":"视频结果下载失败，请稍后重试"}}`); got.Category != CategoryInvalidParams || !got.FromCode {
		t.Fatalf("declared invalid_request code refined by terminal message: %+v", got)
	}

	// Container local paths must not pass through userFacingChineseCopy.
	leakedPath := ClassifyHTTP(http.StatusBadRequest, "400 Bad Request", `{"error":{"code":"invalid_video_parameters","message":"读取文件 /app/uploads/customer-secret.png 失败"}}`)
	if strings.Contains(leakedPath.UserMessage(), "/app/") || strings.Contains(leakedPath.UserMessage(), "customer-secret") || strings.Contains(leakedPath.UserMessage(), "[路径已隐藏]") {
		t.Fatalf("container path leaked into UserMessage: %+v (%q)", leakedPath, leakedPath.UserMessage())
	}
}

func TestManagedMediaUpload5xxAndPutFailuresStayNonPaidPreupload(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, tc := range []struct {
		name         string
		createStatus int
		putStatus    int
	}{
		{name: "create_503", createStatus: http.StatusServiceUnavailable},
		{name: "put_500", createStatus: http.StatusOK, putStatus: http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var serverURL string
			var putAttempts int
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/models":
					w.Header().Set(beeftv.MediaProtocolHeader, beeftv.MediaProtocolVersion)
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"media_protocol":{"version":"managed-media-v1","supported_media_types":["video"],"task_submit_url":"/v1/media/tasks","task_query_url_template":"/v1/media/tasks/{task_ref}","uploads_url":"/v1/media/uploads"},"data":[]}`))
				case "/v1/media/uploads":
					w.Header().Set("Content-Type", "application/json")
					w.Header().Set("X-Request-Id", "req-upload-5xx-1")
					if tc.createStatus != http.StatusOK {
						w.WriteHeader(tc.createStatus)
						_, _ = w.Write([]byte(`{"error":{"message":"upload storage temporarily unavailable","code":"video_reference_upload_unavailable"}}`))
						return
					}
					_, _ = w.Write([]byte(`{"ticket":"upl_ticket_1","upload_url":"` + serverURL + `/put-part","upload_method":"PUT"}`))
				case "/put-part":
					putAttempts++
					w.WriteHeader(tc.putStatus)
					_, _ = w.Write([]byte(`<Error><Code>InternalError</Code></Error>`))
				case "/v1/media/uploads/complete":
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusBadRequest)
					_, _ = w.Write([]byte(`{"error":{"message":"upload incomplete","code":"video_reference_upload_incomplete"}}`))
				default:
					t.Fatalf("unexpected request path: %s", r.URL.Path)
				}
			}))
			serverURL = server.URL
			defer server.Close()

			ctx := WithRuntime(context.Background(), Runtime{
				ManagedMedia: stubManagedMediaState{},
				Receipts:     &recordingReceipts{},
				Endpoints:    Endpoints{BeefTVVideoBaseURL: server.URL},
			})
			client := managedMediaClient(ctx, Config{BaseURL: server.URL, APIKey: "test-key"})
			client.AllowHTTPTest = true
			request := beeftv.MediaRequest{TaskRef: "task-ref-upload-5xx", MediaType: "video", Model: "video-test-model", Operation: "reference_to_video"}
			refs := []beeftv.LocalMediaReference{
				{MediaReference: beeftv.MediaReference{Kind: "audio", Role: "reference"}, DataURL: "data:audio/mpeg;base64,SUQzBAAAAAA="},
			}

			_, err := executeManagedMedia(ctx, client, request, refs)
			if !SafeRouteRejection(err) {
				t.Fatalf("expected pre-submission route rejection, got %#v", err)
			}
			var uploadErr *ReferenceUploadError
			if !errors.As(err, &uploadErr) {
				t.Fatalf("expected *ReferenceUploadError, got %#v", err)
			}
			if tc.putStatus != 0 && (putAttempts < 2 || uploadErr.Meta.Stage != "put" || uploadErr.HTTPStatus != tc.putStatus) {
				t.Fatalf("put_500 did not surface PUT-stage 500 error: attempts=%d meta=%+v status=%d", putAttempts, uploadErr.Meta, uploadErr.HTTPStatus)
			}
			failure := ClassifyError(err)
			if failure.Category != CategoryProviderUnavailable || failure.Uncertain || failure.ProviderCode != "reference_preupload_failed" || !failure.BlocksAutomaticRetry() || failure.BlocksManualRetry() {
				t.Fatalf("unexpected preupload failure classification: %+v", failure)
			}
		})
	}
}
