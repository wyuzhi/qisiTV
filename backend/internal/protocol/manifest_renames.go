package protocol

import (
	"fmt"
	"net/url"
	"strings"
)

// Interface renames and merges. A provider lists the IDs it used to have
// (legacyAliases) and the services that speak it unchanged (presets), so saved
// configuration keeps working and vendors stay data instead of copies.

// providerLegacyAliases lists the retired IDs that resolve to this provider.
// Released enterprise profiles used the openai-videos package name as the ID.
func providerLegacyAliases(pluginID string, provider ManifestProvider) []string {
	var aliases []string
	if pluginID == "openai-videos" && provider.ID == "newapi" {
		aliases = append(aliases, "openai-video", "openai-videos")
	}
	return append(aliases, provider.LegacyAliases...)
}

func validateProviderRenames(provider ManifestProvider, providerIDs map[string]struct{}) error {
	if err := validateManifestPresets(provider); err != nil {
		return err
	}
	for _, alias := range provider.LegacyAliases {
		if !validManifestIdentifier(alias) {
			return fmt.Errorf("provider %q legacyAliases contains an invalid id %q", provider.ID, alias)
		}
		if _, exists := providerIDs[alias]; exists {
			return fmt.Errorf("provider %q legacyAliases repeats id %q", provider.ID, alias)
		}
		providerIDs[alias] = struct{}{}
	}
	return nil
}

func validateManifestPresets(provider ManifestProvider) error {
	seen := make(map[string]struct{}, len(provider.Presets))
	for index, preset := range provider.Presets {
		if !validManifestIdentifier(preset.ID) || strings.TrimSpace(preset.Label) == "" {
			return fmt.Errorf("provider %q presets[%d] requires a valid id and label", provider.ID, index)
		}
		if _, exists := seen[preset.ID]; exists {
			return fmt.Errorf("provider %q presets repeats id %q", provider.ID, preset.ID)
		}
		seen[preset.ID] = struct{}{}
		address, err := url.Parse(strings.TrimSpace(preset.BaseURL))
		if err != nil || (address.Scheme != "https" && address.Scheme != "http") || address.Host == "" || address.User != nil || address.RawQuery != "" || address.Fragment != "" {
			return fmt.Errorf("provider %q presets[%d].baseUrl must be an http(s) address without credentials or query", provider.ID, index)
		}
	}
	return nil
}

// WithRequestedAliasOptions lets options saved under the retired ID this
// request was made with reach the provider it now resolves to. Only that one
// alias is read, so options left under other retired IDs never leak in, and
// keys already under the provider's own namespace win.
func WithRequestedAliasOptions(request GenerationRequest, requested string, metadata Metadata) GenerationRequest {
	requested, id := strings.TrimSpace(requested), strings.TrimSpace(metadata.ID)
	if requested == "" || id == "" || requested == id || len(request.ProviderOptions[requested]) == 0 {
		return request
	}
	known := false
	for _, alias := range metadata.LegacyAliases {
		known = known || strings.TrimSpace(alias) == requested
	}
	if !known {
		return request
	}
	merged := make(map[string]any, len(request.ProviderOptions[requested])+len(request.ProviderOptions[id]))
	for key, value := range request.ProviderOptions[requested] {
		merged[key] = value
	}
	for key, value := range request.ProviderOptions[id] {
		merged[key] = value
	}
	options := make(map[string]map[string]any, len(request.ProviderOptions)+1)
	for namespace, values := range request.ProviderOptions {
		options[namespace] = values
	}
	options[id] = merged
	request.ProviderOptions = options
	return request
}
