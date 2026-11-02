package mediaattempt

import (
	"encoding/json"
	"errors"
	"qisitv/backend/internal/generation"
	"net/http"
	"strings"
)

// A completed input rejection ends this attempt. It does not authorize an
// automatic resend, and cannot erase an earlier accepted or uncertain request.
// Historical summaries omit replay headers and JSON job IDs; they cannot
// reconstruct this decision or unlock a task whose submission is still unknown.
func DefiniteImageInputRejection(err error) bool {
	var unknown generation.SubmissionUnknownError
	var pending generation.StatePendingError
	var upstream generation.HTTPError
	if IsImageRecoveryError(err) || errors.As(err, &unknown) || errors.As(err, &pending) || !errors.As(err, &upstream) || upstream.IdempotencyReplayed {
		return false
	}
	if upstream.StatusCode != http.StatusBadRequest && upstream.StatusCode != http.StatusUnprocessableEntity {
		return false
	}
	failure := classifyHTTP(upstream)
	if failure.Uncertain || failure.TaskID != "" || strings.Contains(upstream.Body, "upstream_task_id:") {
		return false
	}
	var body map[string]any
	if json.Unmarshal([]byte(upstream.Body), &body) == nil && imageRejectionHasJob(body, 0) {
		return false
	}
	switch failure.Category {
	case generation.CategoryInvalidParams, generation.CategoryModerationInput, generation.CategoryModerationReference,
		generation.CategoryInputTooLarge, generation.CategoryInputInaccessible, generation.CategoryContextTooLong:
		return true
	}
	return false
}

func imageRejectionHasJob(body map[string]any, depth int) bool {
	if depth > 8 {
		return true
	}
	for _, key := range []string{"id", "task_id", "taskId"} {
		if value := body[key]; value != nil && value != "" {
			return true
		}
	}
	for _, key := range []string{"data", "error", "output"} {
		if child, ok := body[key].(map[string]any); ok && imageRejectionHasJob(child, depth+1) {
			return true
		}
		if children, ok := body[key].([]any); ok && len(children) > 0 {
			return true
		}
	}
	return false
}
