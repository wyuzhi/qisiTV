package generation

import (
	"strings"
	"testing"
)

func TestReferenceUnavailablePreservesCauseInsteadOfHTTP422Fallback(t *testing.T) {
	for _, status := range []int{400, 422, 503} {
		failure := ClassifyHTTP(status, "", `{"error":{"code":"reference_unavailable","message":"首帧图片：参考图上传到 ComfyUI 失败"}}`)
		if failure.Category != CategoryInputInaccessible || !strings.Contains(failure.UserMessage(), "首帧图片：参考图上传到 ComfyUI 失败") {
			t.Fatalf("status %d lost reference cause: %+v", status, failure)
		}
		if strings.Contains(failure.UserMessage(), "尺寸") || !failure.BlocksAutomaticRetry() {
			t.Fatalf("status %d blamed parameters or enabled automatic retry: %+v", status, failure)
		}
	}
}

func TestReferenceUnavailableWithoutMessageAndUnrelatedParameterFailure(t *testing.T) {
	failure := ClassifyHTTP(422, "", `{"error":{"code":"reference_unavailable"}}`)
	if failure.Category != CategoryInputInaccessible || !strings.Contains(failure.Reason, "参考素材") {
		t.Fatalf("missing reference fallback: %+v", failure)
	}
	invalid := ClassifyHTTP(422, "", `{"error":{"code":"invalid_parameter","message":"invalid size"}}`)
	if invalid.Category != CategoryInvalidParams {
		t.Fatalf("unrelated parameter rejection changed: %+v", invalid)
	}
}
