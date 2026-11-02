package generation

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"

	"qisitv/backend/internal/beefapi"
	"qisitv/backend/internal/outbound"
)

// FailureCategory 是生成失败的稳定机器可读类目。HTTP 状态只作兜底，不能单独当原因。
type FailureCategory string

const (
	CategoryAuth                FailureCategory = "auth"
	CategoryPermission          FailureCategory = "permission"
	CategoryQuotaUser           FailureCategory = "quota_user"
	CategoryQuotaUpstream       FailureCategory = "quota_upstream"
	CategoryQuotaUnknown        FailureCategory = "quota_unknown"
	CategoryQuotaLimit          FailureCategory = "quota_limit"
	CategoryModerationInput     FailureCategory = "moderation_input"
	CategoryModerationReference FailureCategory = "moderation_reference"
	CategoryModerationOutput    FailureCategory = "moderation_output"
	CategoryInvalidParams       FailureCategory = "invalid_params"
	CategoryLocalStorage        FailureCategory = "local_storage"
	CategoryLocalDiskFull       FailureCategory = "local_disk_full"
	CategoryLocalCredential     FailureCategory = "local_credential"
	CategoryContextTooLong      FailureCategory = "context_too_long"
	CategoryInputInaccessible   FailureCategory = "input_inaccessible"
	CategoryInputTooLarge       FailureCategory = "input_too_large"
	CategoryModelMissing        FailureCategory = "model_missing"
	CategoryThrottled           FailureCategory = "throttled"
	CategoryConcurrency         FailureCategory = "concurrency"
	CategoryProviderUnavailable FailureCategory = "provider_unavailable"
	CategoryNetwork             FailureCategory = "network"
	CategoryRequestNotSent      FailureCategory = "request_not_sent"
	CategoryTimeout             FailureCategory = "timeout"
	CategorySubmissionUncertain FailureCategory = "submission_uncertain"
	CategoryAsyncFailed         FailureCategory = "async_failed"
	CategoryCancelled           FailureCategory = "cancelled"
	CategoryPartialSuccess      FailureCategory = "partial_success"
	CategoryDownloadFailed      FailureCategory = "download_failed"
	CategoryDeliveryFailed      FailureCategory = "delivery_failed"
	CategoryResultsMissing      FailureCategory = "results_missing"
	CategoryMalformedResponse   FailureCategory = "malformed_response"
	CategoryUnknown             FailureCategory = "unknown"
)

// Failure 是归类后的可行动失败。UserMessage 给用户看；ErrorCode 给机器判断。
type Failure struct {
	Category        FailureCategory
	Reason          string
	Action          string
	ProviderCode    string
	ProviderMessage string
	Param           string
	RequestID       string
	TaskID          string
	HTTPStatus      int
	Retryable       bool
	Uncertain       bool
	Structured      bool
	FromCode        bool
}

type categoryCopy struct {
	Reason string
	Action string
}

var categoryCopies = map[FailureCategory]categoryCopy{
	CategoryLocalDiskFull:       {Reason: "本地磁盘空间不足，无法保存数据", Action: "请清理 BeefTV 数据目录所在磁盘；已有生成结果请优先取回原任务，不要重复生成"},
	CategoryLocalCredential:     {Reason: "本地算力凭据读取失败", Action: "请检查工作区数据目录并重新连接算力账号；不要删除工作区密钥"},
	CategoryAuth:                {Reason: "模型服务鉴权失败", Action: "请检查 API Key 后重试"},
	CategoryPermission:          {Reason: "当前渠道没有使用该模型的权限", Action: "请更换模型或检查渠道权限"},
	CategoryQuotaUser:           {Reason: "当前账号可用额度不足", Action: "请检查账号余额，补充额度或调整令牌、套餐额度后重试"},
	CategoryQuotaUpstream:       {Reason: "模型供应商拒绝了计费或额度相关请求", Action: "请到供应商核对账单与额度后，再决定是否重试"},
	CategoryQuotaUnknown:        {Reason: "模型服务拒绝了计费或额度相关请求", Action: "请到当前渠道或模型供应商核对账单与额度后，再决定是否重试"},
	CategoryQuotaLimit:          {Reason: "模型调用已达到设置的用量上限", Action: "请检查当前渠道的用量或预算限制，调整后再试"},
	CategoryModerationInput:     {Reason: "提示词或参考素材未通过内容安全审核", Action: "请调整提示词或参考素材后重新生成"},
	CategoryModerationReference: {Reason: "参考素材未通过内容安全审核", Action: "请检查并更换参考素材后重新生成"},
	CategoryModerationOutput:    {Reason: "生成结果未通过内容安全审核", Action: "请调整提示词或参考素材后重新生成"},
	CategoryInvalidParams:       {Reason: "模型不接受当前参数", Action: "请检查模型、尺寸、时长、格式或数量后重试"},
	CategoryLocalStorage:        {Reason: "本地数据库无法读写", Action: "请重启应用；若仍失败，请保留排查信息并联系支持，不要重复生成"},
	CategoryContextTooLong:      {Reason: "输入内容超出模型长度限制", Action: "请缩短提示词或减少参考内容后重试"},
	CategoryInputInaccessible:   {Reason: "参考素材无法读取", Action: "请检查素材后重试"},
	CategoryInputTooLarge:       {Reason: "参考素材过大", Action: "请压缩或更换素材后重试"},
	CategoryModelMissing:        {Reason: "当前模型或接口不可用", Action: "请检查模型名称和渠道配置"},
	CategoryThrottled:           {Reason: "请求过于频繁", Action: "请稍后再试"},
	CategoryConcurrency:         {Reason: "同时进行的生成过多", Action: "请等待已有任务完成后再试"},
	CategoryProviderUnavailable: {Reason: "模型服务暂时不可用", Action: "请稍后重试"},
	CategoryNetwork:             {Reason: "网络连接失败", Action: "请检查网络并核对原任务状态后，再决定是否重新生成"},
	CategoryRequestNotSent:      {Reason: "未能连接服务，本次请求尚未提交", Action: "请检查网络或代理后重试"},
	CategoryTimeout:             {Reason: "模型服务响应超时", Action: "请稍后查询原任务，不要立即重新提交"},
	CategorySubmissionUncertain: {Reason: "提交结果尚未确认，上游任务可能仍在执行", Action: "请先查询原任务状态，不要立即重新提交"},
	CategoryAsyncFailed:         {Reason: "生成任务没有完成", Action: "请查看详情后决定是否重试"},
	CategoryCancelled:           {Reason: "任务已取消", Action: "可按原输入重新提交"},
	CategoryPartialSuccess:      {Reason: "部分结果已生成，其余失败", Action: "请查看已有结果后再决定是否补做"},
	CategoryDownloadFailed:      {Reason: "生成结果下载失败", Action: "请稍后重新加载，不要立即重新提交"},
	CategoryDeliveryFailed:      {Reason: "视频已生成，但暂时无法取回", Action: "请联系支持恢复成片，恢复后点击「取回结果」；无需重新付费生成"},
	CategoryResultsMissing:      {Reason: "任务结束但没有可用结果", Action: "请查看详情后再决定是否重试"},
	CategoryMalformedResponse:   {Reason: "模型服务返回了无法解析的内容", Action: "请查看详情并核对原任务状态后，再决定是否重新生成"},
	CategoryUnknown:             {Reason: "生成失败", Action: "请查看详情后再决定是否重试"},
}

func (f Failure) ErrorCode() string {
	if f.Category == "" {
		return string(CategoryUnknown)
	}
	return string(f.Category)
}

func (f Failure) UserMessage() string {
	reason, action := f.displayCopy()
	message := joinSentences(reason, action)
	if ids := f.debugIDLine(); ids != "" {
		message = joinSentences(message, ids)
	}
	return message
}

func (f Failure) IsModeration() bool {
	return f.Category == CategoryModerationInput || f.Category == CategoryModerationReference || f.Category == CategoryModerationOutput
}

func (f Failure) BlocksAutomaticRetry() bool {
	_, preparation := referencePreparationCopies[f.ProviderCode]
	if f.Uncertain || preparation {
		return true
	}
	switch f.Category {
	case CategoryThrottled, CategoryConcurrency, CategoryProviderUnavailable, CategoryCancelled, CategoryRequestNotSent:
		return false
	default:
		return true
	}
}

func (f Failure) displayCopy() (string, string) {
	if strings.TrimSpace(f.Reason) != "" {
		return strings.TrimSpace(f.Reason), strings.TrimSpace(f.Action)
	}
	copyText := categoryCopies[f.Category]
	if copyText.Reason == "" {
		copyText = categoryCopies[CategoryUnknown]
	}
	return copyText.Reason, copyText.Action
}

func (f Failure) debugIDLine() string {
	parts := make([]string, 0, 2)
	if id := sanitizeDebugID(f.TaskID); id != "" {
		parts = append(parts, "任务 "+id)
	}
	if id := sanitizeDebugID(f.RequestID); id != "" {
		parts = append(parts, "请求 "+id)
	}
	if len(parts) == 0 {
		return ""
	}
	return "排查编号：" + strings.Join(parts, " · ")
}

func joinSentences(parts ...string) string {
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		part = strings.TrimRight(part, "。.;；")
		out = append(out, part)
	}
	if len(out) == 0 {
		return categoryCopies[CategoryUnknown].Reason + "。" + categoryCopies[CategoryUnknown].Action + "。"
	}
	if len(out) == 1 {
		return out[0]
	}
	return strings.Join(out, "。") + "。"
}

func (e HTTPError) Error() string {
	return ClassifyHTTP(e.StatusCode, e.Status, e.Body).UserMessage()
}

func (e PayloadError) Error() string {
	if strings.TrimSpace(e.message) != "" {
		return e.message
	}
	return ClassifyText(e.raw).UserMessage()
}

func ClassifyHTTP(status int, statusText string, body string) Failure {
	fields := extractProviderFields(body)
	if _, persisted := persistedReferencePreparationFailure(firstNonEmpty(fields.Message, body)); persisted {
		// Only the typed transport boundary may attest an unsent request. A
		// provider response cannot grant that proof by echoing our saved copy.
		return normalizeFailure(Failure{Category: CategorySubmissionUncertain, HTTPStatus: status, ProviderCode: sanitizeProviderCode(fields.Code)})
	}
	failure := ClassifyText(body)
	// This boundary handles provider responses, not local filesystem errors.
	if failure.Category == CategoryLocalDiskFull || failure.Category == CategoryLocalCredential {
		failure = Failure{Category: CategoryUnknown}
	}
	failure.HTTPStatus = status
	// Reservation failures also use HTTP 503; only explicit funding rejection identifies caller quota.
	if status == 402 && failure.ProviderCode == "video_reservation_failed" && strings.HasPrefix(failure.ProviderMessage, "insufficient balance for this video request") {
		failure.Category = CategoryQuotaUser
		failure.FromCode = true
		failure.Reason, failure.Action = "", ""
	}
	if failure.Category != CategoryUnknown && !failure.FromCode && ((status != 0 && !trustProviderMessageStatus(status)) || (htmlBodyPattern.MatchString(strings.TrimSpace(body)) && status >= 400)) {
		failure.Category = CategoryUnknown
		failure.Reason = ""
		failure.Action = ""
	}
	if !failure.FromCode && failure.Category == CategoryInvalidParams && status >= 400 && status != http.StatusBadRequest && status != http.StatusConflict && status != http.StatusUnprocessableEntity {
		failure.Category = CategoryUnknown
		failure.Reason = ""
		failure.Action = ""
	}
	if failure.Category == CategoryUnknown && !failure.FromCode {
		if category, ok := categoryFromHTTPStatus(status); ok {
			failure.Category = category
			failure.Reason = ""
			failure.Action = ""
		}
	}
	if status == 413 && failure.Category == CategoryInputTooLarge && !singleFileTooLargePattern.MatchString(body) && (failure.Reason == "" || failure.Reason == "参考素材过大") {
		failure.Reason = "整次请求的数据量超过接口上限"
		failure.Action = "请减少参考素材，或改用可公开访问的素材链接后再提交"
	}
	if status == 524 && (failure.Category == CategoryUnknown || failure.Category == CategoryTimeout || failure.Category == CategoryProviderUnavailable || failure.Category == CategoryMalformedResponse) {
		failure.Category = CategoryTimeout
		failure.Uncertain = true
		failure.Reason = "模型服务响应超时，请求可能仍在服务端执行"
		failure.Action = "请先查询原任务或到供应商核对状态，不要立即重新提交"
	}
	_ = statusText
	return normalizeFailure(failure)
}

func classifyHTTPErrorCause(err error) Failure {
	var httpErr HTTPError
	if errors.As(err, &httpErr) {
		return ClassifyHTTP(httpErr.StatusCode, httpErr.Status, httpErr.Body)
	}
	if err == nil {
		return normalizeFailure(Failure{Category: CategoryUnknown})
	}
	return ClassifyText(err.Error())
}

func ClassifyError(err error) Failure {
	if err == nil {
		return normalizeFailure(Failure{Category: CategoryUnknown})
	}
	var unknown SubmissionUnknownError
	if errors.As(err, &unknown) {
		return normalizeFailure(Failure{Category: CategorySubmissionUncertain, Uncertain: true, Retryable: false})
	}
	var managed *beefapi.MediaTaskError
	if errors.As(err, &managed) {
		category := FailureCategory(managed.Category)
		switch strings.ToLower(strings.TrimSpace(managed.Category)) {
		case "input":
			category = CategoryInvalidParams
		case "authorization":
			category = CategoryAuth
		case "upstream":
			category = CategoryAsyncFailed
		case "unknown":
			category = CategorySubmissionUncertain
		}
		if _, supported := categoryCopies[category]; !supported {
			category = CategoryUnknown
		}
		uncertain := category == CategorySubmissionUncertain || managed.Pending()
		return normalizeFailure(Failure{Category: category, Uncertain: uncertain, TaskID: sanitizeDebugID(managed.TaskID), ProviderCode: sanitizeProviderCode(managed.Code), ProviderMessage: DiagnosticSummary(managed.Message), Structured: true, FromCode: true})
	}
	var managedHTTP *beefapi.MediaHTTPError
	if errors.As(err, &managedHTTP) {
		failure := classifyHTTPErrorCause(legacyMediaError(err))
		failure.RequestID = firstNonEmpty(sanitizeDebugID(managedHTTP.RequestID), failure.RequestID)
		return failure
	}
	var protocolPreparation ProtocolPreparationError
	if errors.As(err, &protocolPreparation) {
		return normalizeFailure(Failure{Category: CategoryModelMissing, Reason: protocolPreparation.Error(), Action: "本次请求尚未提交，请检查所选模型的插件是否已安装、启用并支持该生成类型"})
	}
	if errors.Is(err, context.Canceled) {
		return normalizeFailure(Failure{Category: CategoryCancelled})
	}
	var referenceUpload *ReferenceUploadError
	if errors.As(err, &referenceUpload) {
		if referenceUpload.Meta.Stage != "put" && (referenceUpload.HTTPStatus == 400 || referenceUpload.HTTPStatus == 401 || referenceUpload.HTTPStatus == 402 || referenceUpload.HTTPStatus == 403) {
			failure := ClassifyError(referenceUpload.Cause)
			failure.RequestID = firstNonEmpty(referenceUpload.RequestID, failure.RequestID)
			if referenceUpload.HTTPStatus == 400 && referenceUpload.Meta.Index > 0 {
				itemLabel := referenceMediaLabel(referenceUpload.Meta.Kind, referenceUpload.Meta.Index-1)
				if itemLabel != "" {
					if failure.Reason != "" && !strings.Contains(failure.Reason, itemLabel) && !strings.Contains(failure.Reason, "个参考") {
						failure.Reason = itemLabel + "：" + failure.Reason
					}
					if failure.ProviderMessage != "" && !strings.Contains(failure.ProviderMessage, itemLabel) && !strings.Contains(failure.ProviderMessage, "个参考") {
						failure.ProviderMessage = itemLabel + "：" + failure.ProviderMessage
					}
				}
			}
			return failure
		}
		copy := referencePreparationCopies["reference_preupload_failed"]
		failure := normalizeFailure(Failure{Category: CategoryProviderUnavailable, ProviderCode: "reference_preupload_failed",
			Reason: copy.reason, Action: copy.action, HTTPStatus: referenceUpload.HTTPStatus, RequestID: referenceUpload.RequestID})
		failure.Retryable = false
		return failure
	}
	var notSent RequestNotSentError
	if errors.As(err, &notSent) {
		return normalizeFailure(Failure{Category: CategoryRequestNotSent})
	}
	var preparation RequestPreparationError
	if errors.As(err, &preparation) {
		var storage ReferenceStoragePreparationError
		if errors.As(preparation.Cause, &storage) {
			failure := normalizeFailure(Failure{Category: CategoryProviderUnavailable, ProviderCode: "reference_media_upload_failed", Reason: "参考素材上传失败，本次尚未开始生成", Action: "请检查对象存储配置和公开读取权限后重试"})
			failure.Retryable = false
			return failure
		}
		failure := classifyHTTPErrorCause(preparation.Cause)
		if failure.ProviderCode == "image_reference_upload_failed" {
			failure.Category = CategoryProviderUnavailable
			failure.Uncertain = false
			failure.Reason = "参考图片上传失败，本次尚未开始生成"
			failure.Action = "请稍后重试"
			failure = normalizeFailure(failure)
			failure.Retryable = false
			return failure
		}
		return normalizeFailure(Failure{Category: CategoryInputInaccessible, Reason: "本次请求在准备时失败，未发送到模型服务", Action: "请检查参考素材和生成参数后重试"})
	}
	if _, echoed := persistedReferencePreparationFailure(err.Error()); echoed {
		return normalizeFailure(Failure{Category: CategorySubmissionUncertain})
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return normalizeFailure(Failure{Category: CategoryTimeout, Uncertain: true, Reason: "模型服务响应超时，请求可能仍在执行", Action: "请先查询原任务，不要立即重新提交"})
	}
	var circuit CircuitOpenError
	if errors.As(err, &circuit) {
		return CircuitOpenFailure()
	}
	var decode ResponseDecodeError
	if errors.As(err, &decode) {
		failure := ClassifyError(decode.Err)
		if failure.Category == CategoryUnknown {
			failure = ClassifyText(decode.Error())
		}
		if failure.Category == CategoryUnknown {
			failure.Category = CategoryMalformedResponse
			failure.Reason = ""
			failure.Action = ""
		}
		return normalizeFailure(failure)
	}
	var pending StatePendingError
	if errors.As(err, &pending) {
		failure := classifyHTTPErrorCause(pending.Cause)
		failure.Category = CategorySubmissionUncertain
		failure.Uncertain = true
		failure.TaskID = firstNonEmpty(failure.TaskID, pending.TaskID)
		failure.Reason = ""
		failure.Action = ""
		return normalizeFailure(failure)
	}
	var dns *outbound.DNSResolutionError
	if errors.As(err, &dns) {
		failure := normalizeFailure(Failure{Category: CategoryNetwork, Reason: "模型服务域名解析失败", Action: "请检查网络；已提交的任务请继续查询原任务，不要重新生成"})
		var networkError net.Error
		failure.Retryable = errors.As(dns, &networkError) && (networkError.Timeout() || networkError.Temporary())
		return failure
	}
	var httpErr HTTPError
	if errors.As(err, &httpErr) {
		return ClassifyHTTP(httpErr.StatusCode, httpErr.Status, httpErr.Body)
	}
	var payload PayloadError
	if errors.As(err, &payload) {
		raw := firstNonEmpty(payload.raw, payload.message)
		fields := extractProviderFields(raw)
		if _, echoed := persistedReferencePreparationFailure(firstNonEmpty(fields.Message, raw)); echoed {
			return normalizeFailure(Failure{Category: CategorySubmissionUncertain})
		}
		failure := ClassifyText(raw)
		if payload.message != "" && failure.Category == CategoryUnknown && !failure.Structured {
			return ClassifyText(payload.message)
		}
		return failure
	}
	return ClassifyText(err.Error())
}

func ClassifyText(raw string) Failure {
	if failure, ok := persistedReferencePreparationFailure(raw); ok {
		return failure
	}
	if copy, ok := persistedTaskConstraintCopy(raw); ok {
		requestID, taskID := persistedReferenceIDs(raw)
		return normalizeFailure(Failure{Category: CategoryInvalidParams, Reason: copy.Reason, Action: copy.Action, RequestID: requestID, TaskID: taskID, FromCode: true})
	}
	failure := Failure{Category: CategoryUnknown}
	text := strings.TrimSpace(raw)
	if text == "" {
		return normalizeFailure(failure)
	}
	if f, ok := persistedModerationCopy(text); ok {
		f.RequestID, f.TaskID = persistedReferenceIDs(text)
		return normalizeFailure(f)
	}
	if copy, ok := referenceDurationCopy(text); ok {
		requestID, taskID := persistedReferenceIDs(text)
		return normalizeFailure(Failure{Category: CategoryInvalidParams, Reason: copy.Reason, Action: copy.Action, RequestID: requestID, TaskID: taskID, FromCode: true})
	}
	if copy, ok := referenceMediaConstraintCopy(text); ok {
		requestID, taskID := persistedReferenceIDs(text)
		category := CategoryInvalidParams
		if copy.Action != "" && (strings.Contains(copy.Reason, "过大") || strings.Contains(copy.Action, "压缩")) {
			category = CategoryInputTooLarge
		}
		return normalizeFailure(Failure{Category: category, Reason: copy.Reason, Action: copy.Action, RequestID: requestID, TaskID: taskID, FromCode: true})
	}
	if htmlBodyPattern.MatchString(text) {
		if status := extractExplicitHTTPStatus(text); status != 0 {
			return ClassifyHTTP(status, "", "")
		}
		return normalizeFailure(Failure{Category: CategoryMalformedResponse})
	}
	fields := extractProviderFields(text)
	vodText := text
	if fields.hasStructured() || strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[") {
		vodText = fields.Message
	}
	if copy, ok := vodImageErrorCopy(fields.Code, vodText); ok {
		copy.RequestID, copy.TaskID = sanitizeDebugID(fields.RequestID), sanitizeDebugID(fields.TaskID)
		return normalizeFailure(copy)
	}
	// Inspect only the error message, never JSON request echoes or debug fields.
	databaseMessage := text
	if fields.hasStructured() || strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[") {
		databaseMessage = fields.Message
	}
	if localDatabaseErrorPattern.MatchString(databaseMessage) {
		return normalizeFailure(Failure{Category: CategoryLocalStorage, FromCode: true, RequestID: sanitizeDebugID(fields.RequestID), TaskID: sanitizeDebugID(fields.TaskID)})
	}
	if isLocalDiskFullMessage(databaseMessage) {
		return normalizeFailure(Failure{Category: CategoryLocalDiskFull, FromCode: true})
	}
	if fields.hasStructured() {
		if strings.Contains(fields.Message, "暂无可用渠道") || strings.Contains(fields.Message, "无可用渠道") {
			return normalizeFailure(Failure{Category: CategoryProviderUnavailable, Structured: true, ProviderCode: sanitizeProviderCode(fields.Code), ProviderMessage: sanitizeProviderText(fields.Message), RequestID: fields.RequestID})
		}
		if strings.EqualFold(fields.Code, "invalid_reference_audio") {
			copy, _ := referenceAudioCopy(fields.Message, true)
			return normalizeFailure(Failure{Category: CategoryInvalidParams, Reason: copy.Reason, Action: copy.Action, RequestID: fields.RequestID, TaskID: fields.TaskID, ProviderCode: fields.Code, Structured: true, FromCode: true})
		}
		if copy, ok := referenceDurationCopy(fields.Message); ok {
			return normalizeFailure(Failure{Category: CategoryInvalidParams, Reason: copy.Reason, Action: copy.Action, RequestID: fields.RequestID, TaskID: fields.TaskID, ProviderCode: sanitizeProviderCode(fields.Code), Structured: true, FromCode: true})
		}
		failure.Structured = true
		failure.ProviderCode = sanitizeProviderCode(fields.Code)
		failure.ProviderMessage = sanitizeProviderText(fields.Message)
		failure.Param = sanitizeProviderCode(fields.Param)
		failure.RequestID = sanitizeDebugID(fields.RequestID)
		failure.TaskID = sanitizeDebugID(fields.TaskID)
		if category, ok := categoryFromProviderCode(fields.Code, fields.Type, fields.Status); ok {
			failure.Category = category
			_, codeOrStatusKnown := categoryFromProviderCode(fields.Code, fields.Status)
			failure.FromCode = codeOrStatusKnown || !genericProviderCode(fields.Type)
			refineInvalidParams(&failure, fields)
			specializeModeration(&failure, fields)
			specializeThinkingToolChoice(&failure, fields)
			specializeDurationRange(&failure, fields)
			specializeMediaConstraints(&failure, fields)
			if failure.Category != CategoryInvalidParams || failure.Reason != "" {
				failure.FromCode = true
			}
			return normalizeFailure(failure)
		}
		if category, ok := categoryFromProviderMessage(fields.Message + " " + fields.Type + " " + fields.Status); ok {
			failure.Category = category
			specializeModeration(&failure, fields)
			specializeThinkingToolChoice(&failure, fields)
			specializeDurationRange(&failure, fields)
			specializeMediaConstraints(&failure, fields)
			if failure.Reason != "" {
				failure.FromCode = true
			}
			return normalizeFailure(failure)
		}
		// JSON request echoes and debug fields are never classification input.
		return normalizeFailure(failure)
	}
	if strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[") {
		failure.Structured = true
		return normalizeFailure(failure)
	}
	if copy, ok := outboundPolicyCopy(text); ok {
		requestID, taskID := persistedReferenceIDs(text)
		return normalizeFailure(Failure{Category: CategoryNetwork, Reason: copy.Reason, Action: copy.Action,
			Structured: true, RequestID: requestID, TaskID: taskID, HTTPStatus: extractExplicitHTTPStatus(text)})
	}
	if matched := matchPersistedCategory(text); matched != CategoryUnknown {
		failure.Category = matched
		failure.FromCode = true
		failure.RequestID, failure.TaskID = persistedReferenceIDs(text)
		if matched == CategoryTimeout || matched == CategoryDownloadFailed || matched == CategorySubmissionUncertain {
			failure.Uncertain = true
		}
		return normalizeFailure(failure)
	}
	if isMalformedText(text) {
		failure.Category = CategoryMalformedResponse
		return normalizeFailure(failure)
	}
	if category, ok := categoryFromProviderMessage(text); ok {
		failure.Category = category
		failure.Structured = true
		if copy, ok := taskConstraintCopy(text); ok {
			failure.Reason, failure.Action = copy.Reason, copy.Action
		}
		specializeModeration(&failure, extractedFields{Message: text})
		specializeThinkingToolChoice(&failure, extractedFields{Message: text})
		specializeDurationRange(&failure, extractedFields{Message: text})
		specializeMediaConstraints(&failure, extractedFields{Message: text})
		if failure.Reason != "" {
			failure.FromCode = true
		}
		if status := extractExplicitHTTPStatus(text); status != 0 {
			failure.HTTPStatus = status
		}
		return normalizeFailure(failure)
	}
	if isNetworkText(text) {
		failure.Category = CategoryNetwork
		return normalizeFailure(failure)
	}
	if isDownloadText(text) {
		failure.Category = CategoryDownloadFailed
		failure.Uncertain = true
		return normalizeFailure(failure)
	}
	if isCancelledText(text) {
		failure.Category = CategoryCancelled
		return normalizeFailure(failure)
	}
	if isResultsMissingText(text) {
		failure.Category = CategoryResultsMissing
		return normalizeFailure(failure)
	}
	if status := extractExplicitHTTPStatus(text); status != 0 {
		return ClassifyHTTP(status, "", "")
	}
	if looksLikeUserFacingChinese(text) {
		failure.Reason = sanitizeProviderText(text)
		failure.Action = ""
	}
	return normalizeFailure(failure)
}

func ClassifyAppError(status int, code int, reason string, message string) Failure {
	failure := ClassifyHTTP(status, "", firstNonEmpty(message, reason))
	if !failure.Structured && !failure.FromCode {
		category, matched := categoryFromProviderCode(reason)
		switch code {
		case 40301:
			category, matched = CategoryQuotaUnknown, true
		case 42901:
			category, matched = CategoryThrottled, true
		}
		if matched {
			failure.Category = category
			failure.FromCode = true
			failure.Reason, failure.Action = "", ""
		}
	}
	return normalizeFailure(failure)
}

func trustProviderMessageStatus(status int) bool {
	if status >= 200 && status < 300 {
		return true
	}
	switch status {
	case http.StatusBadRequest, http.StatusPaymentRequired, http.StatusConflict, http.StatusRequestEntityTooLarge, http.StatusUnprocessableEntity, http.StatusTooManyRequests, 451:
		return true
	}
	return false
}

func categoryFromHTTPStatus(status int) (FailureCategory, bool) {
	switch status {
	case http.StatusUnauthorized:
		return CategoryAuth, true
	case http.StatusForbidden:
		return CategoryPermission, true
	case http.StatusPaymentRequired:
		return CategoryQuotaUnknown, true
	case http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusNotImplemented:
		return CategoryModelMissing, true
	case http.StatusRequestTimeout, http.StatusGatewayTimeout, 524:
		return CategoryTimeout, true
	case http.StatusConflict:
		return CategoryInvalidParams, true
	case http.StatusRequestEntityTooLarge:
		return CategoryInputTooLarge, true
	case http.StatusUnprocessableEntity, http.StatusBadRequest:
		return CategoryInvalidParams, true
	case http.StatusTooManyRequests:
		return CategoryThrottled, true
	case http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable:
		return CategoryProviderUnavailable, true
	}
	if status >= 500 {
		return CategoryProviderUnavailable, true
	}
	return CategoryUnknown, status != 0
}

func normalizeFailure(failure Failure) Failure {
	if failure.Category == "" {
		failure.Category = CategoryUnknown
	}
	if failure.IsModeration() {
		failure.Retryable = false
	}
	if failure.Category == CategorySubmissionUncertain {
		failure.Uncertain = true
	}
	applyRetryable(&failure)
	reason, action := failure.displayCopy()
	failure.Reason = reason
	failure.Action = action
	return failure
}
