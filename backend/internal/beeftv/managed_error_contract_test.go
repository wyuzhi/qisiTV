package beeftv

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// 这些是 BeefTV 托管媒体错误合同 v1 的线上响应形状：error 内始终有 code/category/message，
// 服务端确认具体原因时另带 reason、user_message、request_id。fixture 使用合成编号。
func TestManagedMediaErrorContractWireFixtures(t *testing.T) {
	cases := []struct {
		name        string
		mediaType   string
		errorCode   string
		category    string
		message     string
		reason      string
		userMessage string
		requestID   string
		hasTaskID   bool
	}{
		{
			name: "image-failed-quota-user.json", mediaType: "image", errorCode: "media_generation_failed", category: "quota_user",
			message:     "账户余额不足，请充值后重试。当前剩余额度: ¥0.500000, 本次预计需要: ¥0.600000",
			reason:      "insufficient_user_quota",
			userMessage: "账户余额不足，请充值后重试。当前剩余额度: ¥0.500000, 本次预计需要: ¥0.600000",
			requestID:   "req_fixture_image_1",
		},
		{
			name: "image-failed-input-localized.json", mediaType: "image", errorCode: "media_generation_failed", category: "input",
			message:     "图片尺寸不符合要求，请使用 1:1 或 16:9 比例",
			reason:      "invalid_parameter",
			userMessage: "图片尺寸不符合要求，请使用 1:1 或 16:9 比例",
			requestID:   "req_fixture_image_1",
		},
		{
			name: "image-failed-input-reason.json", mediaType: "image", errorCode: "media_generation_failed", category: "input",
			message: "size is not supported", reason: "invalid_request", userMessage: "size is not supported", requestID: "req_fixture_image_1",
		},
		{
			name: "image-failed-generic.json", mediaType: "image", errorCode: "media_generation_failed", category: "authorization",
			message:   "The original media request did not return a completed result.",
			requestID: "req_fixture_image_1",
		},
		{
			name: "image-failed-task-reason.json", mediaType: "image", errorCode: "media_generation_failed", category: "upstream",
			message: "Content policy blocked the prompt", userMessage: "Content policy blocked the prompt", requestID: "original-request", hasTaskID: true,
		},
		{
			name: "video-rejected-quota-user.json", mediaType: "video", errorCode: "media_submission_rejected", category: "quota_user",
			message: "账户余额不足，请充值后重试。当前剩余额度: ＄0.500000, 本次预计需要: ＄3.000000", reason: "wallet_quota_insufficient",
			userMessage: "账户余额不足，请充值后重试。当前剩余额度: ＄0.500000, 本次预计需要: ＄3.000000", requestID: "req_fixture_video_1",
		},
		{
			name: "video-rejected-authorization.json", mediaType: "video", errorCode: "media_submission_rejected", category: "authorization",
			message: "该令牌无权使用此模型", reason: "access_denied", userMessage: "该令牌无权使用此模型", requestID: "req_fixture_video_1",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("testdata", "managed-media", tc.name))
			if err != nil {
				t.Fatal(err)
			}
			var raw struct {
				TaskRef   string          `json:"task_ref"`
				MediaType string          `json:"media_type"`
				Status    string          `json:"status"`
				Error     *MediaTaskError `json:"error"`
			}
			if err := json.Unmarshal(data, &raw); err != nil {
				t.Fatal(err)
			}
			if raw.Status != "failed" || raw.Error == nil || raw.MediaType != tc.mediaType {
				t.Fatalf("fixture shape lost: %+v", raw)
			}
			task, err := decodeMediaTask(data, raw.TaskRef, tc.mediaType)
			if err != nil {
				t.Fatal(err)
			}
			var taskErr *MediaTaskError
			if !errors.As(task.failure(), &taskErr) {
				t.Fatal("failure is not a MediaTaskError")
			}
			want := MediaTaskError{Code: tc.errorCode, Category: tc.category, Message: tc.message, Reason: tc.reason, UserMessage: tc.userMessage, RequestID: tc.requestID}
			if taskErr.Code != want.Code || taskErr.Category != want.Category || taskErr.Message != want.Message ||
				taskErr.Reason != want.Reason || taskErr.UserMessage != want.UserMessage || taskErr.RequestID != want.RequestID {
				t.Fatalf("error contract fields changed: %+v", taskErr)
			}
			if (taskErr.TaskID != "") != tc.hasTaskID {
				t.Fatalf("task identity changed: %+v", taskErr)
			}
		})
	}
}
