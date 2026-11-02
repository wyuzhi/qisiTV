package generation

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var (
	localDatabaseErrorPattern = regexp.MustCompile(`(?i)(?:^|:\s*)(?:table\s+[a-z0-9_]+\s+has no column named\s+[a-z0-9_]+|no such (?:column|table):\s*[a-z0-9_.]+|(?:UNIQUE|NOT NULL|CHECK) constraint failed:\s*\S+|FOREIGN KEY constraint failed|database (?:is locked|is malformed)|database disk image is malformed|attempt to write a readonly database|disk I/O error)(?:\b|$)`)
	durationRangePattern      = regexp.MustCompile(`(?i)\bduration\s+(?:must\s+be|should\s+be|is\s+required\s+to\s+be)\s+(?:between\s+([0-9]+(?:\.[0-9]+)?)\s*(?:seconds?|secs?|s)?\s+and\s+([0-9]+(?:\.[0-9]+)?)|in\s+(?:the\s+)?range\s*\[?([0-9]+(?:\.[0-9]+)?)\s*[,–-]\s*([0-9]+(?:\.[0-9]+)?)\]?)\s*(?:seconds?|secs?|s)\b`)
	widthRangePattern         = regexp.MustCompile(`(?i)\bwidth\s+(?:must\s+be|should\s+be)\s+between\s+(\d+)\s*(?:px|pixels?)?\s+and\s+(\d+)\s*(?:px|pixels?)`)
	heightRangePattern        = regexp.MustCompile(`(?i)\bheight\s+(?:must\s+be|should\s+be)\s+between\s+(\d+)\s*(?:px|pixels?)?\s+and\s+(\d+)\s*(?:px|pixels?)`)
	aspectRangePattern        = regexp.MustCompile(`(?i)aspect(?:\s*ratio)?\s+(?:must\s+be|should\s+be)\s+between\s+(\d+(?:\.\d+)?)\s+and\s+(\d+(?:\.\d+)?)`)
	pixelRangePattern         = regexp.MustCompile(`(?i)(?:pixel(?:s)?(?:\s+count)?|total\s+pixels)\s+(?:must\s+be|should\s+be)\s+between\s+(\d+)\s+and\s+(\d+)`)
	requestTooLargePattern    = regexp.MustCompile(`(?i)(?:request\s+(?:body|entity|payload)|payload)\s+(?:is\s+)?too\s+large|(?:request|payload).{0,24}(?:exceeds?|larger than)`)
	singleFileTooLargePattern = regexp.MustCompile(`(?i)(?:file|image|video|audio)\s+too\s+large|(?:file|image|video|audio).{0,24}(?:exceeds?|larger than)\s+\d+`)
)

func isLocalDiskFullMessage(message string) bool {
	text := strings.ToLower(message)
	local := strings.Contains(text, "write local resource") || strings.Contains(text, "生成内容写入资源存储失败") || strings.Contains(text, "database or disk is full") || strings.Contains(text, "本地磁盘空间不足")
	full := strings.Contains(text, "no space left on device") || strings.Contains(text, "not enough space on the disk") || strings.Contains(text, "disk full") || strings.Contains(text, "database or disk is full") || strings.Contains(text, "本地磁盘空间不足")
	return local && full
}

func WithDownloadFailure(failure Failure, taskID string) Failure {
	if failure.Category == CategoryLocalDiskFull || failure.Category == CategoryLocalCredential || failure.Category == CategoryLocalStorage {
		failure.TaskID = firstNonEmpty(failure.TaskID, taskID)
		return normalizeFailure(failure)
	}
	if failure.Category == CategoryAuth || failure.Category == CategoryPermission || failure.IsModeration() || failure.Category == CategoryInvalidParams || failure.Category == CategoryDeliveryFailed {
		failure.TaskID = firstNonEmpty(failure.TaskID, taskID)
		return normalizeFailure(failure)
	}
	failure.Category = CategoryDownloadFailed
	failure.Uncertain = true
	failure.Reason = ""
	failure.Action = ""
	failure.TaskID = firstNonEmpty(failure.TaskID, taskID)
	return normalizeFailure(failure)
}

func WithConcurrencyFailure(failure Failure) Failure {
	if failure.Structured && failure.Category != CategoryUnknown {
		return failure
	}
	failure.Category = CategoryConcurrency
	failure.Reason = ""
	failure.Action = ""
	return normalizeFailure(failure)
}

func CircuitOpenFailure() Failure {
	return normalizeFailure(Failure{
		Category: CategoryProviderUnavailable,
		Reason:   "当前渠道连续失败，已暂时熔断",
		Action:   "请稍后重试",
	})
}

func categoryFromProviderMessage(raw string) (FailureCategory, bool) {
	normalized := strings.ToLower(strings.TrimSpace(promptEchoPattern.ReplaceAllString(raw, "")))
	if _, ok := taskConstraintCopy(normalized); ok {
		return CategoryInvalidParams, true
	}
	if normalized == "" {
		return "", false
	}
	if f, ok := moderationErrorCopy("", normalized); ok {
		return f.Category, true
	}
	switch {
	case durationRangePattern.MatchString(normalized),
		widthRangePattern.MatchString(normalized),
		heightRangePattern.MatchString(normalized),
		aspectRangePattern.MatchString(normalized),
		pixelRangePattern.MatchString(normalized):
		return CategoryInvalidParams, true
	case requestTooLargePattern.MatchString(normalized) || singleFileTooLargePattern.MatchString(normalized) || strings.HasPrefix(normalized, "整次请求的数据量超过接口上限"):
		return CategoryInputTooLarge, true
	case strings.Contains(normalized, "thinking") && strings.Contains(normalized, "tool_choice"),
		strings.Contains(normalized, "reasoning") && strings.Contains(normalized, "tool_choice"),
		strings.Contains(normalized, "tool_choice") && (strings.Contains(normalized, "not support") || strings.Contains(normalized, "unsupported")):
		return CategoryInvalidParams, true
	case containsContentSafety(normalized):
		return moderationCategoryFromMessage(normalized), true
	case strings.Contains(normalized, "insufficient_quota") || ((strings.Contains(normalized, "quota") || strings.Contains(normalized, "balance") || strings.Contains(normalized, "额度") || strings.Contains(normalized, "余额") || strings.Contains(normalized, "欠费")) && !strings.Contains(normalized, "rate")):
		if strings.Contains(normalized, "arrearage") || strings.Contains(normalized, "billing_hard_limit") || strings.Contains(normalized, "供应商") {
			return CategoryQuotaUpstream, true
		}
		return CategoryQuotaUnknown, true
	case strings.Contains(normalized, "rate limit") || strings.Contains(normalized, "too many requests") || strings.Contains(normalized, "throttl") || strings.Contains(normalized, "频繁"):
		return CategoryThrottled, true
	case strings.Contains(normalized, "context length") || strings.Contains(normalized, "maximum context") || strings.Contains(normalized, "too many tokens") || strings.Contains(normalized, "max_tokens") || strings.Contains(normalized, "长度") && (strings.Contains(normalized, "最大") || strings.Contains(normalized, "超出")):
		return CategoryContextTooLong, true
	case strings.Contains(normalized, "model_not_found") || strings.Contains(normalized, "model not found") || strings.Contains(normalized, "does not exist") && strings.Contains(normalized, "model") || strings.Contains(normalized, "模型不存在") || strings.Contains(normalized, "模型或模型接口不存在") || strings.Contains(normalized, "405 method not allowed") || strings.Contains(normalized, "method not allowed") || strings.Contains(normalized, "http 405") || strings.Contains(normalized, "status 405"):
		return CategoryModelMissing, true
	case strings.Contains(normalized, "invalid api key") || strings.Contains(normalized, "incorrect api key") || strings.Contains(normalized, "authentication") || strings.Contains(normalized, "unauthorized") || strings.Contains(normalized, "鉴权失败"):
		return CategoryAuth, true
	case strings.Contains(normalized, "permission") && (strings.Contains(normalized, "denied") || strings.Contains(normalized, "model") || strings.Contains(normalized, "access")):
		return CategoryPermission, true
	case strings.Contains(normalized, "url error") || strings.Contains(normalized, "failed to download") || strings.Contains(normalized, "cannot fetch") || strings.Contains(normalized, "invalid image url") || strings.Contains(normalized, "无法读取"):
		return CategoryInputInaccessible, true
	case strings.Contains(normalized, "too large") || strings.Contains(normalized, "payload too large") || strings.Contains(normalized, "file size") || strings.Contains(normalized, "过大"):
		return CategoryInputTooLarge, true
	case strings.Contains(normalized, "invalid") || strings.Contains(normalized, "parameter") || strings.Contains(normalized, "argument") || strings.Contains(normalized, "请检查模型和参数"):
		return CategoryInvalidParams, true
	}
	return "", false
}

func containsContentSafety(normalized string) bool {
	if strings.Contains(normalized, "rejected by the safety system") || strings.Contains(normalized, "rejected as a result of our safety system") || strings.Contains(normalized, "rejected as a result of the safety system") || strings.Contains(normalized, "contentmoderationfailed") || strings.Contains(normalized, "invalidparameter.voilationcontent") || strings.Contains(normalized, "invalidparameter.violationcontent") || strings.Contains(normalized, "上游内容安全策略") {
		return true
	}
	if strings.Contains(normalized, "sensitive_words_detected") || strings.Contains(normalized, "content policy") || strings.Contains(normalized, "content safety") || strings.Contains(normalized, "safety policy") || strings.Contains(normalized, "data inspection") || strings.Contains(normalized, "prohibited_content") || strings.Contains(normalized, "内容安全审核") || strings.Contains(normalized, "内容审核未通过") {
		return true
	}
	if strings.Contains(normalized, "moderation") || strings.Contains(normalized, "blocked by") && (strings.Contains(normalized, "safety") || strings.Contains(normalized, "policy") || strings.Contains(normalized, "content")) {
		return true
	}
	if strings.Contains(normalized, "safety") && (strings.Contains(normalized, "blocked") || strings.Contains(normalized, "violat") || strings.Contains(normalized, "filter")) {
		return true
	}
	return false
}

func moderationCategoryFromMessage(normalized string) FailureCategory {
	if strings.Contains(normalized, "output") && (strings.Contains(normalized, "image") || strings.Contains(normalized, "video") || strings.Contains(normalized, "result")) || strings.Contains(normalized, "生成结果") {
		return CategoryModerationOutput
	}
	if strings.Contains(normalized, "reference image") || strings.Contains(normalized, "input image") || strings.Contains(normalized, "参考图") || strings.Contains(normalized, "参考图片") {
		return CategoryModerationReference
	}
	return CategoryModerationInput
}

func hasAuthoritativeProviderCode(fields extractedFields) bool {
	if _, ok := categoryFromProviderCode(fields.Code); ok && !genericProviderCode(fields.Code) {
		return true
	}
	if _, ok := categoryFromProviderCode(fields.Status); ok && !genericProviderCode(fields.Status) {
		return true
	}
	if _, ok := categoryFromProviderCode(fields.Type); ok && !genericProviderCode(fields.Type) {
		return true
	}
	return false
}

func specializeModeration(failure *Failure, fields extractedFields) {
	refinableCode := !hasAuthoritativeProviderCode(fields)
	if f, ok := persistedModerationCopy(fields.Message); ok && (failure.Category == f.Category || (refinableCode && (failure.Category == CategoryUnknown || failure.Category == CategoryInvalidParams))) {
		failure.Category, failure.Reason, failure.Action = f.Category, f.Reason, f.Action
		requestID, taskID := persistedReferenceIDs(fields.Message)
		failure.RequestID = firstNonEmpty(failure.RequestID, requestID)
		failure.TaskID = firstNonEmpty(failure.TaskID, taskID)
		return
	}
	if failure.RequestID == "" {
		failure.RequestID = requestIDFromMessage(fields.Message)
	}
	if failure.IsModeration() || ((failure.Category == CategoryUnknown || failure.Category == CategoryInvalidParams) && refinableCode) {
		if f, ok := moderationErrorCopy(fields.Code, sanitizeProviderText(fields.Message)); ok {
			failure.Category, failure.Reason, failure.Action = f.Category, f.Reason, f.Action
			return
		}
	}
	if !failure.IsModeration() {
		return
	}
	for _, code := range []string{fields.Code, fields.Type, fields.Status} {
		if _, ok := categoryCopies[FailureCategory(normalizeCode(code))]; ok {
			return
		}
	}
	normalized := strings.ToLower(fields.Message + " " + fields.Code)
	if (strings.Contains(normalized, "prompt") || strings.Contains(normalized, "提示词")) && (strings.Contains(normalized, "reference image") || strings.Contains(normalized, "input image") || strings.Contains(normalized, "参考")) {
		failure.Category = CategoryModerationInput
		failure.Reason = "提示词或参考素材未通过内容安全审核"
		failure.Action = "请调整提示词或参考素材后重新生成"
		return
	}
	failure.Category = moderationCategoryFromMessage(normalized)
}

func refineInvalidParams(failure *Failure, fields extractedFields) {
	if !hasAuthoritativeProviderCode(fields) && (failure.Category == CategoryUnknown || failure.Category == CategoryInvalidParams) {
		if category, ok := categoryFromProviderMessage(fields.Message); ok {
			failure.Category = category
		}
	}
	if failure.Category != CategoryInvalidParams {
		return
	}
	if category, ok := categoryFromProviderMessage(fields.Message); ok {
		switch category {
		case CategoryContextTooLong, CategoryInputInaccessible, CategoryInputTooLarge, CategoryModelMissing:
			failure.Category = category
		}
	}
}

func specializeThinkingToolChoice(failure *Failure, fields extractedFields) {
	if failure.Category != CategoryInvalidParams {
		return
	}
	normalized := strings.ToLower(fields.Message + " " + fields.Code)
	if ((strings.Contains(normalized, "thinking") || strings.Contains(normalized, "reasoning")) && strings.Contains(normalized, "tool_choice")) || (strings.Contains(normalized, "tool_choice") && (strings.Contains(normalized, "not support") || strings.Contains(normalized, "unsupported"))) {
		failure.Category = CategoryInvalidParams
		failure.Reason = "当前模型为思考或推理模式，不支持强制工具调用"
		failure.Action = "请改用自动工具选择或更换非思考模式模型"
	}
}

func referenceDurationCopy(text string) (categoryCopy, bool) {
	if copy, ok := referenceAudioCopy(text, false); ok {
		return copy, true
	}
	// 当前提示写法：哪一项、现在多少、要改到多少，动作沿用后端给出的那句。
	if m := regexp.MustCompile(`^((?:第 \d+ 段)?(?:参考)?(?:音频|视频)(?:「[^」]*」)?)时长为 (\d+(?:\.\d+)?) 秒[，。]需要改到 ([^；;]+)[；;](.+?)。?$`).FindStringSubmatch(text); len(m) == 5 {
		return categoryCopy{Reason: fmt.Sprintf("%s时长为 %s 秒", m[1], m[2]), Action: fmt.Sprintf("需要改到 %s；%s", m[3], m[4])}, true
	}
	if m := regexp.MustCompile(`^输出时长为 ([\d.]+) 秒[，。]当前模型只支持 ([^；;]+)[；;](.+?)。?$`).FindStringSubmatch(text); len(m) == 4 {
		return categoryCopy{Reason: fmt.Sprintf("输出时长为 %s 秒", m[1]), Action: fmt.Sprintf("当前模型只支持 %s；%s", m[2], m[3])}, true
	}
	if m := regexp.MustCompile(`^第 (\d+) 段参考(音频|视频)时长为 (\d+(?:\.\d+)?) 秒[，。]需要 (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?) 秒`).FindStringSubmatch(text); len(m) == 6 {
		return categoryCopy{Reason: fmt.Sprintf("第 %s 段参考%s时长为 %s 秒", m[1], m[2], m[3]), Action: fmt.Sprintf("需要 %s–%s 秒；请裁剪或更换这段素材后再提交", m[4], m[5])}, true
	}
	if m := regexp.MustCompile(`^第 (\d+) 段参考(音频|视频)的时长无法读取`).FindStringSubmatch(text); len(m) == 3 {
		return categoryCopy{Reason: fmt.Sprintf("第 %s 段参考%s的时长无法读取", m[1], m[2]), Action: "请重新导入素材后再提交"}, true
	}
	if m := regexp.MustCompile(`^参考素材时长不符合模型要求。请检查每段参考音频和视频，将不符合要求的素材调整为 (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?) 秒`).FindStringSubmatch(text); len(m) == 3 {
		return categoryCopy{Reason: "参考素材时长不符合模型要求", Action: fmt.Sprintf("请检查每段参考音频和视频，将不符合要求的素材调整为 %s–%s 秒后重新提交", m[1], m[2])}, true
	}
	return categoryCopy{}, false
}

func specializeMediaConstraints(failure *Failure, fields extractedFields) {
	if failure.Category != CategoryUnknown && failure.Category != CategoryInvalidParams && failure.Category != CategoryInputTooLarge && failure.Category != CategoryInputInaccessible {
		return
	}
	message := promptEchoPattern.ReplaceAllString(fields.Message, "")
	if strings.EqualFold(fields.Code, "invalid_upscale_source") {
		lower := strings.ToLower(message)
		if strings.Contains(lower, "video") {
			failure.Category = CategoryInvalidParams
			failure.Reason = "超分视频素材不符合要求"
			failure.Action = "请使用 5 分钟以内、200MB 以内的有效 MP4/MOV 视频后重试"
			return
		}
		if strings.Contains(lower, "image") {
			failure.Category = CategoryInvalidParams
			failure.Reason = "超分图片素材不符合要求"
			failure.Action = "请使用 30MB 以内、像素不超过 3200 万的 JPEG/PNG/WebP 图片后重试"
			return
		}
	}
	if failure.Category == CategoryInvalidParams || failure.Category == CategoryUnknown {
		if copy, ok := persistedTaskConstraintCopy(message); ok {
			failure.Category, failure.Reason, failure.Action = CategoryInvalidParams, copy.Reason, copy.Action
			requestID, taskID := persistedReferenceIDs(message)
			if failure.RequestID == "" {
				failure.RequestID = requestID
			}
			if failure.TaskID == "" {
				failure.TaskID = taskID
			}
			return
		}
		if copy, ok := taskConstraintCopy(fields.Code + " " + message); ok {
			failure.Category, failure.Reason, failure.Action = CategoryInvalidParams, copy.Reason, copy.Action
			return
		}
	}
	if copy, ok := referenceMediaConstraintCopy(message); ok {
		if strings.Contains(copy.Reason, "过大") {
			failure.Category = CategoryInputTooLarge
		} else {
			failure.Category = CategoryInvalidParams
		}
		failure.Reason = copy.Reason
		failure.Action = copy.Action
		return
	}
	if match := heightRangePattern.FindStringSubmatch(message); len(match) == 3 {
		failure.Category = CategoryInvalidParams
		failure.Reason = "参考素材高度不符合模型要求"
		failure.Action = fmt.Sprintf("请将高度调整为 %s–%s 像素后重新提交", match[1], match[2])
		return
	}
	if match := widthRangePattern.FindStringSubmatch(message); len(match) == 3 {
		failure.Category = CategoryInvalidParams
		failure.Reason = "参考素材宽度不符合模型要求"
		failure.Action = fmt.Sprintf("请将宽度调整为 %s–%s 像素后重新提交", match[1], match[2])
		return
	}
	if match := aspectRangePattern.FindStringSubmatch(message); len(match) == 3 {
		failure.Category = CategoryInvalidParams
		failure.Reason = "参考素材宽高比不符合模型要求"
		failure.Action = fmt.Sprintf("请将宽高比调整为 %s–%s 后重新提交", match[1], match[2])
		return
	}
	if match := pixelRangePattern.FindStringSubmatch(message); len(match) == 3 {
		failure.Category = CategoryInvalidParams
		failure.Reason = "参考素材像素总量不符合模型要求"
		failure.Action = fmt.Sprintf("请将参考素材的宽×高调整到 %s–%s 像素；修改生成分辨率不会改变参考素材", match[1], match[2])
		return
	}
	if requestTooLargePattern.MatchString(message) || strings.EqualFold(fields.Code, "video_request_body_too_large") || strings.HasPrefix(message, "整次请求的数据量超过接口上限") {
		failure.Category = CategoryInputTooLarge
		failure.Reason = "整次请求的数据量超过接口上限"
		failure.Action = "请减少参考素材，或改用可公开访问的素材链接后再提交"
		return
	}
	if singleFileTooLargePattern.MatchString(message) {
		failure.Category = CategoryInputTooLarge
		failure.Reason = "单个参考文件过大"
		failure.Action = "请压缩或更换该素材后再提交"
	}
}

func referenceMediaConstraintCopy(text string) (categoryCopy, bool) {
	if strings.HasPrefix(text, "当前渠道需要在线素材链接：") {
		reason, action, _ := strings.Cut(text, "。")
		return categoryCopy{Reason: reason, Action: action}, true
	}
	if strings.Contains(text, "当前模型协议要求公网素材地址") || strings.Contains(text, "当前 JSON 视频协议的参考素材不能使用内嵌数据") {
		return categoryCopy{Reason: "当前渠道暂不支持直接使用本地素材", Action: "请使用可访问的 HTTPS 素材链接，或选择支持本地素材的渠道"}, true
	}
	if strings.HasPrefix(text, "当前渠道暂不支持直接使用本地素材") {
		return categoryCopy{Reason: "当前渠道暂不支持直接使用本地素材", Action: "请使用可访问的 HTTPS 素材链接，或选择支持本地素材的渠道"}, true
	}
	if m := regexp.MustCompile(`^(当前模型(?:暂不支持参考(?:图片|视频|音频)|最多支持 \d+ 个参考(?:图片|视频|音频)))[，。](请[^\n]+)`).FindStringSubmatch(text); len(m) == 3 {
		return categoryCopy{Reason: m[1], Action: m[2]}, true
	}
	text = strings.SplitN(text, "。排查编号：", 2)[0]
	if m := regexp.MustCompile(`^(第 \d+ 个参考视频帧率无法读取)`).FindStringSubmatch(text); len(m) == 2 {
		return categoryCopy{Reason: m[1], Action: "请重新导出 MP4/MOV 视频后上传，确保文件完整且包含有效的视频轨"}, true
	}
	if m := regexp.MustCompile(`^(第 \d+ 个参考视频平均帧率为 \d+(?:\.\d+)? FPS)[，。](?:需要 |请将参考视频重新导出为 )(\d+)–(\d+) FPS`).FindStringSubmatch(text); len(m) == 4 {
		return categoryCopy{Reason: m[1], Action: "请将参考视频重新导出为 " + m[2] + "–" + m[3] + " FPS 后再提交"}, true
	}
	if m := regexp.MustCompile(`(?i)^(?:素材转换失败:\s*)?(?:frame rate|framerate|fps) must be between (\d+(?:\.\d+)?)\s*(?:fps)? and (\d+(?:\.\d+)?)[.\s]*$`).FindStringSubmatch(text); len(m) == 3 {
		return categoryCopy{Reason: "参考视频帧率不符合要求", Action: "请将参考视频重新导出为 " + m[1] + "–" + m[2] + " FPS 后再提交"}, true
	}
	if strings.HasPrefix(text, "参考视频帧率不符合要求。请将参考视频重新导出为 ") {
		parts := strings.SplitN(text, "。", 2)
		return categoryCopy{Reason: parts[0], Action: parts[1]}, true
	}
	if regexp.MustCompile(`(?i)^(?:(?:素材转换失败:\s*)?(?:unsupported (?:video |audio )?codec|(?:video |audio )?codec (?:is )?not supported)[.\s]*$|参考素材编码不受当前模型支持。)`).MatchString(text) {
		return categoryCopy{Reason: "参考素材编码不受当前模型支持", Action: "请将视频重新导出为常见的 H.264 MP4，音频重新导出为 MP3 或 WAV 后替换素材；只修改文件后缀无效"}, true
	}
	if regexp.MustCompile(`(?i)^(?:asset (?:is )?(?:not ready|still processing)[.\s]*$|参考素材仍在处理中。)`).MatchString(text) {
		return categoryCopy{Reason: "参考素材仍在处理中", Action: "请在素材库确认处理完成后再生成，不要重复上传或反复提交"}, true
	}
	if regexp.MustCompile(`(?i)^(?:asset (?:access denied|permission denied|forbidden)[.\s]*$|无权访问参考素材。)`).MatchString(text) {
		return categoryCopy{Reason: "无权访问参考素材", Action: "请使用上传该素材的账号与渠道，或重新上传原文件；检查素材权限，无需修改提示词"}, true
	}
	if m := regexp.MustCompile(`^(参考素材像素总量不符合模型要求)。((?:请将参考素材的宽×高调整到) \d+–\d+ 像素[^{}]*)$`).FindStringSubmatch(text); len(m) == 3 {
		return categoryCopy{Reason: m[1], Action: m[2]}, true
	}

	if m := regexp.MustCompile(`^(第 \d+ 个参考视频(?:无法读取|格式或地址不支持|文件过大|尺寸为 \d+×\d+|时长为 \d+(?:\.\d+)? 秒|像素总量为 \d+（\d+×\d+）))[。]([^{}]+)$`).FindStringSubmatch(text); len(m) == 3 {
		return categoryCopy{Reason: m[1], Action: m[2]}, true
	}

	if m := regexp.MustCompile(`^参考素材(宽度|高度|宽高比)不符合模型要求。请将(?:宽度|高度|宽高比)调整为 (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?)( 像素| )后重新提交`).FindStringSubmatch(text); len(m) == 5 {
		return categoryCopy{Reason: "参考素材" + m[1] + "不符合模型要求", Action: "请将" + m[1] + "调整为 " + m[2] + "–" + m[3] + m[4] + "后重新提交"}, true
	}
	if m := regexp.MustCompile(`^(第 \d+ 个参考视频时长为 \d+(?:\.\d+)? 秒)，需要 (\d+)–(\d+) 秒`).FindStringSubmatch(text); len(m) == 4 {
		return categoryCopy{Reason: m[1], Action: "请将这段参考视频裁剪或更换为 " + m[2] + "–" + m[3] + " 秒"}, true
	}
	if m := regexp.MustCompile(`^第 (\d+) 个参考视频[：:]?(?:参考视频)?(?:尺寸|时长)?(?:下载失败|无法读取|无法完整读取|数据无法读取|分段读取失败|在读取期间发生变化|时长无法读取|尺寸无法读取)`).FindStringSubmatch(text); len(m) == 2 {
		return categoryCopy{Reason: "第 " + m[1] + " 个参考视频无法读取", Action: "请检查素材链接，或重新导出 MP4/MOV 文件后导入"}, true
	}
	if m := regexp.MustCompile(`^第 (\d+) 个参考视频[：:]?(?:参考视频)?需使用`).FindStringSubmatch(text); len(m) == 2 {
		return categoryCopy{Reason: "第 " + m[1] + " 个参考视频格式或地址不支持", Action: "请导入 MP4/MOV 文件，或使用可公开访问的 HTTP/HTTPS 视频链接"}, true
	}
	if m := regexp.MustCompile(`^第 (\d+) 个参考视频[：:]?(?:参考视频)?文件不能超过 (\d+)MB`).FindStringSubmatch(text); len(m) == 3 {
		return categoryCopy{Reason: "第 " + m[1] + " 个参考视频文件过大", Action: "请压缩至 " + m[2] + "MB 以内或更换素材"}, true
	}
	if m := regexp.MustCompile(`^(第 \d+ 个参考视频尺寸为 \d+×\d+)，需要宽高均在 (\d+)–(\d+) 像素之间`).FindStringSubmatch(text); len(m) == 4 {
		return categoryCopy{Reason: m[1], Action: "请将这段参考视频的宽和高均调整到 " + m[2] + "–" + m[3] + " 像素"}, true
	}
	if m := regexp.MustCompile(`^(第 \d+ (?:张|个|段)参考(?:图|视频|音频)(?:宽度|高度|宽高比|时长)为 \d+(?:\.\d+)?(?: 像素| 秒)?)[，。]需要 ((?:至少|不超过) \d+(?:\.\d+)?(?: 像素| 秒)?)`).FindStringSubmatch(text); len(m) == 3 {
		action := "请调整尺寸或更换后再提交"
		if strings.Contains(m[1], "时长") {
			action = "请裁剪或更换这段素材后再提交"
		}
		return categoryCopy{Reason: m[1], Action: "需要 " + m[2] + "；" + action}, true
	}
	if m := regexp.MustCompile(`^第 (\d+) (张|个|段)参考(图|视频|音频)(宽度|高度)为 (\d+) 像素[，。]需要 (\d+)–(\d+) 像素`).FindStringSubmatch(text); len(m) == 8 {
		return categoryCopy{Reason: fmt.Sprintf("第 %s %s参考%s%s为 %s 像素", m[1], m[2], m[3], m[4], m[5]), Action: fmt.Sprintf("需要 %s–%s 像素；请调整尺寸或更换后再提交", m[6], m[7])}, true
	}
	if m := regexp.MustCompile(`^第 (\d+) (张|个|段)参考(图|视频|音频)宽高比为 (\d+(?:\.\d+)?)[，。]需要 (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?)`).FindStringSubmatch(text); len(m) == 7 {
		return categoryCopy{Reason: fmt.Sprintf("第 %s %s参考%s宽高比为 %s", m[1], m[2], m[3], m[4]), Action: fmt.Sprintf("需要 %s–%s；请调整尺寸或更换后再提交", m[5], m[6])}, true
	}
	if m := regexp.MustCompile(`^(第 \d+ (?:张|个|段)参考(?:图|视频|音频)像素总量为 \d+（\d+×\d+）)，需要 ([^；]+) 像素`).FindStringSubmatch(text); len(m) == 3 {
		return categoryCopy{Reason: m[1], Action: fmt.Sprintf("需要 %s 像素；请调整这份素材的尺寸或更换原文件，修改生成分辨率不会改变参考素材", m[2])}, true
	}
	if m := regexp.MustCompile(`^(第 \d+ 个参考视频尺寸无法读取)`).FindStringSubmatch(text); len(m) == 2 {
		return categoryCopy{Reason: m[1], Action: "请重新导出 MP4/MOV 后导入"}, true
	}
	if m := regexp.MustCompile(`^第 (\d+) (张|个|段)参考(图|视频|音频)像素总量`).FindStringSubmatch(text); len(m) == 4 {
		return categoryCopy{Reason: fmt.Sprintf("第 %s %s参考%s像素总量不符合当前模型要求", m[1], m[2], m[3]), Action: "请调整尺寸或更换后再提交"}, true
	}
	if m := regexp.MustCompile(`^第 (\d+) (张|个|段)参考(图|视频|音频)文件过大[，。]当前模型单文件上限为 ([^；;]+)`).FindStringSubmatch(text); len(m) == 5 {
		return categoryCopy{Reason: fmt.Sprintf("第 %s %s参考%s文件过大", m[1], m[2], m[3]), Action: fmt.Sprintf("当前模型单文件上限为 %s；请压缩或更换后再提交", m[4])}, true
	}
	if strings.HasPrefix(text, "整次请求的参考素材合计过大") {
		return categoryCopy{Reason: "整次请求的参考素材合计过大", Action: "请减少素材后再提交"}, true
	}
	return categoryCopy{}, false
}

func specializeDurationRange(failure *Failure, fields extractedFields) {
	if failure.Category != CategoryInvalidParams {
		return
	}
	// Only a provider's explicit numeric range with units becomes advice. Prompt
	// echoes are excluded so user input cannot invent a model constraint.
	message := promptEchoPattern.ReplaceAllString(fields.Message, "")
	match := durationRangePattern.FindStringSubmatch(message)
	if len(match) != 5 {
		return
	}
	minimum, maximum := firstNonEmpty(match[1], match[3]), firstNonEmpty(match[2], match[4])
	minValue, minErr := strconv.ParseFloat(minimum, 64)
	maxValue, maxErr := strconv.ParseFloat(maximum, 64)
	if minErr != nil || maxErr != nil || minValue < 0 || minValue >= maxValue || maxValue > 86400 {
		return
	}
	failure.Reason = "视频时长不符合模型要求"
	failure.Action = fmt.Sprintf("请将时长调整为 %s–%s 秒后重试", minimum, maximum)
	if strings.Contains(message, "素材") || strings.Contains(strings.ToLower(message), "reference") || strings.Contains(strings.ToLower(message), "audio") {
		failure.Reason = "参考素材时长不符合模型要求"
		failure.Action = fmt.Sprintf("请检查每段参考音频和视频，将不符合要求的素材调整为 %s–%s 秒后重新提交", minimum, maximum)
	}
}

func isNetworkText(value string) bool {
	return regexp.MustCompile(`(?i)\b(?:dial tcp|connection refused|connection reset|forcibly closed by the remote host|software caused connection abort|connection was aborted by the software in your host machine|wsaeconnreset|wsaeconnaborted|no such host|i/o timeout|network error|failed to fetch|fetch failed|socket hang up|econnrefused|econnreset|etimedout|连接模型服务失败)\b`).MatchString(value)
}

// Only canonical local error sentences qualify, after structured upstream errors
// have been classified. Request echoes must never become local policy failures.
func outboundPolicyCopy(message string) (categoryCopy, bool) {
	message, _, _ = strings.Cut(strings.TrimSpace(message), "。")
	switch message {
	case "不允许访问链路本地、未指定或组播地址":
		return categoryCopy{
			Reason: "模型服务地址被出站安全策略拦截",
			Action: "该地址属于链路本地或云主机元数据网段，允许列表也不能放行。请改用回环或局域网地址",
		}, true
	case "不允许访问本机或内网地址", "不允许访问本机、内网或链路本地地址", "不允许访问保留地址或特殊用途地址":
		return categoryCopy{
			Reason: "模型服务地址被出站安全策略拦截",
			Action: "请检查渠道的服务地址；如需连接可信的本地或内网服务，请联系管理员仅将该主机加入允许列表后重启服务",
		}, true
	case "外部服务域名解析失败":
		return categoryCopy{
			Reason: "模型服务域名解析失败",
			Action: "请检查渠道服务地址中的域名是否正确，并确认运行 BeefTV 的设备能够正常联网和解析该域名",
		}, true
	}
	return categoryCopy{}, false
}

func isMalformedText(value string) bool {
	return regexp.MustCompile(`(?i)(?:接口返回非 JSON|没有返回有效 JSON|invalid character|unexpected end of json|<!doctype|<html)`).MatchString(value)
}

func isDownloadText(value string) bool {
	return strings.Contains(value, "视频结果下载失败") || strings.Contains(value, "下载失败") && strings.Contains(value, "结果")
}

func isCancelledText(value string) bool {
	return strings.Contains(value, "任务已取消") || strings.Contains(value, "请求已取消") || strings.Contains(strings.ToLower(value), "context canceled")
}

func isResultsMissingText(value string) bool {
	return strings.Contains(value, "没有返回图片") || strings.Contains(value, "没有返回视频") || strings.Contains(value, "没有可用结果") || strings.Contains(value, "接口没有返回")
}

func matchPersistedCategory(text string) FailureCategory {
	if strings.HasPrefix(text, "当前账号额度不足") {
		return CategoryQuotaUser
	}
	if strings.HasPrefix(text, "提示词或参考素材未通过内容安全审核") {
		return CategoryModerationInput
	}
	if strings.HasPrefix(text, "视频时长不符合模型要求") {
		return CategoryInvalidParams
	}
	for category, copyText := range categoryCopies {
		if category == CategoryUnknown {
			continue
		}
		if strings.HasPrefix(text, copyText.Reason) {
			return category
		}
	}
	if strings.Contains(text, "真人形象") {
		return CategoryModerationReference
	}
	if strings.Contains(text, "不支持强制工具调用") {
		return CategoryInvalidParams
	}
	if strings.Contains(text, "可能仍在服务端执行") || strings.Contains(text, "请勿立即重试") {
		return CategoryTimeout
	}
	return CategoryUnknown
}

func looksLikeUserFacingChinese(value string) bool {
	for _, r := range value {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}

func applyRetryable(failure *Failure) {
	switch failure.Category {
	case CategoryThrottled, CategoryProviderUnavailable, CategoryNetwork, CategoryTimeout, CategoryConcurrency, CategoryRequestNotSent:
		failure.Retryable = !failure.Uncertain
	default:
		failure.Retryable = false
	}
}
