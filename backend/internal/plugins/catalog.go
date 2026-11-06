package plugins

import (
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

// ProviderCatalogItem is the channel/creation settings projection of a
// protocol provider contribution. Registry metadata overlays Create/Poll
// so host-backed dispatch paths stay out of user-facing catalog consumers.
type ProviderCatalogItem struct {
	ID                string                      `json:"id"`
	Version           string                      `json:"version"`
	Name              string                      `json:"name"`
	Vendor            string                      `json:"vendor"`
	Categories        []protocol.Capability       `json:"categories"`
	Scopes            []protocol.Surface          `json:"scopes"`
	Create            string                      `json:"create,omitempty"`
	Poll              string                      `json:"poll,omitempty"`
	ContentType       string                      `json:"contentType,omitempty"`
	BaseURL           string                      `json:"baseUrl,omitempty"`
	AuthType          string                      `json:"authType,omitempty"`
	Enabled           bool                        `json:"enabled"`
	UnavailableReason string                      `json:"unavailableReason,omitempty"`
	Workflows         []protocol.ManifestWorkflow `json:"workflows,omitempty"`
	// Retired marks a protocol this release no longer ships but that stays
	// executable for configuration saved before the removal. Consumers must not
	// offer it for a new selection while keeping saved choices intact.
	//
	// RetiredReason is also filled for a plugin whose upgrade this startup
	// deferred, which stays selectable because the release still ships it.
	Retired       bool   `json:"retired,omitempty"`
	RetiredReason string `json:"retiredReason,omitempty"`
	// Module 表示生成接口由插件 JS 实现：模型服务里把它列成一个服务商，「读取模型」交给插件。
	Module bool `json:"module,omitempty"`
}

// ProviderCatalog projects provider and workflow contributions from this
// runtime's live registry snapshot. Independent runtimes do not share state.
func (s *Service) ProviderCatalog(scope, capability string, includeUnavailable bool) []ProviderCatalogItem {
	wantScope := protocol.Surface(strings.TrimSpace(scope))
	wantCapability := protocol.Capability(strings.TrimSpace(capability))
	items := make([]ProviderCatalogItem, 0)
	registry := s.Registry()
	for _, plugin := range s.List() {
		for _, provider := range plugin.Manifest.Contributes.Providers {
			if !containsPluginSurface(provider.Scopes, wantScope) || (wantCapability != "" && !containsPluginCapability(provider.Capabilities, wantCapability)) {
				continue
			}
			item := ProviderCatalogItem{
				ID: provider.ID, Version: plugin.Manifest.Version, Name: provider.Label, Vendor: plugin.Manifest.Author,
				Categories: provider.Capabilities, Scopes: provider.Scopes, BaseURL: provider.BaseURL,
				AuthType: provider.Auth.Type,
				Enabled:  plugin.Status == StatusEnabled, UnavailableReason: plugin.Error,
				Workflows:     workflowsForProvider(plugin.Manifest.Contributes.Workflows, provider.ID),
				Retired:       plugin.Retention != nil && plugin.Retention.Retired,
				RetiredReason: retentionReason(plugin.Retention),
			}
			item.Create, item.Poll, item.ContentType = operationSummary(provider.Create), operationSummaryPtr(provider.Poll), provider.Create.ContentType
			if registry != nil {
				if adapter, ok := registry.Resolve(provider.ID); ok {
					metadata := adapter.Metadata()
					item.Create, item.Poll, item.ContentType = metadata.Create, metadata.Poll, metadata.ContentType
					_, item.Module = adapter.(protocol.ModuleProvider)
				}
			}
			if includeUnavailable || item.Enabled {
				items = append(items, item)
			}
		}
	}
	return items
}

// ForUser filters the plugin center list. Administrators always see every
// installed plugin; ordinary users only see user-scoped applications when
// system plugins are hidden. The feature flag itself stays a host adapter.
func (s *Service) ForUser(actor *model.User, systemPluginsVisible bool) []View {
	items := s.List()
	if actor != nil && actor.Role == model.UserRoleAdmin {
		return items
	}
	if systemPluginsVisible {
		return items
	}
	filtered := make([]View, 0, len(items))
	for _, item := range items {
		if item.Management.ActivationScope == ScopeUser || item.Source == OriginPackage || item.PackageDir != "" {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func containsPluginSurface(items []protocol.Surface, want protocol.Surface) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func containsPluginCapability(items []protocol.Capability, want protocol.Capability) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func workflowsForProvider(items []protocol.ManifestWorkflow, providerID string) []protocol.ManifestWorkflow {
	result := make([]protocol.ManifestWorkflow, 0)
	for _, item := range items {
		if item.ProviderID == providerID {
			result = append(result, item)
		}
	}
	return result
}

func operationSummary(operation protocol.ManifestOperation) string {
	path := strings.ReplaceAll(operation.Path, "{{model}}", "{model}")
	path = strings.ReplaceAll(path, "{{taskId}}", "{task_id}")
	return strings.ToUpper(operation.Method) + " " + path
}

func operationSummaryPtr(operation *protocol.ManifestOperation) string {
	if operation == nil {
		return ""
	}
	return operationSummary(*operation)
}

func retentionReason(note *RetentionView) string {
	if note == nil {
		return ""
	}
	return strings.Join(note.Reasons, "；")
}
