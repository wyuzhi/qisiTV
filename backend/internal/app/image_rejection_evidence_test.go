package app

import (
	"errors"
	"testing"

	"qisitv/backend/internal/generation"
)

func TestCompleteHTTPRejectionEvidence(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		rejected bool
	}{
		{"input-moderation", providerHTTPError{StatusCode: 400, Body: `{"error":{"code":"InputTextSensitiveContentDetected","message":"The request failed because the input text may contain sensitive information."}}`}, true},
		{"invalid-params", providerHTTPError{StatusCode: 400, Body: `{"error":{"message":"invalid size"}}`}, true},
		{"unprocessable-input", providerHTTPError{StatusCode: 422, Body: `{"error":{"code":"invalid_request"}}`}, true},
		{"response-lost", generation.SubmissionUnknownError{Cause: providerHTTPError{StatusCode: 400}}, false},
		{"recovery", imageRecoveryError{providerHTTPError{StatusCode: 400}}, false},
		{"transport-text", errors.New("HTTP 400"), false},
		{"pending", providerHTTPError{StatusCode: 400, Body: `{"error":{"code":"image_submission_pending"}}`}, false},
		{"task-created", providerHTTPError{StatusCode: 400, Body: `{"task_id":"existing-task","error":{"code":"invalid_request"}}`}, false},
		{"id-created", providerHTTPError{StatusCode: 400, Body: `{"id":"existing-task","error":{"code":"invalid_request"}}`}, false},
		{"nested-id-created", providerHTTPError{StatusCode: 400, Body: `{"data":{"id":"existing-task"},"error":{"code":"invalid_request"}}`}, false},
		{"supplier-task", providerHTTPError{StatusCode: 400, Body: `{"error":{"code":"vod_image_invalid_params","message":"bad input (upstream_task_id: accepted-task)"}}`}, false},
		{"output-moderation", providerHTTPError{StatusCode: 400, Body: `{"error":{"code":"OutputImageSensitiveContentDetected"}}`}, false},
		{"replayed", providerHTTPError{StatusCode: 400, IdempotencyReplayed: true}, false},
		{"timeout", providerHTTPError{StatusCode: 408}, false},
		{"conflict", providerHTTPError{StatusCode: 409}, false},
		{"expired", providerHTTPError{StatusCode: 410}, false},
		{"server-error", providerHTTPError{StatusCode: 500}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := definiteImageInputRejection(tc.err); got != tc.rejected {
				t.Fatalf("rejection=%v want=%v", got, tc.rejected)
			}
		})
	}
}
