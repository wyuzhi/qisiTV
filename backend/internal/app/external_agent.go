package app

import (
	"encoding/json"
	"net/http"
	"strings"
)

// ExternalAgentModels preserves the legacy read-only catalog. Native clients
// submit and approve work through agentops; the retired cloud-agent admission
// and writeback paths are intentionally not restored.
func (s *Service) ExternalAgentModels() ([]map[string]any, error) {
	if !s.IsLocalMode() {
		return nil, NewAppError(http.StatusNotFound, "外部 Agent 接口仅用于本地工作区")
	}
	items := []map[string]any{}
	for _, item := range s.localChannelModels() {
		if !item.Enabled {
			continue
		}
		kind := normalizeCapability(item.Capability)
		if kind == "" {
			for _, candidate := range []string{"image", "video", "text", "audio"} {
				if strings.HasSuffix(item.Protocol, "-"+candidate) {
					kind = candidate
				}
			}
		}
		if kind == "" {
			continue
		}
		items = append(items, map[string]any{"model": item.Model, "name": item.DisplayName, "type": kind, "channelId": item.ChannelID, "protocol": item.Protocol, "capabilityConfig": item.CapabilityConfig, "defaultOptions": s.externalAgentModelDefaults(item.ChannelID, item.Model)})
	}
	return items, nil
}

func (s *Service) externalAgentModelDefaults(channelID, modelName string) map[string]any {
	body, err := s.ReadLocalModelConfig()
	if err != nil {
		return map[string]any{}
	}
	var config struct {
		Channels []struct {
			ID            string `json:"id"`
			ModelProfiles []struct {
				Model          string         `json:"model"`
				DefaultOptions map[string]any `json:"defaultOptions"`
			} `json:"modelProfiles"`
		} `json:"channels"`
	}
	_ = json.Unmarshal(body, &config)
	for _, channel := range config.Channels {
		if channel.ID == channelID {
			for _, profile := range channel.ModelProfiles {
				if profile.Model == modelName && !externalAgentSensitiveValue(profile.DefaultOptions) {
					return profile.DefaultOptions
				}
			}
		}
	}
	return map[string]any{}
}

func externalAgentSensitiveValue(value any) bool {
	switch item := value.(type) {
	case map[string]any:
		for key, child := range item {
			normalized := strings.ToLower(strings.NewReplacer("-", "", "_", "").Replace(key))
			switch normalized {
			case "apikey", "secretkey", "authorization", "cookie", "token", "accesstoken", "bearertoken", "credentials", "password", "headers", "baseurl", "config", "credentialref", "runninghubwalletapikey", "runninghubuploadapikey":
				return true
			}
			if externalAgentSensitiveValue(child) {
				return true
			}
		}
	case []any:
		for _, child := range item {
			if externalAgentSensitiveValue(child) {
				return true
			}
		}
	}
	return false
}
