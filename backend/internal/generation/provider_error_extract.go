package generation

import (
	"encoding/json"
	"fmt"
	"html"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	maxSanitizedRunes    = 240
	maxProviderCodeRunes = 80
	maxDebugIDRunes      = 80
	maxJSONExtractBytes  = 16 << 10
	maxWalkDepth         = 5
)

var (
	htmlBodyPattern          = regexp.MustCompile(`(?is)^\s*(?:<!doctype|<html|<head|<body)`)
	httpStatusPattern        = regexp.MustCompile(`(?i)(?:HTTP\s+|status(?:\s+code)?\s*[:：]?\s*)(\d{3})\b`)
	wrappedHTTPStatusPattern = regexp.MustCompile(`(?i)Request failed with status code\s+(\d{3})`)
	urlPattern               = regexp.MustCompile(`(?i)(?:https?://|data:[a-z0-9.+-]+/[^;]+;base64,)[^\s"'<>]+`)
	secretPattern            = regexp.MustCompile(`(?i)(?:\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|password)\b["']?\s*[=:：]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)|\bbearer\s+[^\s,;]+|\bsk-[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_.-]{20,})`)
	credentialHeaderPattern  = regexp.MustCompile(`(?im)\b(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[=:：][^\r\n]*`)
	promptEchoPattern        = regexp.MustCompile(`(?is)(?:\b(?:prompt|input|query)|提示词|输入内容)["']?\s*[=:：].*`)
	signedQueryPattern       = regexp.MustCompile(`(?i)(?:[?&](?:signature|x-amz-signature|x-oss-signature|token|key)=)[^\s&]+`)
	safeIDPattern            = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$`)
	providerCodePattern      = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._:-]*$`)
	unsafeIDPattern          = regexp.MustCompile(`(?i)secret|token|password|apikey|api-key|bearer|sk-`)
)

var providerCodeCategories = map[string]FailureCategory{
	"contentmoderationfailed":           CategoryModerationInput,
	"invalidparameter.voilationcontent": CategoryModerationInput,
	"invalidparameter.violationcontent": CategoryModerationInput,

	"local_disk_full":                  CategoryLocalDiskFull,
	"local_credential_failed":          CategoryLocalCredential,
	"local_storage_failed":             CategoryLocalStorage,
	"contentsecuritydetectionerror":    CategoryProviderUnavailable,
	"accountoverdueerror":              CategoryQuotaUpstream,
	"operationdenied.serviceoverdue":   CategoryQuotaUpstream,
	"setlimitexceeded":                 CategoryQuotaLimit,
	"inflightbatchsizeexceeded":        CategoryConcurrency,
	"modelnotopen":                     CategoryPermission,
	"operationdenied.servicenotopen":   CategoryPermission,
	"invalid_api_key":                  CategoryAuth,
	"invalid_authentication":           CategoryAuth,
	"authentication_error":             CategoryAuth,
	"unauthenticated":                  CategoryAuth,
	"unauthorized":                     CategoryAuth,
	"invalid_api_key_error":            CategoryAuth,
	"permission_denied":                CategoryPermission,
	"forbidden":                        CategoryPermission,
	"access_denied":                    CategoryPermission,
	"model_permission":                 CategoryPermission,
	"channel_excluded":                 CategoryPermission,
	"insufficient_quota":               CategoryQuotaUnknown,
	"insufficient_balance":             CategoryQuotaUnknown,
	"billing_not_active":               CategoryQuotaUnknown,
	"billing_hard_limit_reached":       CategoryQuotaUpstream,
	"arrearage":                        CategoryQuotaUpstream,
	"allocationquota":                  CategoryQuotaUnknown,
	"quota_exceeded":                   CategoryQuotaUnknown,
	"account_deactivated":              CategoryQuotaUpstream,
	"sensitive_words_detected":         CategoryModerationInput,
	"content_filter":                   CategoryModerationInput,
	"content_filter_error":             CategoryModerationInput,
	"content_policy_violation":         CategoryModerationInput,
	"content_policy":                   CategoryModerationInput,
	"datainspectionfailed":             CategoryModerationInput,
	"prohibited_content":               CategoryModerationInput,
	"safety":                           CategoryModerationInput,
	"blocked_reason_safety":            CategoryModerationInput,
	"invalid_request":                  CategoryInvalidParams,
	"invalid_reference_video":          CategoryInvalidParams,
	"invalid_request_error":            CategoryInvalidParams,
	"invalid_parameter":                CategoryInvalidParams,
	"invalidparameter":                 CategoryInvalidParams,
	"invalid_argument":                 CategoryInvalidParams,
	"requestparameteriswrong":          CategoryInvalidParams,
	"model_capability_not_supported":   CategoryInvalidParams,
	"invalid_model_selection":          CategoryInvalidParams,
	"context_length_exceeded":          CategoryContextTooLong,
	"context_length":                   CategoryContextTooLong,
	"max_tokens":                       CategoryContextTooLong,
	"string_above_max_length":          CategoryContextTooLong,
	"contentlengthexceeded":            CategoryContextTooLong,
	"url_error":                        CategoryInputInaccessible,
	"invalid_image_url":                CategoryInputInaccessible,
	"invalid_image":                    CategoryInputInaccessible,
	"download_error":                   CategoryInputInaccessible,
	"file_too_large":                   CategoryInputTooLarge,
	"payload_too_large":                CategoryInputTooLarge,
	"video_request_body_too_large":     CategoryInputTooLarge,
	"model_not_found":                  CategoryModelMissing,
	"model_not_exist":                  CategoryModelMissing,
	"invalid_model":                    CategoryModelMissing,
	"not_found":                        CategoryModelMissing,
	"model_catalog_mismatch":           CategoryModelMissing,
	"model_temporarily_unavailable":    CategoryProviderUnavailable,
	"model_route_unavailable":          CategoryProviderUnavailable,
	"rate_limit_exceeded":              CategoryThrottled,
	"rate_limit_error":                 CategoryThrottled,
	"throttling":                       CategoryThrottled,
	"too_many_requests":                CategoryThrottled,
	"resource_exhausted":               CategoryThrottled,
	"channel_concurrency_wait_timeout": CategoryConcurrency,
	"channel_concurrency_unavailable":  CategoryConcurrency,
	"unavailable":                      CategoryProviderUnavailable,
	"overloaded":                       CategoryProviderUnavailable,
	"internal_error":                   CategoryProviderUnavailable,
	"server_error":                     CategoryProviderUnavailable,
	"provider_request_failed":          CategoryUnknown,
	"upstream_timeout":                 CategoryTimeout,
	"deadline_exceeded":                CategoryTimeout,
	"request_timeout":                  CategoryTimeout,
	"requesttimeout":                   CategoryTimeout,
	"request_cancelled":                CategoryCancelled,
	"task_failed":                      CategoryAsyncFailed,
	"provider_query_failed":            CategoryAsyncFailed,
	"provider_submission_unknown":      CategorySubmissionUncertain,
	"video_submission_unknown":         CategorySubmissionUncertain,
	"video_delivery_failed":            CategoryDeliveryFailed,
	"image_result_unknown":             CategorySubmissionUncertain,
	"image_submission_pending":         CategorySubmissionUncertain,
	"image_result_expired":             CategorySubmissionUncertain,
	"image_result_unavailable":         CategorySubmissionUncertain,
	"idempotency_conflict":             CategorySubmissionUncertain,
	"provider_reference_invalid":       CategoryInputInaccessible,
	"rate_limited":                     CategoryThrottled,
	"bad_gateway":                      CategoryProviderUnavailable,
	"internal":                         CategoryProviderUnavailable,
	"failed_precondition":              CategoryInvalidParams,
	// BeefAPI stable codes: internal failures without a reliable caller action
	// stay explicitly unknown instead of inheriting a misleading HTTP 400.
	"violation_fee.grok.csam":              CategoryModerationInput,
	"count_token_failed":                   CategoryUnknown,
	"model_price_error":                    CategoryUnknown,
	"invalid_api_type":                     CategoryUnknown,
	"json_marshal_failed":                  CategoryUnknown,
	"do_request_failed":                    CategorySubmissionUncertain,
	"get_channel_failed":                   CategoryProviderUnavailable,
	"no_available_channel":                 CategoryProviderUnavailable,
	"gen_relay_info_failed":                CategoryUnknown,
	"channel:no_available_key":             CategoryProviderUnavailable,
	"channel:param_override_invalid":       CategoryUnknown,
	"channel:header_override_invalid":      CategoryUnknown,
	"channel:model_mapped_error":           CategoryUnknown,
	"channel:aws_client_error":             CategoryProviderUnavailable,
	"channel:invalid_key":                  CategoryProviderUnavailable,
	"channel:response_time_exceeded":       CategoryTimeout,
	"read_request_body_failed":             CategoryUnknown,
	"convert_request_failed":               CategoryUnknown,
	"key_site_mismatch":                    CategoryAuth,
	"bad_request_body":                     CategoryInvalidParams,
	"context_media_limit_exceeded":         CategoryContextTooLong,
	"media_request_capacity_exceeded":      CategoryConcurrency,
	"read_response_body_failed":            CategorySubmissionUncertain,
	"bad_response_status_code":             CategoryUnknown,
	"bad_response":                         CategoryMalformedResponse,
	"bad_response_body":                    CategoryMalformedResponse,
	"empty_response":                       CategoryResultsMissing,
	"aws_invoke_error":                     CategoryUnknown,
	"prompt_blocked":                       CategoryModerationInput,
	"responses_encrypted_context_mismatch": CategoryInvalidParams,
	"query_data_error":                     CategoryUnknown,
	"update_data_error":                    CategoryUnknown,
	"insufficient_user_quota":              CategoryQuotaUser,
	"pre_consume_token_quota_failed":       CategoryUnknown,
	"upstream_crowded":                     CategoryThrottled,
	"upstream_unavailable":                 CategoryProviderUnavailable,
	"image_reference_upload_failed":        CategoryProviderUnavailable,
	"reference_media_upload_failed":        CategoryProviderUnavailable,
	"reference_preupload_failed":           CategoryProviderUnavailable,
	"upscale_unavailable":                  CategoryProviderUnavailable,
	"fal_billing_unavailable":              CategoryProviderUnavailable,
	"invalid_upscale_source":               CategoryInvalidParams,
	"invalid_upscale_parameters":           CategoryInvalidParams,
	"invalid_upscale_model":                CategoryModelMissing,
	"invalid_upscale_channel":              CategoryModelMissing,
	"upstream_rejected":                    CategoryUnknown,
	"upstream_error":                       CategoryUnknown,
}

type extractedFields struct {
	ParsedJSON bool
	Code       string
	Type       string
	Status     string
	Message    string
	Param      string
	RequestID  string
	TaskID     string
}

func (f extractedFields) hasStructured() bool {
	return f.ParsedJSON || f.Code != "" || f.Type != "" || f.Message != "" || f.Status != "" || f.RequestID != "" || f.TaskID != ""
}

func extractProviderFields(raw string) extractedFields {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > maxJSONExtractBytes {
		return extractedFields{}
	}
	// The gateway appends a public request ID outside its JSON error envelope.
	// Strip only that exact suffix; arbitrary trailing text is not trusted JSON.
	suffix := regexp.MustCompile(`(?i)\s*\(request id:\s*([A-Za-z0-9._:-]{6,127})\)\s*$`).FindStringSubmatchIndex(raw)
	requestID := ""
	if suffix != nil {
		requestID = raw[suffix[2]:suffix[3]]
		raw = strings.TrimSpace(raw[:suffix[0]])
	}
	if fields, ok := fieldsFromJSON([]byte(raw)); ok {
		if fields.RequestID == "" {
			fields.RequestID = requestID
		}
		if fields.RequestID == "" {
			fields.RequestID = requestIDFromMessage(fields.Message)
		}
		return fields
	}
	for start := 0; start < len(raw); {
		index := strings.Index(raw[start:], "{")
		if index < 0 {
			break
		}
		absolute := start + index
		if fields, ok := fieldsFromJSON([]byte(raw[absolute:])); ok {
			if fields.RequestID == "" {
				fields.RequestID = requestID
			}
			if fields.RequestID == "" {
				fields.RequestID = requestIDFromMessage(fields.Message)
			}
			return fields
		}
		start = absolute + 1
	}
	return extractedFields{}
}

var embeddedRequestIDPattern = regexp.MustCompile(`(?i)\brequest\s*id:\s*([A-Za-z0-9._:-]{6,127})\b`)

func requestIDFromMessage(message string) string {
	if m := embeddedRequestIDPattern.FindStringSubmatch(sanitizeProviderText(message)); len(m) == 2 {
		return sanitizeDebugID(m[1])
	}
	return ""
}

func fieldsFromJSON(data []byte) (extractedFields, bool) {
	data = bytesTrimSpace(data)
	if len(data) == 0 || data[0] != '{' {
		return extractedFields{}, false
	}
	var payload map[string]any
	if json.Unmarshal(data, &payload) != nil {
		return extractedFields{}, false
	}
	fields := walkProviderFields(payload, 0)
	fields.ParsedJSON = true
	return fields, true
}

func walkProviderFields(payload map[string]any, depth int) extractedFields {
	fields := extractedFields{}
	if payload == nil || depth > maxWalkDepth {
		return fields
	}
	fields.Code = firstNonEmpty(fields.Code, allowlistedString(payload["code"]))
	fields.Type = firstNonEmpty(fields.Type, allowlistedString(payload["type"]))
	fields.Status = firstNonEmpty(fields.Status, allowlistedString(payload["status"]))
	fields.Message = firstNonEmpty(fields.Message, allowlistedString(payload["message"]), allowlistedString(payload["msg"]), allowlistedString(payload["detail"]))
	fields.Param = firstNonEmpty(fields.Param, allowlistedString(payload["param"]), allowlistedString(payload["parameter"]))
	fields.RequestID = firstNonEmpty(fields.RequestID, allowlistedString(payload["request_id"]), allowlistedString(payload["requestId"]), allowlistedString(payload["request-id"]))
	fields.TaskID = firstNonEmpty(fields.TaskID, allowlistedString(payload["task_id"]), allowlistedString(payload["taskId"]))
	if nested := mapValue(payload["error"]); nested != nil {
		child := walkProviderFields(nested, depth+1)
		fields = mergeExtracted(child, fields)
	}
	if nested := mapValue(payload["data"]); nested != nil {
		child := walkProviderFields(nested, depth+1)
		fields = mergeExtracted(child, fields)
	}
	if nested := mapValue(payload["output"]); nested != nil {
		child := walkProviderFields(nested, depth+1)
		fields = mergeExtracted(child, fields)
	}
	if nested := mapValue(payload["promptFeedback"]); nested != nil {
		if reason := allowlistedString(nested["blockReason"]); reason != "" {
			fields.Code = firstNonEmpty(fields.Code, reason)
			fields.Message = firstNonEmpty(fields.Message, "blocked by content safety policy")
		}
	}
	// Gateways may wrap original error JSON inside message. Stay within the
	// allowlisted error fields and depth bound; keep authoritative outer codes.
	outerCategory, outerKnown := categoryFromProviderCode(fields.Code, fields.Type, fields.Status)
	if !outerKnown {
		for _, value := range []string{fields.Code, fields.Status} {
			if status, err := strconv.Atoi(value); err == nil {
				if category, ok := categoryFromHTTPStatus(status); ok {
					outerCategory, outerKnown = category, true
					break
				}
			}
		}
	}
	if genericProviderCode(fields.Code) && (!outerKnown || outerCategory == CategoryInvalidParams || outerCategory == CategoryUnknown) && strings.HasPrefix(strings.TrimSpace(fields.Message), "{") {
		var nested map[string]any
		if json.Unmarshal([]byte(fields.Message), &nested) == nil {
			child := walkProviderFields(nested, depth+1)
			if child.Code != "" || child.Message != "" {
				child.RequestID = firstNonEmpty(fields.RequestID, child.RequestID)
				child.TaskID = firstNonEmpty(fields.TaskID, child.TaskID)
				fields = mergeExtracted(child, fields)
			}
		}
	}
	return fields
}

func mergeExtracted(primary extractedFields, fallback extractedFields) extractedFields {
	return extractedFields{
		Code:      firstNonEmpty(primary.Code, fallback.Code),
		Type:      firstNonEmpty(primary.Type, fallback.Type),
		Status:    firstNonEmpty(primary.Status, fallback.Status),
		Message:   firstNonEmpty(primary.Message, fallback.Message),
		Param:     firstNonEmpty(primary.Param, fallback.Param),
		RequestID: firstNonEmpty(primary.RequestID, fallback.RequestID),
		TaskID:    firstNonEmpty(primary.TaskID, fallback.TaskID),
	}
}

func allowlistedString(value any) string {
	switch current := value.(type) {
	case string:
		return strings.TrimSpace(current)
	case json.Number:
		return strings.TrimSpace(current.String())
	case float64:
		if current == 0 {
			return ""
		}
		return strings.TrimSpace(strconvTrimFloat(current))
	case int:
		if current == 0 {
			return ""
		}
		return fmt.Sprintf("%d", current)
	case int64:
		if current == 0 {
			return ""
		}
		return fmt.Sprintf("%d", current)
	default:
		return ""
	}
}

func strconvTrimFloat(value float64) string {
	if value == float64(int64(value)) {
		return fmt.Sprintf("%d", int64(value))
	}
	return strings.TrimSpace(fmt.Sprintf("%g", value))
}

func mapValue(value any) map[string]any {
	current, _ := value.(map[string]any)
	return current
}

func bytesTrimSpace(data []byte) []byte {
	return []byte(strings.TrimSpace(string(data)))
}

func categoryFromProviderCode(values ...string) (FailureCategory, bool) {
	for _, value := range values {
		normalized := normalizeCode(value)
		if normalized == "" || normalized == "0" || normalized == "success" || normalized == "succeeded" || normalized == "ok" {
			continue
		}
		if _, ok := categoryCopies[FailureCategory(normalized)]; ok {
			return FailureCategory(normalized), true
		}
		if category, ok := providerCodeCategories[normalized]; ok {
			return category, true
		}
		if f, ok := moderationErrorCopy(normalized, ""); ok {
			return f.Category, true
		}
		if normalized == "sensitivecontentdetected" || strings.HasPrefix(normalized, "sensitivecontentdetected.") {
			return CategoryModerationInput, true
		}
		if strings.Contains(normalized, "content_filter") || strings.Contains(normalized, "contentpolicy") || strings.Contains(normalized, "datainspection") || strings.Contains(normalized, "sensitive_words") {
			return CategoryModerationInput, true
		}
		if strings.Contains(normalized, "insufficient") && (strings.Contains(normalized, "quota") || strings.Contains(normalized, "balance")) {
			return CategoryQuotaUnknown, true
		}
		if strings.Contains(normalized, "rate_limit") || strings.Contains(normalized, "throttl") {
			return CategoryThrottled, true
		}
		if strings.Contains(normalized, "context_length") || strings.Contains(normalized, "max_tokens") {
			return CategoryContextTooLong, true
		}
		if strings.Contains(normalized, "model_not") || strings.Contains(normalized, "invalid_model") {
			return CategoryModelMissing, true
		}
		if strings.Contains(normalized, "auth") && (strings.Contains(normalized, "invalid") || strings.Contains(normalized, "fail") || strings.Contains(normalized, "unauth")) {
			return CategoryAuth, true
		}
		if strings.Contains(normalized, "permission") || strings.Contains(normalized, "forbidden") {
			return CategoryPermission, true
		}
	}
	return "", false
}

func genericProviderCode(code string) bool {
	switch normalizeCode(code) {
	case "", "unknown", "failed", "badrequest", "api_error", "upstream_error", "upstream_rejected", "invalid_request", "invalid_request_error", "invalid_parameter", "invalidparameter", "invalid_argument":
		return true
	}
	return regexp.MustCompile(`^\d{3}$`).MatchString(code)
}

func extractExplicitHTTPStatus(raw string) int {
	for _, pattern := range []*regexp.Regexp{httpStatusPattern, wrappedHTTPStatusPattern} {
		match := pattern.FindStringSubmatch(raw)
		if len(match) < 2 {
			continue
		}
		status := 0
		for _, digit := range match[1] {
			status = status*10 + int(digit-'0')
		}
		if status >= 400 && status <= 599 {
			return status
		}
	}
	return 0
}

func sanitizeDebugID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || utf8.RuneCountInString(value) > maxDebugIDRunes {
		return ""
	}
	if !safeIDPattern.MatchString(value) || unsafeIDPattern.MatchString(value) {
		return ""
	}
	return value
}

func normalizeCode(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, "-", "_")
	value = strings.ReplaceAll(value, " ", "_")
	return value
}

func sanitizeProviderCode(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if !providerCodePattern.MatchString(value) || utf8.RuneCountInString(value) > maxProviderCodeRunes {
		return ""
	}
	normalized := normalizeCode(value)
	if _, ok := providerCodeCategories[normalized]; ok {
		return value
	}
	if _, ok := categoryCopies[FailureCategory(normalized)]; ok {
		return value
	}
	if unsafeIDPattern.MatchString(value) {
		return ""
	}
	return value
}

func sanitizeProviderText(value string) string {
	value = html.UnescapeString(strings.TrimSpace(value))
	if value == "" {
		return ""
	}
	if htmlBodyPattern.MatchString(value) {
		return ""
	}
	value = urlPattern.ReplaceAllString(value, "")
	value = signedQueryPattern.ReplaceAllString(value, "")
	value = credentialHeaderPattern.ReplaceAllString(value, "[已隐藏]")
	value = secretPattern.ReplaceAllString(value, "")
	value = promptEchoPattern.ReplaceAllString(value, "[已隐藏]")
	value = strings.Join(strings.Fields(value), " ")
	if strings.HasPrefix(value, "{") || strings.HasPrefix(value, "<") {
		return ""
	}
	return truncateRunes(value, maxSanitizedRunes)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 || value == "" {
		return ""
	}
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}
