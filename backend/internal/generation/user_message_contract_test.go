package generation_test

import (
	"strings"
	"testing"

	"qisitv/backend/internal/generation"
)

// 前端 web/src/lib/generation-error.ts 的 backendTaskFailure 直接取 task.errorCode 作类别，
// 并按「原因。下一步。排查编号：任务 X · 请求 Y」拆开 task.error。这里固定这个格式。
func TestUserMessageFormatMatchesFrontendSplit(t *testing.T) {
	categories := []generation.FailureCategory{
		generation.CategoryAuth, generation.CategoryPermission, generation.CategoryQuotaUser, generation.CategoryQuotaUpstream,
		generation.CategoryQuotaUnknown, generation.CategoryQuotaLimit, generation.CategoryModerationInput, generation.CategoryModerationReference,
		generation.CategoryModerationOutput, generation.CategoryInvalidParams, generation.CategoryLocalStorage, generation.CategoryLocalDiskFull,
		generation.CategoryLocalCredential, generation.CategoryContextTooLong, generation.CategoryInputInaccessible, generation.CategoryInputTooLarge,
		generation.CategoryModelMissing, generation.CategoryThrottled, generation.CategoryConcurrency, generation.CategoryProviderUnavailable,
		generation.CategoryNetwork, generation.CategoryRequestNotSent, generation.CategoryTimeout, generation.CategorySubmissionUncertain,
		generation.CategoryAsyncFailed, generation.CategoryCancelled, generation.CategoryPartialSuccess, generation.CategoryDownloadFailed,
		generation.CategoryDeliveryFailed, generation.CategoryResultsMissing, generation.CategoryMalformedResponse,
	}
	const ids = "排查编号：任务 task_abc123 · 请求 req_abc123"
	for _, category := range categories {
		t.Run(string(category), func(t *testing.T) {
			failure := generation.Failure{Category: category, TaskID: "task_abc123", RequestID: "req_abc123"}
			if failure.ErrorCode() != string(category) {
				t.Fatalf("ErrorCode = %q, want %q", failure.ErrorCode(), category)
			}
			message := failure.UserMessage()
			if !strings.HasSuffix(message, "。"+ids+"。") {
				t.Fatalf("message must end with the debug id sentence: %q", message)
			}
			body := strings.TrimSuffix(message, "。"+ids+"。")
			if strings.TrimSpace(strings.Split(body, "。")[0]) == "" {
				t.Fatalf("message has no reason sentence: %q", message)
			}
		})
	}

	// 具体到哪一项素材的文案同样沿用「原因。下一步。」，前端不再另行识别。
	specialized := generation.ClassifyText("第 2 个参考视频时长为 3.00 秒，需要 5–15 秒")
	if specialized.Reason == "" || strings.Contains(specialized.Reason, "。") {
		t.Fatalf("specialized reason must be a single sentence: %+v", specialized)
	}
}
