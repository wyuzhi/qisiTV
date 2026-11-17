package generation_test

import (
	"strings"
	"testing"

	"qisitv/backend/internal/beeftv"
	"qisitv/backend/internal/generation"
)

func TestClassifyManagedQuotaUserShowsServerSentenceWithoutGenericAction(t *testing.T) {
	failure := generation.ClassifyError(&beeftv.MediaTaskError{
		Code:        "media_generation_failed",
		Category:    "quota_user",
		Message:     "账户余额不足，请充值后重试。",
		Reason:      "insufficient_user_quota",
		UserMessage: "账户余额不足，请充值后重试。当前剩余额度: ¥0.50, 本次预计需要: ¥0.60",
		RequestID:   "req_fixture_quota_user",
	})
	if failure.Category != generation.CategoryQuotaUser || failure.ProviderCode != "insufficient_user_quota" || failure.RequestID != "req_fixture_quota_user" {
		t.Fatalf("server fields lost: %+v", failure)
	}
	message := failure.UserMessage()
	if !strings.HasPrefix(message, "账户余额不足，请充值后重试。当前剩余额度: ¥0.50, 本次预计需要: ¥0.60") {
		t.Fatalf("server sentence is not the main text: %q", message)
	}
	for _, local := range []string{"当前账号可用额度不足", "请检查账号余额，补充额度或调整令牌、套餐额度后重试"} {
		if strings.Contains(message, local) {
			t.Fatalf("local category copy leaked into server message: %q", message)
		}
	}
	if !strings.Contains(failure.ProviderMessage, "账户余额不足") || failure.ProviderMessage == message {
		t.Fatalf("provider diagnostic summary changed: %q", failure.ProviderMessage)
	}
}

func TestClassifyManagedAuthorizationWithoutUserMessageKeepsLocalCopy(t *testing.T) {
	failure := generation.ClassifyError(&beeftv.MediaTaskError{
		Code:     "media_submission_rejected",
		Category: "authorization",
		Message:  "The original media request was rejected before a task was created.",
		Reason:   "invalid_api_key",
	})
	if failure.Category != generation.CategoryAuth || failure.ProviderCode != "invalid_api_key" {
		t.Fatalf("managed category mapping changed: %+v", failure)
	}
	message := failure.UserMessage()
	if !strings.HasPrefix(message, "模型服务鉴权失败。请检查 API Key 后重试") {
		t.Fatalf("generic authorization copy changed: %q", message)
	}
}

func TestClassifyManagedOldServerGenericMessageKeepsLocalCopy(t *testing.T) {
	failure := generation.ClassifyError(&beeftv.MediaTaskError{
		Code:     "media_generation_failed",
		Category: "authorization",
		Message:  "The original media request did not return a completed result.",
	})
	if failure.Category != generation.CategoryAuth {
		t.Fatalf("category = %q", failure.Category)
	}
	if message := failure.UserMessage(); !strings.HasPrefix(message, "模型服务鉴权失败。请检查 API Key 后重试") {
		t.Fatalf("old server message changed: %q", message)
	}
}

func TestClassifyManagedUserMessageReplaysRealServerOutputs(t *testing.T) {
	for _, tc := range []struct {
		name       string
		category   string
		userText   string
		want       generation.FailureCategory
		bannedText []string
	}{
		{
			name:     "generic authorization stays v2.2.0 copy",
			category: "authorization",
			want:     generation.CategoryAuth,
		},
		{
			name:       "quota_user balance",
			category:   "quota_user",
			userText:   "账户余额不足，请充值后重试。当前剩余额度: ¥0.50, 本次预计需要: ¥0.60",
			want:       generation.CategoryQuotaUser,
			bannedText: []string{"当前账号可用额度不足"},
		},
		{
			name:       "input reference image height",
			category:   "input",
			userText:   "第 5 张参考图高度为 216 像素，需要 300–6000 像素；请调整尺寸或更换后再提交",
			want:       generation.CategoryInvalidParams,
			bannedText: []string{"模型不接受当前参数", "请检查模型、尺寸、时长、格式或数量后重试"},
		},
		{
			name:       "input localized image size",
			category:   "input",
			userText:   "图片尺寸不符合要求，请使用 1:1 或 16:9 比例",
			want:       generation.CategoryInvalidParams,
			bannedText: []string{"模型不接受当前参数", "请检查模型、尺寸、时长、格式或数量后重试"},
		},
		{
			name:       "video authorization server sentence",
			category:   "authorization",
			userText:   "该令牌无权使用此模型",
			want:       generation.CategoryAuth,
			bannedText: []string{"模型服务鉴权失败", "请检查 API Key 后重试"},
		},
		{
			name:       "upstream copyright review",
			category:   "upstream",
			userText:   "生成视频未通过上游版权审核。请调整提示词；如使用了参考素材，请检查并更换后重新生成。",
			want:       generation.CategoryAsyncFailed,
			bannedText: []string{"生成任务没有完成", "请查看详情后决定是否重试"},
		},
		{
			name:       "upstream unreadable reference",
			category:   "upstream",
			userText:   "参考素材无法被上游读取或链接已失效，本次未扣费，请重新上传该素材后重试",
			want:       generation.CategoryAsyncFailed,
			bannedText: []string{"生成任务没有完成", "请查看详情后决定是否重试"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			failure := generation.ClassifyError(&beeftv.MediaTaskError{
				Code:        "media_generation_failed",
				Category:    tc.category,
				Message:     "The original media request did not return a completed result.",
				UserMessage: tc.userText,
			})
			if failure.Category != tc.want {
				t.Fatalf("category = %q, want %q", failure.Category, tc.want)
			}
			if tc.userText == "" {
				if !strings.HasPrefix(failure.UserMessage(), "模型服务鉴权失败。请检查 API Key 后重试") {
					t.Fatalf("generic fallback changed: %q", failure.UserMessage())
				}
				return
			}
			if message := failure.UserMessage(); message != tc.userText {
				t.Fatalf("server sentence not rendered verbatim: %q", message)
			}
			for _, banned := range tc.bannedText {
				if strings.Contains(failure.UserMessage(), banned) {
					t.Fatalf("local action appended to server reason: %q", failure.UserMessage())
				}
			}
		})
	}
}

func TestPersistedFailureRetryUsesSavedCategoryBeforeText(t *testing.T) {
	// The saved category decides, even when the server sentence reads like another category.
	if generation.PersistedFailureBlocksRetry("账户余额不足，请稍后重试", "生成失败", string(generation.CategoryThrottled)) {
		t.Fatal("a saved throttled failure must stay retryable")
	}
	if !generation.PersistedFailureBlocksRetry("请求过于频繁", "生成失败", string(generation.CategoryQuotaUser)) {
		t.Fatal("a saved quota_user failure must not be retried as is")
	}
	if got := generation.PersistedFailure("请求过于频繁", string(generation.CategoryQuotaUser)).Category; got != generation.CategoryQuotaUser {
		t.Fatalf("saved category = %q", got)
	}
	// Legacy rows without a saved category, or with no text, keep classifying the text.
	if got, want := generation.PersistedFailure("请求过于频繁", "").Category, generation.ClassifyText("请求过于频繁").Category; got != want {
		t.Fatalf("legacy category = %q, want %q", got, want)
	}
	if got := generation.PersistedFailure("", string(generation.CategoryQuotaUser)).Category; got != generation.CategoryUnknown {
		t.Fatalf("empty text must not carry a saved category, got %q", got)
	}
	if got := generation.PersistedFailure("账户余额不足，请充值后重试", string(generation.CategoryUnknown)).Category; got != generation.CategoryUnknown {
		t.Fatalf("a saved unknown must not be reclassified from text, got %q", got)
	}
	// Stage facts still win over a saved category.
	if !generation.PersistedFailureBlocksRetry("x", "submission_unknown", string(generation.CategoryThrottled)) {
		t.Fatal("submission_unknown must block retry")
	}
	if generation.PersistedFailureBlocksRetry("x", "请求尚未提交", string(generation.CategoryQuotaUser)) {
		t.Fatal("a request that was never sent must stay retryable")
	}
}

func TestClassifyManagedPendingKeepsUncertaintyOverUserMessage(t *testing.T) {
	failure := generation.ClassifyError(&beeftv.MediaTaskError{
		Code: "media_result_unknown", Category: "unknown", Message: "pending",
		UserMessage: "账户余额不足，请充值后重试。",
	})
	if failure.Category != generation.CategorySubmissionUncertain || !failure.Uncertain {
		t.Fatalf("pending failure lost uncertainty: %+v", failure)
	}
	if message := failure.UserMessage(); !strings.Contains(message, "尚未确认") {
		t.Fatalf("uncertain copy lost: %q", message)
	}
}
