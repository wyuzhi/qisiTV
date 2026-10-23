package workspace

const LikeAIBaseURL = "https://task.likeai.pro/task-api"
const QisiAPIBaseURL = "https://cheeser.link/api-service/likeai"

// Selecting a preferred service does not filter independent assistant channels.
func NewLikeAIProviderConfig(dataDir string) (*ProviderConfig, error) {
	return NewProviderConfig(dataDir)
}

func appendPreferredMediaChannels(channels []any) []any {
	for _, preset := range []struct{ id, name, base string }{{"qisi-api", "qisi API", QisiAPIBaseURL}, {"likeai", "LikeAI", LikeAIBaseURL}} {
		found := false
		ids := map[string]bool{}
		for _, raw := range channels {
			if channel, ok := raw.(map[string]any); ok {
				id, _ := channel["id"].(string)
				ids[id] = true
				found = found || channel["baseUrl"] == preset.base && channel["apiFormat"] == "likeai"
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
