package plugins

import (
	"encoding/json"
	"sort"
	"strings"

	"qisitv/backend/internal/canvas/capability"
	"qisitv/backend/internal/protocol"
)

type EnabledPackageView struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Version    string   `json:"version"`
	PackageDir string   `json:"packageDir"`
	SkillDirs  []string `json:"skillDirs,omitempty"`
	Client     string   `json:"client,omitempty"`
}

type MarketPluginItem struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	PackageName   string   `json:"packageName"`
	Version       string   `json:"version"`
	Description   string   `json:"description"`
	Author        string   `json:"author,omitempty"`
	Keywords      []string `json:"keywords,omitempty"`
	Tags          []string `json:"tags,omitempty"`
	Repository    string   `json:"repository,omitempty"`
	Homepage      string   `json:"homepage,omitempty"`
	ReadmeURL     string   `json:"readmeUrl,omitempty"`
	TarballURL    string   `json:"tarballUrl,omitempty"`
	MirrorTarball string   `json:"mirrorTarball,omitempty"`
	SHA256        string   `json:"sha256,omitempty"`
	Installed     bool     `json:"installed"`
	Enabled       bool     `json:"enabled"`
	Recommended   bool     `json:"recommended,omitempty"`
	Category      string   `json:"category,omitempty"`
	// Bundled marks a built-in package shipped inside BeefTV.
	Bundled bool `json:"bundled,omitempty"`
}

func (s *Service) SetSkillSyncHook(hook func(pluginID string, pluginName string, version string, skillDirs []string, enabled bool)) {
	if s == nil || s.runtime == nil {
		return
	}
	s.runtime.SetSkillSyncHook(hook)
}

func (c *Runtime) SetSkillSyncHook(hook func(pluginID string, pluginName string, version string, skillDirs []string, enabled bool)) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.skillSyncHook = hook
	current := make(map[string]Record, len(c.plugins))
	for k, v := range c.plugins {
		current[k] = v
	}
	c.mu.Unlock()
	if hook != nil {
		dispatchPluginSkillSync(hook, nil, current)
	}
}

func dispatchPluginSkillSync(
	hook func(pluginID string, pluginName string, version string, skillDirs []string, enabled bool),
	previous map[string]Record,
	current map[string]Record,
) {
	seen := make(map[string]struct{}, len(previous)+len(current))
	ids := make([]string, 0, len(previous)+len(current))
	for id := range previous {
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	for id := range current {
		if _, exists := seen[id]; !exists {
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		rec, exists := current[id]
		if !exists {
			prev := previous[id]
			if len(prev.SkillDirs) > 0 || prev.Source == OriginPackage || prev.PackageDir != "" {
				hook(id, prev.Metadata.Name, prev.Metadata.Version, nil, false)
			}
			continue
		}
		if len(rec.SkillDirs) == 0 && rec.Source != OriginPackage && rec.PackageDir == "" {
			continue
		}
		enabled := rec.Status == StatusEnabled && len(rec.SkillDirs) > 0
		hook(id, rec.Metadata.Name, rec.Metadata.Version, rec.SkillDirs, enabled)
	}
}

func syncPluginCanvasCapabilities(plugins map[string]Record) {
	capRegistry := capability.BuiltinRegistry()
	if capRegistry == nil {
		return
	}
	capRegistry.ResetPluginDescriptors()
	ids := make([]string, 0, len(plugins))
	for id := range plugins {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		record := plugins[id]
		if record.Status != StatusEnabled {
			continue
		}
		var manifest protocol.Manifest
		if err := json.Unmarshal(record.Raw, &manifest); err != nil {
			continue
		}
		if len(manifest.Contributes.CanvasNodes) == 0 {
			continue
		}
		descriptors := make([]capability.Descriptor, 0, len(manifest.Contributes.CanvasNodes))
		for _, node := range manifest.Contributes.CanvasNodes {
			w, h := node.NodeDimensions()
			if w <= 0 {
				w = 360
			}
			if h <= 0 {
				h = 260
			}
			patchFields := map[string]capability.PatchField{
				"title": {
					Path: "title", Kind: "string", Label: "节点名称", Order: 10, Description: "节点标题", MaxRunes: 240,
				},
				"content": {
					Path: "metadata.content", Kind: "string", Label: "内容", Order: 20, Description: "节点内容", MaxRunes: 16000,
				},
			}
			for idx, field := range node.Fields {
				fieldName := strings.TrimSpace(field.Name)
				if fieldName == "" || fieldName == "title" || fieldName == "content" {
					continue
				}
				kind := "string"
				switch strings.ToLower(strings.TrimSpace(field.Type)) {
				case "number", "int", "integer", "float":
					kind = "number"
				case "boolean", "bool":
					kind = "boolean"
				}
				label := strings.TrimSpace(field.Label)
				if label == "" {
					label = fieldName
				}
				patchFields[fieldName] = capability.PatchField{
					Path:        "metadata.pluginData." + fieldName,
					Kind:        kind,
					Label:       label,
					Order:       30 + idx,
					Description: strings.TrimSpace(field.Description),
				}
			}
			purpose := strings.TrimSpace(manifest.Metadata.Description)
			if purpose == "" {
				purpose = node.NodeLabel()
			}
			version := strings.TrimSpace(manifest.Metadata.Version)
			if version == "" {
				version = "1"
			}
			descriptors = append(descriptors, capability.Descriptor{
				Type:          node.NodeType(),
				Version:       version,
				Label:         node.NodeLabel(),
				Purpose:       purpose,
				DefaultWidth:  float64(w),
				DefaultHeight: float64(h),
				InputKind:     "text",
				Connection: capability.ConnectionPolicy{
					CanSource:          true,
					CanTarget:          true,
					AcceptedInputKinds: []string{"text", "image", "video", "audio"},
				},
				CanUpdate:     true,
				SummaryFields: []string{"content", "pluginData"},
				DetailFields:  []string{"content", "pluginData"},
				PatchFields:   patchFields,
			})
		}
		_ = capRegistry.SetPluginDescriptors(id, descriptors)
	}
}

func (s *Service) EnabledPackages() []EnabledPackageView {
	if s == nil || s.runtime == nil {
		return []EnabledPackageView{}
	}
	return s.runtime.EnabledPackages()
}

func (c *Runtime) EnabledPackages() []EnabledPackageView {
	if c == nil {
		return []EnabledPackageView{}
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	items := make([]EnabledPackageView, 0)
	for _, record := range c.plugins {
		if record.Status != StatusEnabled || strings.TrimSpace(record.PackageDir) == "" {
			continue
		}
		var manifest protocol.Manifest
		_ = json.Unmarshal(record.Raw, &manifest)
		items = append(items, EnabledPackageView{
			ID:         record.Metadata.ID,
			Name:       record.Metadata.Name,
			Version:    record.Metadata.Version,
			PackageDir: record.PackageDir,
			SkillDirs:  cloneStringSlice(record.SkillDirs),
			Client:     manifest.Client,
		})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items
}
