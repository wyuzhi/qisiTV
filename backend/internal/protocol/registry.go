package protocol

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

type Registry struct {
	mu       sync.RWMutex
	adapters map[string]Adapter
}

func NewRegistry(adapters ...Adapter) (*Registry, error) {
	r := &Registry{adapters: make(map[string]Adapter, len(adapters))}
	for _, adapter := range adapters {
		if err := r.Register(adapter); err != nil {
			return nil, err
		}
	}
	return r, nil
}

func (r *Registry) Register(adapter Adapter) error {
	if adapter == nil {
		return fmt.Errorf("protocol adapter is nil")
	}
	metadata := adapter.Metadata()
	metadata.ID = strings.TrimSpace(metadata.ID)
	metadata.Version = strings.TrimSpace(metadata.Version)
	if metadata.ID == "" || metadata.Version == "" {
		return fmt.Errorf("protocol adapter metadata requires id and version")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.adapters[metadata.ID]; exists {
		return fmt.Errorf("protocol adapter %q is already registered", metadata.ID)
	}
	r.adapters[metadata.ID] = adapter
	return nil
}

// Unregister removes an installed protocol from the live registry. The caller
// owns persistence; the registry only represents the current plugin snapshot.
func (r *Registry) Unregister(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	id = strings.TrimSpace(id)
	if _, ok := r.adapters[id]; !ok {
		return false
	}
	delete(r.adapters, id)
	return true
}

func (r *Registry) RegisterManifest(data []byte) error {
	adapter, err := LoadManifest(data)
	if err != nil {
		return err
	}
	return r.Register(adapter)
}

func (r *Registry) Get(id string) (Adapter, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	adapter, ok := r.adapters[strings.TrimSpace(id)]
	return adapter, ok
}

func (r *Registry) Resolve(id string) (Adapter, bool) {
	if adapter, ok := r.Get(id); ok {
		return adapter, true
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, adapter := range r.adapters {
		for _, candidate := range ResolvableIDs(adapter.Metadata()) {
			if candidate == id {
				return adapter, true
			}
		}
	}
	return nil, false
}

// ResolvableIDs lists every ID Registry.Resolve maps onto an adapter with this
// metadata: its own ID, its legacy aliases and the old package name BeefAPI
// catalogs stored for Gemini. Callers that must agree with Resolve about which
// saved IDs still reach a protocol (plugin retention, for example) use this
// instead of re-deriving the rules.
func ResolvableIDs(metadata Metadata) []string {
	ids := make([]string, 0, len(metadata.LegacyAliases)+2)
	seen := make(map[string]struct{}, cap(ids))
	add := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, exists := seen[id]; exists {
			return
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	add(metadata.ID)
	// Older BeefAPI catalogs stored the package name instead of its provider ID.
	if strings.TrimSpace(metadata.ID) == "gemini-generate-content" {
		add("google-gemini-generate-content")
	}
	for _, alias := range metadata.LegacyAliases {
		add(alias)
	}
	return ids
}

func (r *Registry) List(surface Surface, capability Capability, includeUnavailable bool) []Metadata {
	r.mu.RLock()
	items := make([]Metadata, 0, len(r.adapters))
	for _, adapter := range r.adapters {
		metadata := adapter.Metadata()
		if !includeUnavailable && (!metadata.Enabled || metadata.UnavailableReason != "") {
			continue
		}
		if capability != "" && !containsCapability(metadata.Categories, capability) {
			continue
		}
		if surface != "" && !containsSurface(metadata.Scopes, surface) {
			continue
		}
		items = append(items, metadata)
	}
	r.mu.RUnlock()
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items
}

func (r *Registry) IsCapability(id string, capability Capability) bool {
	adapter, ok := r.Resolve(id)
	if !ok {
		return false
	}
	metadata := adapter.Metadata()
	return metadata.Enabled && metadata.UnavailableReason == "" && containsCapability(metadata.Categories, capability)
}

func containsCapability(values []Capability, value Capability) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func containsSurface(values []Surface, value Surface) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}
