package plugins

import "strings"

var officialApplicationPolicies = map[string]ManagementView{
	WorkflowRunningHub: {
		Origin: OriginOfficial, Kind: KindApplication,
		ActivationScope: ScopeUser, ConfigurationScope: ConfigurationUser,
	},
	EagleAssetConnector: {
		Origin: OriginOfficial, Kind: KindApplication,
		ActivationScope: ScopeUser, ConfigurationScope: ConfigurationUser,
	},
	PromptOptimizer: {
		Origin: OriginOfficial, Kind: KindApplication,
		ActivationScope: ScopeUser, ConfigurationScope: ConfigurationNone,
	},
	PortraitClearance: {
		Origin: OriginOfficial, Kind: KindApplication,
		ActivationScope: ScopeUser, ConfigurationScope: ConfigurationNone,
	},
	AIArtCritique: {
		Origin: OriginOfficial, Kind: KindApplication,
		ActivationScope: ScopeUser, ConfigurationScope: ConfigurationNone,
	},
	MediaConversion: {
		Origin: OriginOfficial, Kind: KindApplication,
		ActivationScope: ScopeUser, ConfigurationScope: ConfigurationNone,
	},
	EditorShell: {
		Origin: OriginOfficial, Kind: KindApplication,
		ActivationScope: ScopeUser, ConfigurationScope: ConfigurationNone,
	},
}

func Management(pluginID string, source string) ManagementView {
	trimmedSource := strings.TrimSpace(source)
	if trimmedSource == OriginUploaded {
		return ManagementView{
			Origin: OriginUploaded, Kind: KindProtocol,
			ActivationScope: ScopeSystem, ConfigurationScope: ConfigurationSystem,
		}
	}
	if trimmedSource == OriginPackage {
		return ManagementView{
			Origin: OriginPackage, Kind: KindApplication,
			ActivationScope: ScopeSystem, ConfigurationScope: ConfigurationSystem,
		}
	}
	if policy, ok := officialApplicationPolicies[strings.TrimSpace(pluginID)]; ok {
		return policy
	}
	return ManagementView{
		Origin: OriginOfficial, Kind: KindProtocol,
		ActivationScope: ScopeSystem, ConfigurationScope: ConfigurationSystem,
	}
}

func ManagementFromView(plugin View) ManagementView {
	if strings.TrimSpace(plugin.Source) == OriginPackage {
		kind := KindApplication
		if len(plugin.Manifest.Contributes.Providers) > 0 {
			kind = KindProtocol
		}
		return ManagementView{
			Origin: OriginPackage, Kind: kind,
			ActivationScope: ScopeSystem, ConfigurationScope: ConfigurationSystem,
		}
	}
	if strings.TrimSpace(plugin.PackageDir) != "" && len(plugin.Manifest.Contributes.Providers) == 0 {
		return ManagementView{
			Origin: OriginOfficial, Kind: KindApplication,
			ActivationScope: ScopeSystem, ConfigurationScope: ConfigurationSystem,
		}
	}
	return Management(plugin.Manifest.ID, plugin.Source)
}

func IsReservedApplication(pluginID string) bool {
	_, reserved := officialApplicationPolicies[strings.TrimSpace(pluginID)]
	return reserved
}

func IsKnownApplication(pluginID string) bool {
	return IsReservedApplication(pluginID)
}

func IsBuiltInSource(source string) bool {
	switch strings.TrimSpace(source) {
	case "bundled", OriginOfficial, OriginSystem:
		return true
	default:
		return false
	}
}

func KnownIDs(items []View) []string {
	seen := make(map[string]struct{}, len(items)+len(officialApplicationPolicies))
	ids := make([]string, 0, len(items)+len(officialApplicationPolicies))
	for id := range officialApplicationPolicies {
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	for _, item := range items {
		if _, exists := seen[item.Manifest.ID]; exists {
			continue
		}
		seen[item.Manifest.ID] = struct{}{}
		ids = append(ids, item.Manifest.ID)
	}
	return ids
}

func ByID(items []View, pluginID string) (View, bool) {
	for _, item := range items {
		if item.Manifest.ID == pluginID {
			return item, true
		}
	}
	return View{}, false
}
