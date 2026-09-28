package workspace

import "strings"

const LikeAIBaseURL = "https://task.likeai.pro/task-api"

// NewLikeAIProviderConfig exposes qisiTV's active provider without deleting
// historical channel settings from the local workspace file.
func NewLikeAIProviderConfig(dataDir string) (*ProviderConfig, error) {
	store, err := NewProviderConfig(dataDir)
	if err == nil {
		store.likeAIOnly = true
	}
	return store, err
}

func likeAIOnlyConfig(config map[string]any) map[string]any {
	channel := map[string]any{
		"id": "likeai", "name": "LikeAI", "baseUrl": LikeAIBaseURL,
		"apiFormat": "likeai", "scope": "user", "pinned": true,
		"presetVersion": 1, "models": []any{}, "modelProfiles": []any{},
		"apiKey": "", "secretKey": "", "headers": []any{}, "enabled": true,
	}
	if channels, ok := config["channels"].([]any); ok {
		for _, item := range channels {
			local, ok := item.(map[string]any)
			if !ok || local["id"] != "likeai" {
				continue
			}
			for key, value := range local {
				channel[key] = value
			}
			break
		}
	}
	channel["id"], channel["name"] = "likeai", "LikeAI"
	channel["baseUrl"], channel["apiFormat"] = LikeAIBaseURL, "likeai"
	channel["pinned"] = true
	config["channels"] = []any{channel}
	for _, key := range []string{"imageModel", "videoModel", "textModel", "audioModel"} {
		if value, ok := config[key].(string); ok && !strings.HasPrefix(value, "likeai::") {
			config[key] = ""
		}
	}
	return config
}

func preserveInactiveProviderConfig(incoming, existing map[string]any) map[string]any {
	channels := []any{}
	var active any
	if previous, ok := existing["channels"].([]any); ok {
		for _, value := range previous {
			channel, ok := value.(map[string]any)
			if !ok {
				continue
			}
			if channel["id"] == "likeai" {
				active = value
			} else {
				channels = append(channels, value)
			}
		}
	}
	if next, ok := incoming["channels"].([]any); ok {
		for _, value := range next {
			if channel, ok := value.(map[string]any); ok && channel["id"] == "likeai" {
				active = channel
				break
			}
		}
	}
	if active != nil {
		channels = append(channels, active)
	}
	incoming["channels"] = channels
	return incoming
}
