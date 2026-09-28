package app

import (
	"encoding/json"
	"strings"

	"qisitv/backend/internal/beefapi"
	"qisitv/backend/internal/model"
)

type localChannelModel struct {
	ChannelID        string
	BaseURL          string
	Enabled          bool
	Model            string
	DisplayName      string
	Capability       string
	Protocol         string
	CapabilityConfig any
}

func (s *Service) localChannelModels() []localChannelModel {
	if s == nil || !s.IsLocalMode() {
		return nil
	}
	body, err := s.ReadLocalModelConfig()
	if err != nil || len(body) == 0 {
		return nil
	}
	var snapshot struct {
		Channels []struct {
			ID            string   `json:"id"`
			BaseURL       string   `json:"baseUrl"`
			Enabled       *bool    `json:"enabled"`
			Models        []string `json:"models"`
			ModelProfiles []struct {
				Model            string          `json:"model"`
				DisplayName      string          `json:"displayName"`
				Capability       string          `json:"capability"`
				Protocol         string          `json:"protocol"`
				CapabilityConfig json.RawMessage `json:"capabilityConfig"`
			} `json:"modelProfiles"`
		} `json:"channels"`
	}
	if json.Unmarshal(body, &snapshot) != nil {
		return nil
	}
	var result []localChannelModel
	for _, channel := range snapshot.Channels {
		if strings.TrimSpace(channel.ID) == "" {
			continue
		}
		enabled := channel.Enabled == nil || *channel.Enabled
		profiles := map[string]localChannelModel{}
		for _, profile := range channel.ModelProfiles {
			item := localChannelModel{
				ChannelID: channel.ID, BaseURL: channel.BaseURL, Enabled: enabled,
				Model: profile.Model, DisplayName: strings.TrimSpace(profile.DisplayName),
				Capability: profile.Capability, Protocol: profile.Protocol,
			}
			if len(profile.CapabilityConfig) > 0 {
				var value any
				if json.Unmarshal(profile.CapabilityConfig, &value) == nil {
					item.CapabilityConfig = value
				}
			}
			profiles[profile.Model] = item
		}
		for _, name := range channel.Models {
			item := profiles[name]
			if s.likeAIOnly && !isLikeAIProtocol(item.Protocol) {
				continue
			}
			item.ChannelID = channel.ID
			item.BaseURL = channel.BaseURL
			item.Enabled = enabled
			item.Model = name
			if item.DisplayName == "" {
				item.DisplayName = name
			}
			result = append(result, item)
		}
	}
	return result
}

func (s *Service) localChannelModel(channelID, modelKey string) (localChannelModel, bool) {
	for _, item := range s.localChannelModels() {
		if item.ChannelID == channelID && item.Model == modelKey {
			return item, true
		}
	}
	return localChannelModel{}, false
}

func (s *Service) localChannelModelListItems(intent *ModelRequestIntent) []map[string]any {
	items := []map[string]any{}
	for _, item := range s.localChannelModels() {
		if !item.Enabled || item.Model == "" || !cloudAgentGenerationModeSupported(normalizeCapability(item.Capability)) {
			continue
		}
		if intent != nil && (item.Protocol == "" || (normalizeCapability(intent.Capability) != "" && normalizeCapability(item.Capability) != normalizeCapability(intent.Capability))) {
			continue
		}
		if intent != nil {
			cm := &model.ChannelModel{ModelKey: item.Model, Capability: item.Capability, Protocol: model.ChannelInterfaceType(item.Protocol), Enabled: true}
			if item.CapabilityConfig != nil {
				if raw, err := json.Marshal(item.CapabilityConfig); err == nil {
					cm.CapabilityConfigJSON = string(raw)
				}
			} else if defaults := DefaultModelCapabilityConfigForModel(item.Protocol, item.Model); defaults != nil {
				if raw, err := json.Marshal(defaults); err == nil {
					cm.CapabilityConfigJSON = string(raw)
				}
			}
			matched, err := s.channelModelMatchesIntent(cm, intent)
			if err != nil || !matched {
				continue
			}
		}
		selection := map[string]any{"channelId": item.ChannelID, "channelModelKey": item.Model}
		if item.ChannelID == beefapi.ChannelID {
			selection["credentialRef"] = managedBeefAPIRef
		}
		entry := map[string]any{"name": item.DisplayName, "capability": item.Capability, "selection": selection}
		if item.CapabilityConfig != nil {
			entry["options"] = item.CapabilityConfig
		}
		items = append(items, entry)
	}
	return items
}

func catalogModelName(raw any) string {
	item, _ := raw.(map[string]any)
	if item == nil {
		return ""
	}
	if name, _ := item["name"].(string); name != "" {
		return name
	}
	return ""
}

func coerceCatalogModels(value any) []map[string]any {
	switch typed := value.(type) {
	case []map[string]any:
		return append([]map[string]any{}, typed...)
	case []any:
		items := make([]map[string]any, 0, len(typed))
		for _, raw := range typed {
			item, _ := raw.(map[string]any)
			if item == nil {
				continue
			}
			items = append(items, item)
		}
		return items
	default:
		return []map[string]any{}
	}
}
