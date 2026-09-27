package workspace

import (
	"encoding/json"
	"fmt"

	"qisitv/backend/internal/providerpreset"
)

const providerStateSchemaVersion = 1

type ConfigHealth string

const (
	ConfigHealthReady     ConfigHealth = "ready"
	ConfigHealthDefault   ConfigHealth = "default"
	ConfigHealthMigrated  ConfigHealth = "migrated"
	ConfigHealthRecovered ConfigHealth = "recovered"
)

type ProviderStateDocument struct {
	SchemaVersion  int            `json:"schemaVersion"`
	Revision       int64          `json:"revision"`
	PresetVersions map[string]int `json:"presetVersions"`
	Config         map[string]any `json:"config"`
}

type EffectiveModelConfig struct {
	SchemaVersion  int            `json:"schemaVersion"`
	Revision       int64          `json:"revision"`
	PresetVersions map[string]int `json:"presetVersions"`
	Config         map[string]any `json:"config"`
}

func newProviderState(config map[string]any, revision int64) ProviderStateDocument {
	return ProviderStateDocument{
		SchemaVersion:  providerStateSchemaVersion,
		Revision:       revision,
		PresetVersions: builtinPresetVersions(),
		Config:         config,
	}
}

func effectiveProviderState(document ProviderStateDocument) (EffectiveModelConfig, error) {
	config, err := mergeBuiltinProviderPresets(document.Config)
	if err != nil {
		return EffectiveModelConfig{}, err
	}
	return EffectiveModelConfig{
		SchemaVersion:  providerStateSchemaVersion,
		Revision:       document.Revision,
		PresetVersions: builtinPresetVersions(),
		Config:         config,
	}, nil
}

func mergeBuiltinProviderPresets(config map[string]any) (map[string]any, error) {
	result, err := cloneMap(config)
	if err != nil {
		return nil, err
	}
	channels := map[string]map[string]any{}
	order := make([]string, 0)
	if rawChannels, ok := result["channels"].([]any); ok {
		for _, raw := range rawChannels {
			channel, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			id, _ := channel["id"].(string)
			if id == "" {
				continue
			}
			channels[id] = channel
			order = append(order, id)
		}
	}

	for _, preset := range providerpreset.BuiltinChannels() {
		local := channels[preset.ID]
		merged, err := presetChannelMap(preset, local)
		if err != nil {
			return nil, err
		}
		channels[preset.ID] = merged
		if !containsString(order, preset.ID) {
			order = append([]string{preset.ID}, order...)
		}
	}

	mergedChannels := make([]any, 0, len(order))
	for _, id := range order {
		if channel := channels[id]; channel != nil {
			mergedChannels = append(mergedChannels, channel)
		}
	}
	result["channels"] = mergedChannels
	return result, nil
}

func presetChannelMap(preset providerpreset.ChannelPreset, local map[string]any) (map[string]any, error) {
	models := make([]string, 0, len(preset.Models))
	profiles := make([]any, 0, len(preset.Models))
	presetModels := make(map[string]struct{}, len(preset.Models))
	for _, profile := range preset.Models {
		models = append(models, profile.Model)
		presetModels[profile.Model] = struct{}{}
		var capabilityConfig any
		if err := json.Unmarshal(profile.CapabilityConfig, &capabilityConfig); err != nil {
			return nil, fmt.Errorf("decode %s capability config: %w", profile.Model, err)
		}
		profiles = append(profiles, map[string]any{
			"model": profile.Model, "capability": profile.Capability,
			"protocol": profile.Protocol, "capabilityConfig": capabilityConfig,
		})
	}
	if localModels, ok := local["models"].([]any); ok {
		for _, value := range localModels {
			model, ok := value.(string)
			if !ok || model == "" {
				continue
			}
			if _, managed := presetModels[model]; !managed && !containsString(models, model) {
				models = append(models, model)
			}
		}
	}
	if localProfiles, ok := local["modelProfiles"].([]any); ok {
		for _, value := range localProfiles {
			profile, ok := value.(map[string]any)
			if !ok {
				continue
			}
			model, _ := profile["model"].(string)
			if _, managed := presetModels[model]; model != "" && !managed {
				profiles = append(profiles, profile)
			}
		}
	}
	result := map[string]any{
		"id": preset.ID, "name": preset.DisplayName, "baseUrl": preset.BaseURL,
		"apiFormat": preset.CatalogProtocol, "scope": "user", "pinned": preset.Pinned,
		"presetVersion": preset.PresetVersion, "models": models, "modelProfiles": profiles,
		"apiKey": "", "secretKey": "", "headers": []any{}, "enabled": true,
	}
	for _, key := range []string{"apiKey", "secretKey", "headers", "enabled"} {
		if value, ok := local[key]; ok {
			result[key] = value
		}
	}
	return result, nil
}

func builtinPresetVersions() map[string]int {
	versions := make(map[string]int)
	for _, preset := range providerpreset.BuiltinChannels() {
		versions[preset.ID] = preset.PresetVersion
	}
	return versions
}

func cloneMap(value map[string]any) (map[string]any, error) {
	if value == nil {
		return map[string]any{}, nil
	}
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var clone map[string]any
	if err := json.Unmarshal(body, &clone); err != nil {
		return nil, err
	}
	return clone, nil
}

func containsString(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}
