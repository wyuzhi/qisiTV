package handler

import (
	"strings"

	"qisitv/backend/internal/beefapi"
)

func externalSecretField(k string) bool {
	n := strings.ToLower(strings.NewReplacer("_", "", "-", "").Replace(k))
	return (strings.Contains(n, "apikey") && !strings.HasPrefix(n, "has")) || strings.Contains(n, "secret") || strings.Contains(n, "password") || n == "token" || n == "authorization" || n == "cookie" || n == "accesskey" || n == "privatekey" || n == "headers" || n == "customheaders" || n == "devicecode"
}

// External discovery never returns reusable provider credentials, including
// user-owned custom channels rather than only the managed BeefAPI channel.
func redactExternalConfig(config map[string]any) map[string]any {
	if config == nil {
		return nil
	}
	var redact func(any) any
	redact = func(value any) any {
		switch v := value.(type) {
		case map[string]any:
			out := make(map[string]any, len(v))
			for k, x := range v {
				if externalSecretField(k) {
					out[k] = ""
					continue
				}
				out[k] = redact(x)
			}
			return out
		case []any:
			out := make([]any, len(v))
			for i, x := range v {
				out[i] = redact(x)
			}
			return out
		default:
			return v
		}
	}
	return redact(config).(map[string]any)
}

// 外部工作区回读配置时密钥一律清空，客户端因此分不清「还没填」和「已经保存、
// 只是不返回」。这里按清空前的内容补上两个标记，让前端能依据真实的保存状态
// 决定要不要让用户重填，而不是靠猜。
func markExternalCredentialState(redacted, stored map[string]any) map[string]any {
	channels, ok := redacted["channels"].([]any)
	if !ok {
		return redacted
	}
	storedByID := map[string]map[string]any{}
	storedChannels, _ := stored["channels"].([]any)
	for _, raw := range storedChannels {
		channel, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if id, _ := channel["id"].(string); id != "" {
			storedByID[id] = channel
		}
	}
	for _, raw := range channels {
		channel, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id, _ := channel["id"].(string)
		// 托管渠道的标记由 beefapi.RedactConfig 按托管状态给，这里不能替它下结论。
		if id == beefapi.ChannelID {
			continue
		}
		source, ok := storedByID[id]
		if !ok {
			continue
		}
		if externalSecretValue(source["apiKey"]) {
			channel["hasApiKey"] = true
		}
		if externalSecretValue(source["secretKey"]) {
			channel["hasSecretKey"] = true
		}
	}
	redacted["channels"] = channels
	return redacted
}

// 标记只在回读时有意义：写进存储会让清除密钥后的旧标记继续生效。
func stripExternalCredentialState(config map[string]any) {
	delete(config, "hasApiKey")
	delete(config, "hasSecretKey")
	for _, value := range config {
		switch v := value.(type) {
		case map[string]any:
			stripExternalCredentialState(v)
		case []any:
			for _, item := range v {
				if channel, ok := item.(map[string]any); ok {
					stripExternalCredentialState(channel)
				}
			}
		}
	}
}

func externalSecretValue(value any) bool {
	text, _ := value.(string)
	return strings.TrimSpace(text) != ""
}

func preserveExternalConfigSecrets(incoming, existing map[string]any) {
	stripExternalCredentialState(incoming)
	for key, old := range existing {
		if externalSecretField(key) {
			value, present := incoming[key]
			if !present || value == "" || value == nil {
				incoming[key] = old
			}
			continue
		}
		switch oldValue := old.(type) {
		case map[string]any:
			if next, ok := incoming[key].(map[string]any); ok {
				preserveExternalConfigSecrets(next, oldValue)
			}
		case []any:
			next, _ := incoming[key].([]any)
			for _, item := range next {
				n, ok := item.(map[string]any)
				if !ok {
					continue
				}
				id, _ := n["id"].(string)
				if id == "" {
					continue
				}
				for _, oldItem := range oldValue {
					o, ok := oldItem.(map[string]any)
					if ok && o["id"] == id {
						preserveExternalConfigSecrets(n, o)
						break
					}
				}
			}
		}
	}
}
