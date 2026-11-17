package modelcatalog

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/pricing"
	"infinite-canvas/backend/internal/protocol"
	"infinite-canvas/backend/internal/providerpreset"
)

type LocalChannelModel struct {
	ChannelID                string
	ChannelScope             string
	BaseURL                  string
	Enabled                  bool
	Model                    string
	DisplayName              string
	Capability               string
	Protocol                 string
	CapabilitySource         string
	CapabilityConfig         any
	ImageCapabilitiesVersion *string
	VideoCapabilitiesVersion *string
	MediaCapabilitiesVersion *string
	VideoPricing             json.RawMessage
	Pricing                  json.RawMessage
}

func (item LocalChannelModel) HasVersionedCapability(capability string) bool {
	if strings.TrimSpace(capability) == "audio" {
		return item.MediaCapabilitiesVersion != nil && strings.TrimSpace(*item.MediaCapabilitiesVersion) != ""
	}
	section, ok := item.CapabilityConfig.(map[string]any)
	if !ok {
		return false
	}
	switch strings.TrimSpace(capability) {
	case "image":
		return section["image"] != nil && item.ImageCapabilitiesVersion != nil && strings.TrimSpace(*item.ImageCapabilitiesVersion) != ""
	case "video":
		return section["video"] != nil && item.VideoCapabilitiesVersion != nil && strings.TrimSpace(*item.VideoCapabilitiesVersion) != ""
	default:
		return false
	}
}

func (item LocalChannelModel) HasDeclaredCapability() bool {
	if item.HasVersionedCapability(item.Capability) {
		return true
	}
	section, ok := item.CapabilityConfig.(map[string]any)
	if !ok || section[item.Capability] == nil {
		return false
	}
	return strings.TrimSpace(item.ChannelScope) == "system" ||
		strings.TrimSpace(item.CapabilitySource) == "user"
}

func ParseLocalChannelModels(body []byte) []LocalChannelModel {
	if len(body) == 0 {
		return nil
	}
	var snapshot struct {
		Channels []struct {
			ID            string   `json:"id"`
			Scope         string   `json:"scope"`
			BaseURL       string   `json:"baseUrl"`
			Enabled       *bool    `json:"enabled"`
			Models        []string `json:"models"`
			ModelProfiles []struct {
				Model                    string          `json:"model"`
				DisplayName              string          `json:"displayName"`
				Capability               string          `json:"capability"`
				Protocol                 string          `json:"protocol"`
				CapabilitySource         string          `json:"capabilitySource"`
				CapabilityConfig         json.RawMessage `json:"capabilityConfig"`
				ImageCapabilitiesVersion *string         `json:"imageCapabilitiesVersion"`
				VideoCapabilitiesVersion *string         `json:"videoCapabilitiesVersion"`
				MediaCapabilitiesVersion *string         `json:"mediaCapabilitiesVersion"`
				VideoPricing             json.RawMessage `json:"videoPricing"`
				Pricing                  json.RawMessage `json:"pricing"`
			} `json:"modelProfiles"`
		} `json:"channels"`
	}
	if json.Unmarshal(body, &snapshot) != nil {
		return nil
	}
	var result []LocalChannelModel
	for _, channel := range snapshot.Channels {
		if strings.TrimSpace(channel.ID) == "" {
			continue
		}
		enabled := channel.Enabled == nil || *channel.Enabled
		scope := strings.TrimSpace(channel.Scope)
		profiles := map[string]LocalChannelModel{}
		for _, profile := range channel.ModelProfiles {
			item := LocalChannelModel{
				ChannelID: channel.ID, ChannelScope: scope, BaseURL: channel.BaseURL, Enabled: enabled,
				Model: profile.Model, DisplayName: strings.TrimSpace(profile.DisplayName),
				Capability: profile.Capability, Protocol: profile.Protocol,
				CapabilitySource:         strings.TrimSpace(profile.CapabilitySource),
				VideoPricing:             profile.VideoPricing,
				Pricing:                  profile.Pricing,
				VideoCapabilitiesVersion: profile.VideoCapabilitiesVersion,
				ImageCapabilitiesVersion: profile.ImageCapabilitiesVersion,
				MediaCapabilitiesVersion: profile.MediaCapabilitiesVersion,
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
			item.ChannelID = channel.ID
			item.ChannelScope = scope
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

func FilterLocalChannelModels(items []LocalChannelModel, intent *ModelRequestIntent) []LocalChannelModel {
	result := make([]LocalChannelModel, 0, len(items))
	for _, item := range items {
		if !item.Enabled || item.Model == "" || !GenerationModeSupported(item.Capability) {
			continue
		}
		if intent != nil && (item.Protocol == "" || (normalizeCapability(intent.Capability) != "" && normalizeCapability(item.Capability) != normalizeCapability(intent.Capability))) {
			continue
		}
		if intent != nil {
			cm := localSnapshotChannelModel(item)
			matched, err := ChannelModelMatchesIntent(&cm, intent)
			if err != nil || !matched {
				continue
			}
		}
		result = append(result, item)
	}
	return result
}

func localSnapshotChannelModel(item LocalChannelModel) model.ChannelModel {
	cm := model.ChannelModel{ModelKey: item.Model, Capability: item.Capability, Protocol: model.ChannelInterfaceType(item.Protocol), Enabled: true}
	if item.CapabilityConfig != nil {
		if raw, err := json.Marshal(item.CapabilityConfig); err == nil {
			cm.CapabilityConfigJSON = string(raw)
		}
	} else if defaults := DefaultModelCapabilityConfigForModel(item.Protocol, item.Model); defaults != nil {
		if raw, err := json.Marshal(defaults); err == nil {
			cm.CapabilityConfigJSON = string(raw)
		}
	}
	return cm
}

// PublicPrices returns the validated quotes a public catalog may show: the
// video quote, and the price row only on the managed channel that wrote it.
// Arbitrary profile fields are never forwarded.
func (item LocalChannelModel) PublicPrices() (map[string]any, *pricing.Table) {
	var quote map[string]any
	if item.Capability == "video" {
		quote, _ = NormalizeCatalogVideoPricing(item.VideoPricing)
	}
	var table *pricing.Table
	if item.ChannelID == managedChannelID {
		table, _ = pricing.Normalize(item.Pricing)
	}
	return quote, table
}

// PublicCatalogFromLocalSnapshot projects a desktop provider snapshot into the
// sanitized public catalog without leaking upstream URLs, headers or keys.
func PublicCatalogFromLocalSnapshot(body []byte, workflow ...WorkflowLookup) (*CatalogResponse, error) {
	var workflowLookup WorkflowLookup
	if len(workflow) > 0 {
		workflowLookup = workflow[0]
	}
	var snapshot struct {
		Channels []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"channels"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &snapshot); err != nil {
			return nil, err
		}
	}
	names := map[string]string{}
	for _, channel := range snapshot.Channels {
		names[channel.ID] = strings.TrimSpace(channel.Name)
	}
	channels := []PublicChannelCatalog{}
	indexes := map[string]int{}
	for _, item := range ParseLocalChannelModels(body) {
		if !item.Enabled || strings.TrimSpace(item.Model) == "" {
			continue
		}
		cm := model.ChannelModel{ID: item.Model, ModelKey: item.Model, DisplayName: item.DisplayName, Capability: item.Capability, Protocol: model.ChannelInterfaceType(item.Protocol), Enabled: true}
		if item.Capability == "video" {
			if _, protocol, ok := providerpreset.HostedBeefTVVideoProfile(item.BaseURL, item.Model); ok {
				cm.Protocol = model.ChannelInterfaceType(protocol)
			}
		}
		declared := item.HasDeclaredCapability()
		capabilityConfig := item.CapabilityConfig
		if item.Capability == "video" && strings.TrimSpace(item.CapabilitySource) != "user" && !item.HasVersionedCapability("video") && workflowLookup != nil {
			if wf, ok := workflowLookup(string(cm.Protocol), protocol.CapabilityVideo, item.Model); ok {
				if projected := DefaultModelCapabilityConfigForModel(string(cm.Protocol), item.Model); projected != nil && projected.Video != nil {
					applyProtocolWorkflowVideoCapability(projected.Video, wf)
					capabilityConfig = projected
				}
			}
		}
		if capabilityConfig == nil {
			capabilityConfig = DefaultModelCapabilityConfigForModel(string(cm.Protocol), item.Model)
		}
		if capabilityConfig != nil {
			config, err := json.Marshal(capabilityConfig)
			if err != nil {
				return nil, err
			}
			if item.Capability == "video" {
				parsed, err := DecodeModelCapabilityConfig(string(config))
				if err != nil {
					continue
				}
				mapped, err := ModelCapabilityConfigToMap(ApplyLocalVideoContract(item, parsed))
				if err != nil {
					return nil, err
				}
				config, err = json.Marshal(mapped)
				if err != nil {
					return nil, err
				}
			}
			cm.CapabilityConfigJSON = string(config)
		}
		public, err := SanitizeChannelModel(&cm)
		if err != nil {
			continue
		}
		managedBeefTV := isLocalBeefTVRoute(item)
		public.CapabilityDeclared = &declared
		public.ManagedBeefTV = &managedBeefTV
		public.VideoPricing, public.Pricing = item.PublicPrices()
		index, exists := indexes[item.ChannelID]
		if !exists {
			index = len(channels)
			indexes[item.ChannelID] = index
			name := names[item.ChannelID]
			if name == "" {
				name = item.ChannelID
			}
			channels = append(channels, PublicChannelCatalog{ID: item.ChannelID, Name: name, DisplayName: name, Models: []PublicChannelModel{}})
		}
		channels[index].Models = append(channels[index].Models, public)
	}
	response := NewCatalogResponse(CatalogSourceSystem, nil, channels)
	return &response, nil
}
