package app

import (
	"errors"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/kernel"
)

func classifyProviderHTTP(err providerHTTPError) generation.Failure {
	return generation.ClassifyHTTP(err.StatusCode, err.Status, err.Body)
}

func classifyTaskFailure(err error) generation.Failure {
	if err == nil {
		return generation.ClassifyError(nil)
	}
	var httpErr providerHTTPError
	if errors.As(err, &httpErr) {
		failure := classifyProviderHTTP(httpErr)
		return applyAppFailureWrappers(err, failure)
	}
	var payload providerPayloadError
	if errors.As(err, &payload) {
		failure := generation.ClassifyText(firstNonEmpty(payload.raw, payload.message))
		return applyAppFailureWrappers(err, failure)
	}
	var decode providerResponseDecodeError
	if errors.As(err, &decode) {
		failure := generation.ClassifyError(decode.Err)
		if failure.Category == generation.CategoryUnknown {
			failure = generation.ClassifyText(decode.Error())
		}
		if failure.Category == generation.CategoryUnknown {
			failure.Category = generation.CategoryMalformedResponse
			failure.Reason = ""
			failure.Action = ""
		}
		return applyAppFailureWrappers(err, failure)
	}
	return applyAppFailureWrappers(err, generation.ClassifyError(err))
}

func applyAppFailureWrappers(err error, failure generation.Failure) generation.Failure {
	var download videoDownloadError
	if errors.As(err, &download) {
		failure = generation.WithDownloadFailure(failure, download.TaskID)
	}
	var pending providerStatePendingError
	if errors.As(err, &pending) {
		failure.Category = generation.CategorySubmissionUncertain
		failure.Uncertain = true
		failure.TaskID = firstNonEmpty(failure.TaskID, pending.TaskID)
		failure.Reason = ""
		failure.Action = ""
	}
	var circuit providerCircuitOpenError
	if errors.As(err, &circuit) {
		return generation.CircuitOpenFailure()
	}
	if code, _ := ChannelSlotFailureDetails(err); code != "" {
		failure = generation.WithConcurrencyFailure(failure)
	}
	var appErr *kernel.AppError
	if errors.As(err, &appErr) && appErr != nil {
		classified := generation.ClassifyAppError(appErr.Status, appErr.Code, string(appErr.Reason), appErr.Message)
		if failure.Category == generation.CategoryUnknown || classified.Category != generation.CategoryUnknown {
			failure = classified
		}
	}
	return failure
}

func persistableTaskFailureMessage(err error) string {
	return classifyTaskFailure(err).UserMessage()
}

func taskFailureErrorCode(err error) string {
	return classifyTaskFailure(err).ErrorCode()
}

func persistedFailureErrorCode(message string, stage string) string {
	failure := generation.ClassifyText(message)
	if stage == "submission_unknown" {
		return string(generation.CategorySubmissionUncertain)
	}
	return failure.ErrorCode()
}

func persistedFailureBlocksRetry(message string, stage string) bool {
	if stage == "submission_unknown" {
		return true
	}
	return generation.ClassifyText(message).BlocksAutomaticRetry()
}

func (s *Service) UserFacingProviderHTTPError(status int, statusText string, body string) string {
	message := generation.ClassifyHTTP(status, statusText, body).UserMessage()
	if s == nil {
		return message
	}
	return s.InterceptResponseText(message)
}
