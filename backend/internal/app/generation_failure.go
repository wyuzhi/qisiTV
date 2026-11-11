package app

import "infinite-canvas/backend/internal/generation"

func classifyProviderHTTP(err providerHTTPError) generation.Failure {
	return generation.ClassifyHTTP(err.StatusCode, err.Status, err.Body)
}

func classifyTaskFailure(err error) generation.Failure {
	return generation.ClassifyTaskFailure(err)
}

func persistableTaskFailureMessage(err error) string {
	return generation.PersistableTaskFailureMessage(err)
}

func taskFailureErrorCode(err error) string {
	return generation.TaskFailureErrorCode(err)
}

func persistedFailureErrorCode(message string, stage string) string {
	return generation.PersistedFailureErrorCode(message, stage)
}

func persistedFailureBlocksRetry(message string, stage string) bool {
	return generation.PersistedFailureBlocksRetry(message, stage)
}

func (s *Service) UserFacingProviderHTTPError(status int, statusText string, body string) string {
	message := generation.ClassifyHTTP(status, statusText, body).UserMessage()
	if s == nil {
		return message
	}
	return s.InterceptResponseText(message)
}
