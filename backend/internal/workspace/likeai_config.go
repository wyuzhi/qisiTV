package workspace

import (
	"strings"

	"qisitv/backend/internal/channelurl"
)

func appendPreferredMediaChannels(channels []any) []any {
	for _, preset := range []struct{ id, name, base string }{{"qisi-api", "qisi API", channelurl.QisiAPIBaseURL}, {"likeai", "LikeAI", channelurl.LikeAIBaseURL}} {
		found := false
		ids := map[string]bool{}
		for _, raw := range channels {
			if channel, ok := raw.(map[string]any); ok {
				id, _ := channel["id"].(string)
				ids[id] = true
				base, _ := channel["baseUrl"].(string)
				found = found || strings.TrimRight(strings.TrimSpace(base), "/") == preset.base && channel["apiFormat"] == "likeai"
			}
		}
		if found {
			continue
		}
		id := preset.id
		for ids[id] {
			id += "-service"
		}
		channels = append(channels, map[string]any{"id": id, "name": preset.name, "baseUrl": preset.base,
			"apiFormat": "likeai", "scope": "user", "models": []any{}, "modelProfiles": []any{},
			"apiKey": "", "secretKey": "", "headers": []any{}, "enabled": true})
	}
	return channels
}
