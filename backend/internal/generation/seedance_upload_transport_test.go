package generation

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
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
	address, closeServer := stalledTLS(t)
	defer closeServer()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	receipts := &recordingReceipts{}
	ctx = WithRuntime(ctx, Runtime{Receipts: receipts, Endpoints: Endpoints{BeefAPIVideoBaseURL: address}})
	ctx = withReferenceUpload(ctx, ReferenceUploadMeta{Kind: "image", Index: 2})
	err := PutBeefAPISeedanceBytes(ctx, BeefAPISeedanceUploadSession{UploadURL: address + "/?X-Amz-Signature=PRIVATE"}, []byte("owned-fixture"))
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
	mime, err := CanonicalBeefAPISeedanceMime("image", "application/octet-stream", []byte{'I', 'I', '*', 0, 8, 0, 0, 0})
	if err != nil || mime != "image/tiff" {
		t.Fatalf("TIFF detection = %q, %v", mime, err)
	}
	if _, err := CanonicalBeefAPISeedanceMime("image", "image/png", []byte{0, 0, 0, 28, 'f', 't', 'y', 'p', 'a', 'v', 'i', 'f'}); err == nil {
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
	if !strings.HasPrefix(failure.Reason, "参考图片 3：") || !strings.HasPrefix(failure.ProviderMessage, "参考图片 3：无法识别文件") {
		t.Fatalf("reason=%q message=%q, want prefix 参考图片 3：", failure.Reason, failure.ProviderMessage)
	}
}
