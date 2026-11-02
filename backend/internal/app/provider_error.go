package app

import "qisitv/backend/internal/generation"

const contentModerationErrorCode = generation.ContentModerationErrorCode
const submissionUncertainRetryMessage = generation.SubmissionUncertainRetryMessage

func providerFailureDetails(payload map[string]any) (string, string) {
	return generation.FailureDetails(payload)
}

func providerResponseBusinessFailure(responseBody []byte) (string, string, bool) {
	return generation.ResponseBusinessFailure(responseBody)
}

func providerPayloadBusinessFailure(payload map[string]any) (string, string, bool) {
	return generation.PayloadBusinessFailure(payload)
}

func isContentModerationFailure(value string) bool {
	return generation.IsContentModerationFailure(value)
}
