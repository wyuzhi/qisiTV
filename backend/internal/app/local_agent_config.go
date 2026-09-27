package app

import (
	"encoding/json"
	"strings"
)

// localAgentProviderConfig resolves Agent models from the desktop-owned
// snapshot. It deliberately never accepts provider credentials from an Agent
// HTTP request.
func (s *Service) localAgentProviderConfig(modelName string, channelIDs ...string) (map[string]any, bool) {
	if !s.IsLocalMode() || strings.TrimSpace(modelName) == "" {
		return nil, false
	}
	body, err := s.ReadLocalModelConfig()
	if err != nil || len(body) == 0 {
		return nil, false
	}
	var snapshot struct {
		Channels []struct {
			ID            string   `json:"id"`
			BaseURL       string   `json:"baseUrl"`
			APIKey        string   `json:"apiKey"`
			SecretKey     string   `json:"secretKey"`
			APIFormat     string   `json:"apiFormat"`
			InterfaceType string   `json:"interfaceType"`
			Headers       any      `json:"headers"`
			Enabled       *bool    `json:"enabled"`
			Models        []string `json:"models"`
			ModelProfiles []struct {
				Model            string          `json:"model"`
				Protocol         string          `json:"protocol"`
				CapabilityConfig json.RawMessage `json:"capabilityConfig"`
			} `json:"modelProfiles"`
		} `json:"channels"`
	}
	if json.Unmarshal(body, &snapshot) != nil {
		return nil, false
	}
	for _, channel := range snapshot.Channels {
		if (channel.Enabled != nil && !*channel.Enabled) || (len(channelIDs) > 0 && channelIDs[0] != "" && channel.ID != channelIDs[0]) {
			continue
		}
		found := false
		for _, item := range channel.Models {
			if item == modelName {
				found = true
				break
			}
		}
		if !found {
			continue
		}
		config := map[string]any{"model": modelName, "baseUrl": channel.BaseURL, "apiKey": channel.APIKey, "secretKey": channel.SecretKey, "apiFormat": channel.APIFormat, "interfaceType": channel.InterfaceType, "headers": channel.Headers}
		for _, profile := range channel.ModelProfiles {
			if profile.Model != modelName {
				continue
			}
			if profile.Protocol != "" {
				config["interfaceType"] = profile.Protocol
			}
			if len(profile.CapabilityConfig) != 0 {
				var value any
				if json.Unmarshal(profile.CapabilityConfig, &value) == nil {
					config["capabilityConfig"] = value
				}
			}
			break
		}
		return config, strings.TrimSpace(channel.BaseURL) != "" && strings.TrimSpace(channel.APIKey) != ""
	}
	return nil, false
}
