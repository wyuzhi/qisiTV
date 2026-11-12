package generation

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"

	"qisitv/backend/internal/model"
)

func EnrichAPICallLog(logEntry *model.ApiCallLog, responseBody []byte) {
	if logEntry == nil {
		return
	}
	if logEntry.ProviderRequestID == "" {
		logEntry.ProviderRequestID = ProviderRequestIDFromPath(logEntry.Path)
	}
	for _, payload := range ProviderResponsePayloads(responseBody) {
		enrichAPICallLogPayload(logEntry, payload)
	}
	enrichAPICallLogFailureSummary(logEntry, responseBody)
}

func enrichAPICallLogFailureSummary(logEntry *model.ApiCallLog, responseBody []byte) {
	if logEntry.Status != model.ApiCallStatusFailed {
		return
	}
	failure := ClassifyHTTP(logEntry.StatusCode, "", string(responseBody))
	logEntry.ErrorCode = firstNonEmpty(failure.ProviderCode, failure.ErrorCode())
	logEntry.Error = failure.UserMessage()
}

func enrichAPICallLogPayload(logEntry *model.ApiCallLog, payload map[string]any) {
	nestedTaskID := ""
	if data, ok := payload["data"].(map[string]any); ok {
		if logEntry.Capability == "video" && strings.Contains(logEntry.Path, "/v1/video/generations") {
			if extracted, err := firstJSONString(data, "task_id", "taskId"); err == nil {
				nestedTaskID = extracted
			}
		}
		for key, value := range data {
			if _, exists := payload[key]; !exists {
				payload[key] = value
			}
		}
	}
	if response, ok := payload["response"].(map[string]any); ok {
		for key, value := range response {
			if _, exists := payload[key]; !exists {
				payload[key] = value
			}
		}
	}
	if logEntry.Status == model.ApiCallStatusFailed {
		errorCode, errorMessage := FailureDetails(payload)
		logEntry.ErrorCode = errorCode
		if errorMessage != "" {
			logEntry.Error = errorMessage
		}
	}
	if usage, ok := payload["usage"].(map[string]any); ok {
		inputTokens, inputAvailable := firstInt64Value(usage, "input_tokens", "prompt_tokens")
		outputTokens, outputAvailable := firstInt64Value(usage, "output_tokens", "completion_tokens")
		if inputAvailable {
			logEntry.InputTokens = inputTokens
		}
		if outputAvailable {
			logEntry.OutputTokens = outputTokens
		}
		if inputAvailable || outputAvailable {
			logEntry.UsageAvailable = true
		}
		if logEntry.Capability == "video" && strings.Contains(logEntry.Path, "/contents/generations/tasks") {
			if logEntry.OutputTokens == 0 {
				logEntry.OutputTokens = firstInt64(usage, "total_tokens")
			}
			logEntry.UsageAvailable = logEntry.OutputTokens > 0
		}
		if details, ok := usage["input_tokens_details"].(map[string]any); ok {
			logEntry.CachedTokens = firstInt64(details, "cached_tokens", "cache_read_input_tokens")
		}
		if details, ok := usage["prompt_tokens_details"].(map[string]any); ok && logEntry.CachedTokens == 0 {
			logEntry.CachedTokens = firstInt64(details, "cached_tokens", "cache_read_input_tokens")
		}
		if logEntry.CachedTokens == 0 {
			logEntry.CachedTokens = firstInt64(usage, "cached_tokens", "cache_read_input_tokens", "prompt_cache_hit_tokens")
		}
	}
	if usage, ok := payload["usageMetadata"].(map[string]any); ok {
		inputTokens, inputAvailable := firstInt64Value(usage, "promptTokenCount")
		outputTokens, outputAvailable := firstInt64Value(usage, "candidatesTokenCount")
		if inputAvailable {
			logEntry.InputTokens = inputTokens
		}
		if outputAvailable {
			logEntry.OutputTokens = outputTokens
		}
		if inputAvailable || outputAvailable {
			logEntry.UsageAvailable = true
		}
		logEntry.CachedTokens = firstInt64(usage, "cachedContentTokenCount")
	}
	logEntry.ProviderStatus = strings.ToLower(firstNonEmpty(stringField(payload, "status"), logEntry.ProviderStatus))
	if logEntry.ProviderStatus == "failed" || logEntry.ProviderStatus == "cancelled" || logEntry.ProviderStatus == "expired" {
		logEntry.Status = model.ApiCallStatusFailed
		errorCode, errorMessage := FailureDetails(payload)
		logEntry.ErrorCode = firstNonEmpty(errorCode, logEntry.ErrorCode)
		logEntry.Error = firstNonEmpty(errorMessage, logEntry.Error)
	}
	failedCreate := logEntry.Status == model.ApiCallStatusFailed && (logEntry.RequestKind == "" || logEntry.RequestKind == "create")
	if !failedCreate {
		if extracted, err := firstJSONString(payload, "task_id", "taskId", "id", "request_id", "requestId", "name"); err == nil {
			logEntry.ProviderRequestID = firstNonEmpty(nestedTaskID, extracted, logEntry.ProviderRequestID)
		} else {
			logEntry.ProviderRequestID = firstNonEmpty(nestedTaskID, logEntry.ProviderRequestID)
		}
	}
	if logEntry.Capability == "image" {
		if data, ok := payload["data"].([]any); ok {
			logEntry.MediaCount = len(data)
		} else if images, ok := payload["images"].([]any); ok {
			logEntry.MediaCount = len(images)
		}
	}
}

func ProviderResponsePayloads(responseBody []byte) []map[string]any {
	if len(responseBody) == 0 {
		return nil
	}
	var payload map[string]any
	if json.Unmarshal(responseBody, &payload) == nil {
		return []map[string]any{payload}
	}
	result := make([]map[string]any, 0)
	scanner := bufio.NewScanner(bytes.NewReader(responseBody))
	scanner.Buffer(make([]byte, 64<<10), max(len(responseBody)+1, 64<<10))
	dataLines := make([]string, 0, 1)
	flush := func() {
		raw := strings.TrimSpace(strings.Join(dataLines, "\n"))
		dataLines = dataLines[:0]
		if raw == "" || raw == "[DONE]" {
			return
		}
		var event map[string]any
		if json.Unmarshal([]byte(raw), &event) == nil {
			result = append(result, event)
		}
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	flush()
	return result
}

func ProviderRequestIDFromPath(path string) string {
	parts := strings.Split(strings.Trim(strings.TrimSpace(path), "/"), "/")
	for index := len(parts) - 1; index >= 0; index-- {
		part := strings.TrimSpace(parts[index])
		if part == "" || part == "content" || part == "download" {
			continue
		}
		if isProviderEndpointSegment(part) {
			return ""
		}
		if index > 0 && (parts[index-1] == "videos" || parts[index-1] == "tasks") {
			return part
		}
		break
	}
	return ""
}

func isProviderEndpointSegment(part string) bool {
	switch strings.ToLower(strings.TrimSpace(part)) {
	case "generations", "edits", "variations", "tasks", "videos", "images", "completions", "responses", "messages", "speech", "transcriptions", "translations":
		return true
	default:
		return false
	}
}

func firstInt64(values map[string]any, keys ...string) int64 {
	value, _ := firstInt64Value(values, keys...)
	return value
}

func firstInt64Value(values map[string]any, keys ...string) (int64, bool) {
	for _, key := range keys {
		switch value := values[key].(type) {
		case float64:
			return int64(value), true
		case int64:
			return value, true
		case json.Number:
			parsed, err := value.Int64()
			return parsed, err == nil
		}
	}
	return 0, false
}
