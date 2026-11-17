package protocol

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var manifestVariableName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func validateManifestVariables(bindings []ManifestVariable, expressions ...any) error {
	known := map[string]bool{}
	var check func(any) error
	check = func(value any) error {
		switch value := value.(type) {
		case map[string]any:
			if ref, ok := value["$ref"].(string); ok && strings.HasPrefix(ref, "vars.") {
				name := strings.Split(strings.TrimPrefix(ref, "vars."), ".")[0]
				if !known[name] {
					return fmt.Errorf("unknown or forward provider variable %q", name)
				}
			}
			for _, child := range value {
				if err := check(child); err != nil {
					return err
				}
			}
		case []any:
			for _, child := range value {
				if err := check(child); err != nil {
					return err
				}
			}
		}
		return nil
	}
	for _, binding := range bindings {
		if !manifestVariableName.MatchString(binding.Name) || binding.Value == nil {
			return fmt.Errorf("provider variable requires a simple name and value")
		}
		if known[binding.Name] {
			return fmt.Errorf("duplicate provider variable %q", binding.Name)
		}
		if err := check(binding.Value); err != nil {
			return err
		}
		known[binding.Name] = true
	}
	for _, expression := range expressions {
		if err := check(expression); err != nil {
			return err
		}
	}
	return nil
}

func manifestRequestVariables(bindings []ManifestVariable, request GenerationRequest, workflow ...map[string]any) (map[string]any, error) {
	values := map[string]any{}
	env := map[string]any{"request": manifestRequestValues(request), "vars": values}
	if len(workflow) > 0 && workflow[0] != nil {
		env["workflow"] = workflow[0]
	}
	for _, binding := range bindings {
		if !manifestVariableName.MatchString(binding.Name) {
			return nil, fmt.Errorf("provider variable requires a simple name")
		}
		if _, exists := values[binding.Name]; exists {
			return nil, fmt.Errorf("duplicate provider variable %q", binding.Name)
		}
		value, err := evaluateManifestValue(binding.Value, env)
		if err != nil {
			return nil, fmt.Errorf("provider variable %s: %w", binding.Name, err)
		}
		values[binding.Name] = value
	}
	return values, nil
}

func validateManifestRequest(rules []ManifestValidation, request GenerationRequest, extras ...map[string]any) error {
	if draftTaskID, ok := request.Extra["draft_task_id"].(string); len(rules) == 0 || (ok && strings.TrimSpace(draftTaskID) != "") {
		return nil
	}
	env := map[string]any{"request": manifestRequestValues(request)}
	if len(extras) > 0 {
		env["vars"] = extras[0]
	}
	if len(extras) > 1 && extras[1] != nil {
		env["workflow"] = extras[1]
	}
	for _, rule := range rules {
		value, err := evaluateManifestValue(rule.Assert, env)
		if err != nil {
			return fmt.Errorf("协议参数校验表达式错误：%w", err)
		}
		if !manifestTruthy(value) {
			return fmt.Errorf("%s", strings.TrimSpace(rule.Message))
		}
	}
	return nil
}

func manifestResponseString(template any, env map[string]any) string {
	if template == nil {
		return ""
	}
	value, err := evaluateManifestValue(template, env)
	if err != nil {
		return ""
	}
	items := manifestArray(value)
	parts := make([]string, 0, len(items))
	for _, item := range items {
		if text := strings.TrimSpace(manifestString(item)); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "")
}

func manifestResponseMedia(template any, env map[string]any, kind string, ephemeral bool) []MediaReference {
	if template == nil {
		return nil
	}
	value, err := evaluateManifestValue(template, env)
	if err != nil {
		return nil
	}
	return mediaReferencesFromManifestValue(value, kind, ephemeral)
}

func mediaReferencesFromManifestValue(value any, kind string, ephemeral bool) []MediaReference {
	result := make([]MediaReference, 0)
	for _, item := range manifestArray(value) {
		switch typed := item.(type) {
		case string:
			trimmed := strings.TrimSpace(typed)
			if trimmed == "" {
				continue
			}
			reference := MediaReference{Kind: kind, Ephemeral: ephemeral}
			if strings.HasPrefix(trimmed, "data:") {
				reference.DataURL = trimmed
			} else {
				reference.URL = trimmed
			}
			result = append(result, reference)
		case map[string]any:
			if kind == "video" {
				if video, ok := typed["video"].(map[string]any); ok {
					typed = video
				}
			}
			reference := MediaReference{
				ID: manifestString(typed["id"]), URL: manifestString(typed["url"]), DataURL: manifestString(typed["dataUrl"]),
				Kind: defaultValue(manifestString(typed["kind"]), kind), Role: manifestString(typed["role"]), MIMEType: manifestString(typed["mimeType"]),
				Name: manifestString(typed["name"]), Order: manifestInt(typed["order"]), Weight: manifestFloat(typed["weight"]), Ephemeral: ephemeral || manifestTruthy(typed["ephemeral"]),
			}
			if metadata, ok := typed["metadata"].(map[string]any); ok {
				reference.Metadata = metadata
			}
			if reference.URL == "" {
				reference.URL = firstString(typed, "file_url", "fileUrl", "image_url", "imageUrl", "video_url", "videoUrl", "audio_url", "audioUrl", "uri")
			}
			if reference.DataURL == "" {
				reference.DataURL = firstString(typed, "data_url", "b64_json")
				if kind == "video" && reference.DataURL == "" {
					reference.DataURL = firstString(typed, "bytesBase64Encoded")
				}
			}
			// OpenAI / Ark 等渠道常直接返回裸 b64_json；声明式结果下载要求 data URL。
			reference.DataURL = normalizeManifestInlineDataURL(reference.DataURL, reference.Kind, firstString(typed, "output_format", "mime_type", "mimeType"))
			if reference.URL != "" || reference.DataURL != "" {
				result = append(result, reference)
			}
		}
	}
	return result
}

func normalizeManifestInlineDataURL(value, kind, formatHint string) string {
	value = strings.TrimSpace(value)
	if value == "" || strings.HasPrefix(value, "data:") {
		return value
	}
	return "data:" + manifestInlineMediaMIME(kind, formatHint) + ";base64," + value
}

func manifestInlineMediaMIME(kind, formatHint string) string {
	hint := strings.ToLower(strings.TrimSpace(formatHint))
	switch hint {
	case "image/png", "image/jpeg", "image/webp", "image/gif", "audio/mpeg", "audio/wav", "audio/ogg", "video/mp4", "video/webm":
		return hint
	case "image/jpg":
		return "image/jpeg"
	case "audio/mp3":
		return "audio/mpeg"
	case "png":
		return "image/png"
	case "jpeg", "jpg":
		return "image/jpeg"
	case "webp":
		return "image/webp"
	case "gif":
		return "image/gif"
	case "mp3", "mpeg":
		return "audio/mpeg"
	case "wav":
		return "audio/wav"
	case "mp4":
		return "video/mp4"
	case "webm":
		return "video/webm"
	}
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "audio":
		return "audio/mpeg"
	case "video":
		return "video/mp4"
	default:
		return "image/png"
	}
}

var (
	manifestMDImageRegex   = regexp.MustCompile(`!\[[^\]]*\]\(([^)\s]+)\)`)
	manifestHTMLVideoRegex = regexp.MustCompile(`(?i)<video[^>]+src=['"]([^'"]+)['"]`)
)

func mediaPathValues(payload map[string]any, path string) []string {
	value := pathValue(payload, path)
	if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
		trimmed := strings.TrimSpace(text)
		if matches := manifestMDImageRegex.FindAllStringSubmatch(trimmed, -1); len(matches) > 0 {
			var res []string
			for _, m := range matches {
				if len(m) > 1 && m[1] != "" {
					res = append(res, m[1])
				}
			}
			if len(res) > 0 {
				return res
			}
		}
		if matches := manifestHTMLVideoRegex.FindAllStringSubmatch(trimmed, -1); len(matches) > 0 {
			var res []string
			for _, m := range matches {
				if len(m) > 1 && m[1] != "" {
					res = append(res, m[1])
				}
			}
			if len(res) > 0 {
				return res
			}
		}
		return []string{trimmed}
	}
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		switch typed := item.(type) {
		case string:
			if strings.TrimSpace(typed) != "" {
				values = append(values, strings.TrimSpace(typed))
			}
		case map[string]any:
			if url := firstString(typed, "url", "file_url", "fileUrl", "video_url", "videoUrl", "image_url", "imageUrl"); url != "" {
				values = append(values, url)
			}
		}
	}
	return values
}

func manifestMediaValues(values []MediaReference) []any {
	result := make([]any, 0, len(values))
	for index, value := range values {
		order := value.Order
		if order == 0 && index > 0 {
			order = index
		}
		resolved := defaultValue(value.URL, value.DataURL)
		result = append(result, map[string]any{
			"id":       value.ID,
			"url":      value.URL,
			"dataUrl":  value.DataURL,
			"value":    resolved,
			"kind":     value.Kind,
			"role":     value.Role,
			"mimeType": value.MIMEType,
			"name":     value.Name,
			"order":    order,
			"weight":   value.Weight,
			"metadata": value.Metadata,
			"source": map[string]any{
				"type":     manifestMediaSourceType(value),
				"value":    resolved,
				"mimeType": value.MIMEType,
			},
			"ephemeral": value.Ephemeral,
		})
	}
	return result
}

func manifestMediaSourceType(value MediaReference) string {
	if value.DataURL != "" {
		return "data"
	}
	if value.URL != "" {
		return "url"
	}
	return "unknown"
}

func applyManifestTransform(value any, transform string, request GenerationRequest) any {
	transform = strings.ToLower(strings.TrimSpace(transform))
	if transform == "bool" || transform == "boolean" {
		switch v := value.(type) {
		case bool:
			return v
		case string:
			s := strings.ToLower(strings.TrimSpace(v))
			return s == "true" || s == "1" || s == "yes"
		case int, int64, float64:
			return v != 0
		default:
			return false
		}
	}
	if transform == "int" || transform == "integer" {
		switch v := value.(type) {
		case int:
			return v
		case int64:
			return int(v)
		case float64:
			return int(v)
		case string:
			if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
				return n
			}
			return 0
		default:
			return 0
		}
	}
	if transform == "omit_zero" {
		switch v := value.(type) {
		case int:
			if v == 0 {
				return nil
			}
		case int64:
			if v == 0 {
				return nil
			}
		case float64:
			if v == 0 {
				return nil
			}
		case string:
			if strings.TrimSpace(v) == "0" || strings.TrimSpace(v) == "" {
				return nil
			}
		}
	}
	cleanModel := manifestModelID(request)
	if strings.HasPrefix(transform, "omit_unless_model_contains:") {
		needle := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(transform, "omit_unless_model_contains:")))
		if needle == "" || !strings.Contains(cleanModel, needle) {
			return nil
		}
	}
	if strings.HasPrefix(transform, "omit_if_model_contains:") {
		needle := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(transform, "omit_if_model_contains:")))
		if needle != "" && strings.Contains(cleanModel, needle) {
			return nil
		}
	}
	if strings.HasPrefix(transform, "omit_unless_model_equals:") {
		target := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(transform, "omit_unless_model_equals:")))
		if target == "" || cleanModel != target {
			return nil
		}
	}
	if strings.HasPrefix(transform, "omit_if_model_equals:") {
		target := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(transform, "omit_if_model_equals:")))
		if target != "" && cleanModel == target {
			return nil
		}
	}
	text, ok := value.(string)
	if transform == "omit_empty" && (!ok || strings.TrimSpace(text) == "") {
		return nil
	}
	if transform == "omit_auto" && (!ok || strings.TrimSpace(text) == "" || strings.EqualFold(strings.TrimSpace(text), "auto") || strings.EqualFold(strings.TrimSpace(text), "default")) {
		return nil
	}
	if !ok {
		return value
	}
	switch transform {
	case "trim":
		return strings.TrimSpace(text)
	case "lower", "lowercase":
		return strings.ToLower(text)
	case "upper", "uppercase":
		return strings.ToUpper(text)
	case "resolution_p":
		if regexp.MustCompile(`^\d+$`).MatchString(strings.TrimSpace(text)) {
			return strings.TrimSpace(text) + "p"
		}
		return text
	case "video-resolution", "video_resolution", "videoresolution":
		// Compatibility for already-installed 1.0.1 manifests. New plugins
		// should declare exact enum values and use generic string transforms.
		return normalizeLegacyManifestVideoResolution(text)
	default:
		return value
	}
}

func normalizeLegacyManifestVideoResolution(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return ""
	}
	for _, char := range normalized {
		if char < '0' || char > '9' {
			return normalized
		}
	}
	return normalized + "p"
}

func pathValue(payload map[string]any, path string) any {
	return manifestPathValue(payload, path)
}

func arrayValue(value any) []any {
	items, _ := value.([]any)
	return items
}

func firstPathValue(payload map[string]any, paths ...string) string {
	for _, path := range paths {
		if strings.Contains(path, "*") {
			if text := strings.Join(manifestTextPathValues(payload, strings.Split(path, ".")), ""); strings.TrimSpace(text) != "" {
				return strings.TrimSpace(text)
			}
			continue
		}
		value := pathValue(payload, path)
		if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text)
		}
	}
	return ""
}

// Responses text may follow reasoning/tool items and span multiple content
// blocks. Wildcards collect text in wire order without guessing array indexes.
func manifestTextPathValues(value any, parts []string) []string {
	if len(parts) == 0 {
		if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
			return []string{text}
		}
		return nil
	}
	if parts[0] == "*" {
		var values []string
		for _, item := range arrayValue(value) {
			values = append(values, manifestTextPathValues(item, parts[1:])...)
		}
		return values
	}
	return manifestTextPathValues(manifestPathValue(value, parts[0]), parts[1:])
}

// manifestError 判断声明的错误路径上是否出现了失败值。successCodes 是协议自己
// 声明的业务成功码（即梦 CV 用 code=10000 表示成功）：只有在该路径值命中成功码时
// 才跳过失败判定，其余厂商的协议不声明这个字段，判定规则保持原样。
func manifestError(payload map[string]any, paths []string, successCodes []any) bool {
	for _, path := range paths {
		value := pathValue(payload, path)
		if manifestValueInSuccessCodes(value, successCodes) {
			continue
		}
		switch typed := value.(type) {
		case nil:
			continue
		case string:
			switch strings.ToLower(strings.TrimSpace(typed)) {
			case "", "0", "ok", "success", "succeeded", "true":
				continue
			default:
				return true
			}
		case float64:
			if typed == 0 {
				continue
			}
			return true
		case float32:
			if typed == 0 {
				continue
			}
			return true
		case int, int8, int16, int32, int64:
			if reflectValueIsZero(typed) {
				continue
			}
			return true
		case uint, uint8, uint16, uint32, uint64:
			if reflectValueIsZero(typed) {
				continue
			}
			return true
		default:
			return true
		}
	}
	return false
}

// manifestValueInSuccessCodes 用文本形式比较成功码，避免上游把 code 写成数字或
// 字符串（10000 与 "10000"）时判定不一致。
func manifestValueInSuccessCodes(value any, successCodes []any) bool {
	if len(successCodes) == 0 {
		return false
	}
	text := manifestCodeText(value)
	if text == "" {
		return false
	}
	for _, code := range successCodes {
		if manifestCodeText(code) == text {
			return true
		}
	}
	return false
}

func manifestCodeText(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(typed), 'f', -1, 32)
	case int, int8, int16, int32, int64:
		return fmt.Sprintf("%d", typed)
	case uint, uint8, uint16, uint32, uint64:
		return fmt.Sprintf("%d", typed)
	default:
		return ""
	}
}

func reflectValueIsZero(value any) bool {
	switch typed := value.(type) {
	case int:
		return typed == 0
	case int8:
		return typed == 0
	case int16:
		return typed == 0
	case int32:
		return typed == 0
	case int64:
		return typed == 0
	case uint:
		return typed == 0
	case uint8:
		return typed == 0
	case uint16:
		return typed == 0
	case uint32:
		return typed == 0
	case uint64:
		return typed == 0
	default:
		return false
	}
}
