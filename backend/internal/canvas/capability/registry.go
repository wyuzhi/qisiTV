package capability

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
)

const SetVersion = "canvas-capabilities/v5"

type Registry struct {
	mu          sync.RWMutex
	descriptors map[string]Descriptor
	pluginNodes map[string][]string
}

func NewRegistry(descriptors []Descriptor) (*Registry, error) {
	items := make(map[string]Descriptor, len(descriptors))
	generationModes := make(map[string]string, len(descriptors))
	for _, descriptor := range descriptors {
		normalized, err := normalizeAndValidateDescriptor(descriptor, false)
		if err != nil {
			return nil, err
		}
		if normalized.GenerationMode != "" {
			if existing, exists := generationModes[normalized.GenerationMode]; exists {
				return nil, fmt.Errorf("generation mode %q is registered by both %q and %q", normalized.GenerationMode, existing, normalized.Type)
			}
			generationModes[normalized.GenerationMode] = normalized.Type
		}
		if _, exists := items[normalized.Type]; exists {
			return nil, fmt.Errorf("duplicate canvas capability %q", normalized.Type)
		}
		items[normalized.Type] = cloneDescriptor(normalized)
	}
	return &Registry{
		descriptors: items,
		pluginNodes: make(map[string][]string),
	}, nil
}

func normalizeAndValidateDescriptor(descriptor Descriptor, isPlugin bool) (Descriptor, error) {
	descriptor.Type = normalizeType(descriptor.Type)
	descriptor.Version = strings.TrimSpace(descriptor.Version)
	descriptor.Label = strings.TrimSpace(descriptor.Label)
	descriptor.Purpose = strings.TrimSpace(descriptor.Purpose)
	descriptor.GoodFor = normalizeFields(descriptor.GoodFor)
	descriptor.NotIdealFor = normalizeFields(descriptor.NotIdealFor)
	descriptor.Tradeoffs = normalizeFields(descriptor.Tradeoffs)
	descriptor.Actions = normalizeFields(descriptor.Actions)
	if isPlugin {
		if descriptor.Version == "" {
			descriptor.Version = "1"
		}
		if descriptor.Label == "" {
			descriptor.Label = descriptor.Type
		}
		if descriptor.DefaultWidth <= 0 {
			descriptor.DefaultWidth = 360
		}
		if descriptor.DefaultHeight <= 0 {
			descriptor.DefaultHeight = 260
		}
		if len(descriptor.PatchFields) == 0 && !descriptor.CanUpdate {
			descriptor.PatchFields = editableNodeFields("metadata.content", "内容", "插件节点内容")
			descriptor.CanUpdate = true
		} else if len(descriptor.PatchFields) > 0 {
			descriptor.CanUpdate = true
		}
		if len(descriptor.SummaryFields) == 0 {
			descriptor.SummaryFields = []string{"content", "pluginData"}
		}
		if len(descriptor.DetailFields) == 0 {
			descriptor.DetailFields = []string{"content", "pluginData"}
		}
		if descriptor.Connection.CanTarget && len(descriptor.Connection.AcceptedInputKinds) == 0 {
			descriptor.Connection.AcceptedInputKinds = []string{"text", "image", "video", "audio"}
		}
	}
	if descriptor.Type == "" || descriptor.Version == "" || descriptor.Label == "" || descriptor.DefaultWidth <= 0 || descriptor.DefaultHeight <= 0 {
		return Descriptor{}, fmt.Errorf("invalid canvas capability descriptor %q", descriptor.Type)
	}
	inputKind, err := normalizeInputKind(descriptor.InputKind)
	if err != nil {
		return Descriptor{}, fmt.Errorf("capability %q: %w", descriptor.Type, err)
	}
	descriptor.InputKind = inputKind
	generationMode, err := normalizeGenerationMode(descriptor.GenerationMode)
	if err != nil {
		return Descriptor{}, fmt.Errorf("capability %q: %w", descriptor.Type, err)
	}
	descriptor.GenerationMode = generationMode
	projectionKind, err := normalizeProjectionKind(descriptor.ProjectionKind)
	if err != nil {
		return Descriptor{}, fmt.Errorf("capability %q: %w", descriptor.Type, err)
	}
	descriptor.ProjectionKind = projectionKind
	descriptor.ProjectionField = strings.TrimSpace(descriptor.ProjectionField)
	if (descriptor.ProjectionKind == "") != (descriptor.ProjectionField == "") {
		return Descriptor{}, fmt.Errorf("capability %q must declare projection kind and field together", descriptor.Type)
	}
	if descriptor.ProjectionField != "" {
		if err := validatePatchPath(descriptor.ProjectionField); err != nil {
			return Descriptor{}, fmt.Errorf("capability %q has invalid projection field: %w", descriptor.Type, err)
		}
	}
	if descriptor.Connection.MaxInputCount < 0 {
		return Descriptor{}, fmt.Errorf("capability %q has invalid max input count", descriptor.Type)
	}
	accepted, err := normalizeConnectionKinds(descriptor.Connection.AcceptedInputKinds)
	if err != nil {
		return Descriptor{}, fmt.Errorf("capability %q: %w", descriptor.Type, err)
	}
	rejected, err := normalizeConnectionKinds(descriptor.Connection.RejectedInputKinds)
	if err != nil {
		return Descriptor{}, fmt.Errorf("capability %q: %w", descriptor.Type, err)
	}
	rejectedSet := make(map[string]struct{}, len(rejected))
	for _, kind := range rejected {
		rejectedSet[kind] = struct{}{}
	}
	for _, kind := range accepted {
		if _, conflict := rejectedSet[kind]; conflict {
			return Descriptor{}, fmt.Errorf("capability %q accepts and rejects input kind %q", descriptor.Type, kind)
		}
	}
	if descriptor.Connection.CanSource && descriptor.InputKind == "" {
		return Descriptor{}, fmt.Errorf("capability %q can source without an input kind", descriptor.Type)
	}
	descriptor.Connection.AcceptedInputKinds = accepted
	descriptor.Connection.RejectedInputKinds = rejected
	descriptor.PatchFields, err = normalizePatchFields(descriptor.PatchFields)
	if err != nil {
		return Descriptor{}, fmt.Errorf("capability %q: %w", descriptor.Type, err)
	}
	if descriptor.CanUpdate != (len(descriptor.PatchFields) > 0) {
		return Descriptor{}, fmt.Errorf("capability %q must declare both canUpdate and patch fields, or neither", descriptor.Type)
	}
	descriptor.SummaryFields = normalizeFields(descriptor.SummaryFields)
	descriptor.DetailFields = normalizeFields(descriptor.DetailFields)
	return descriptor, nil
}

// SetPluginDescriptors replaces all canvas node descriptors contributed by pluginID.
func (r *Registry) SetPluginDescriptors(pluginID string, descriptors []Descriptor) error {
	if r == nil {
		return fmt.Errorf("canvas capability registry is nil")
	}
	pluginID = strings.TrimSpace(pluginID)
	if pluginID == "" {
		return fmt.Errorf("plugin id is required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pluginNodes == nil {
		r.pluginNodes = make(map[string][]string)
	}
	r.removePluginDescriptorsLocked(pluginID)
	if len(descriptors) == 0 {
		return nil
	}
	normalized := make([]Descriptor, 0, len(descriptors))
	seenInBatch := make(map[string]struct{}, len(descriptors))
	for _, descriptor := range descriptors {
		item, err := normalizeAndValidateDescriptor(descriptor, true)
		if err != nil {
			return err
		}
		if _, dup := seenInBatch[item.Type]; dup {
			return fmt.Errorf("duplicate canvas capability %q", item.Type)
		}
		if _, exists := r.descriptors[item.Type]; exists {
			return fmt.Errorf("duplicate canvas capability %q", item.Type)
		}
		seenInBatch[item.Type] = struct{}{}
		normalized = append(normalized, cloneDescriptor(item))
	}
	types := make([]string, 0, len(normalized))
	for _, item := range normalized {
		r.descriptors[item.Type] = item
		types = append(types, item.Type)
	}
	r.pluginNodes[pluginID] = types
	return nil
}

// RemovePluginDescriptors unregisters all canvas node descriptors contributed by pluginID.
func (r *Registry) RemovePluginDescriptors(pluginID string) {
	if r == nil {
		return
	}
	pluginID = strings.TrimSpace(pluginID)
	if pluginID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.removePluginDescriptorsLocked(pluginID)
}

// ResetPluginDescriptors removes all dynamically registered plugin canvas node descriptors.
func (r *Registry) ResetPluginDescriptors() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for pluginID := range r.pluginNodes {
		r.removePluginDescriptorsLocked(pluginID)
	}
}

func (r *Registry) removePluginDescriptorsLocked(pluginID string) {
	types, exists := r.pluginNodes[pluginID]
	if !exists {
		return
	}
	for _, nodeType := range types {
		delete(r.descriptors, nodeType)
	}
	delete(r.pluginNodes, pluginID)
}

func (r *Registry) Resolve(nodeType string) (Descriptor, bool) {
	if r == nil {
		return Descriptor{}, false
	}
	r.mu.RLock()
	d, ok := r.descriptors[normalizeType(nodeType)]
	r.mu.RUnlock()
	if !ok {
		return Descriptor{}, false
	}
	d = cloneDescriptor(d)
	return d, ok
}

// ValidateReferenceConnection 是参考连线的唯一判定入口：
// 来源必须声明可作输入（CanSource 且 InputKind 非空），目标必须声明可接收（CanTarget），
// 目标的接受/拒绝类型表还必须放行来源的 InputKind。
//
// 调用方（统一操作层、旧内置 Agent 的工具层）都走这里，避免各自复制方向判断——
// 曾经拿来源描述符去校验目标类型，结果 text→image 被错拒、image→text 反而放行。
func (r *Registry) ValidateReferenceConnection(fromType, toType string) error {
	from, ok := r.Resolve(fromType)
	if !ok {
		return fmt.Errorf("未知的节点类型 %s", strings.TrimSpace(fromType))
	}
	to, ok := r.Resolve(toType)
	if !ok {
		return fmt.Errorf("未知的节点类型 %s", strings.TrimSpace(toType))
	}
	return ValidateReferenceConnectionBetween(from, to)
}

// ValidateReferenceConnectionBetween 用两个已知描述符判定连线，供自带类型表的调用方复用同一套规则。
func ValidateReferenceConnectionBetween(from, to Descriptor) error {
	if from.InputKind == "" || !from.Connection.CanSource {
		return fmt.Errorf("来源节点类型 %s 不能作为生成输入；引用连线不能用于普通节点关联", from.Type)
	}
	if !to.Connection.CanTarget {
		return fmt.Errorf("目标节点类型 %s 不能接收生成输入；无需为文档归档建立引用连线", to.Type)
	}
	return to.ValidateConnection(from.InputKind)
}

// MaxReferenceInputCount 返回目标类型声明的输入上限；0 表示不限制。
func (r *Registry) MaxReferenceInputCount(nodeType string) int {
	to, ok := r.Resolve(nodeType)
	if !ok {
		return 0
	}
	return to.Connection.MaxInputCount
}

// LabelFor 返回类型的用户可见名称，用于错误文案；未知类型退回原始类型名。
func (r *Registry) LabelFor(nodeType string) string {
	descriptor, ok := r.Resolve(nodeType)
	if !ok || strings.TrimSpace(descriptor.Label) == "" {
		return strings.TrimSpace(nodeType)
	}
	return descriptor.Label
}
func (r *Registry) List() []Descriptor {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	out := make([]Descriptor, 0, len(r.descriptors))
	for _, d := range r.descriptors {
		out = append(out, cloneDescriptor(d))
	}
	r.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Type < out[j].Type })
	return out
}
func (r *Registry) Types() []string {
	items := r.List()
	out := make([]string, 0, len(items))
	for _, d := range items {
		out = append(out, d.Type)
	}
	return out
}
func (r *Registry) GenerationModeNames() []string {
	seen := map[string]struct{}{}
	for _, d := range r.List() {
		if d.GenerationMode != "" {
			seen[d.GenerationMode] = struct{}{}
		}
	}
	out := make([]string, 0, len(seen))
	for mode := range seen {
		out = append(out, mode)
	}
	sort.Strings(out)
	return out
}

func (r *Registry) SupportsGenerationMode(mode string) bool {
	_, ok := r.ResolveGenerationMode(mode)
	return ok
}

func (r *Registry) ResolveGenerationMode(mode string) (Descriptor, bool) {
	mode = normalizeType(mode)
	if mode == "" || r == nil {
		return Descriptor{}, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, descriptor := range r.descriptors {
		if descriptor.GenerationMode == mode {
			return cloneDescriptor(descriptor), true
		}
	}
	return Descriptor{}, false
}
func (r *Registry) Hash() string {
	data, _ := json.Marshal(registryHashItems(r.List()))
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func normalizeFields(fields []string) []string {
	seen := make(map[string]struct{}, len(fields))
	out := make([]string, 0, len(fields))
	for _, field := range fields {
		field = strings.TrimSpace(field)
		if field == "" {
			continue
		}
		if _, exists := seen[field]; exists {
			continue
		}
		seen[field] = struct{}{}
		out = append(out, field)
	}
	return out
}

func cloneDescriptor(descriptor Descriptor) Descriptor {
	descriptor.Connection.AcceptedInputKinds = append([]string(nil), descriptor.Connection.AcceptedInputKinds...)
	descriptor.Connection.RejectedInputKinds = append([]string(nil), descriptor.Connection.RejectedInputKinds...)
	descriptor.GoodFor = append([]string(nil), descriptor.GoodFor...)
	descriptor.NotIdealFor = append([]string(nil), descriptor.NotIdealFor...)
	descriptor.Tradeoffs = append([]string(nil), descriptor.Tradeoffs...)
	descriptor.Actions = append([]string(nil), descriptor.Actions...)
	descriptor.SummaryFields = append([]string(nil), descriptor.SummaryFields...)
	descriptor.DetailFields = append([]string(nil), descriptor.DetailFields...)
	patchFields := make(map[string]PatchField, len(descriptor.PatchFields))
	for key, field := range descriptor.PatchFields {
		patchFields[key] = field
	}
	descriptor.PatchFields = patchFields
	return descriptor
}

type hashDescriptor struct {
	Type            string
	Version         string
	Label           string
	Purpose         string
	GoodFor         []string
	NotIdealFor     []string
	Tradeoffs       []string
	Actions         []string
	DefaultWidth    float64
	DefaultHeight   float64
	InputKind       string
	GenerationMode  string
	Connection      hashConnectionPolicy
	CanUpdate       bool
	SummaryFields   []string
	DetailFields    []string
	ProjectionKind  string
	ProjectionField string
	PatchFields     []hashPatchField
}

type hashConnectionPolicy struct {
	CanSource          bool
	CanTarget          bool
	CanReference       bool
	AcceptedInputKinds []string
	RejectedInputKinds []string
	MaxInputCount      int
}

type hashPatchField struct {
	Key         string
	Path        string
	Kind        string
	Label       string
	Order       int
	Description string
	MaxRunes    int
}

func registryHashItems(descriptors []Descriptor) []hashDescriptor {
	items := make([]hashDescriptor, 0, len(descriptors))
	for _, descriptor := range descriptors {
		keys := make([]string, 0, len(descriptor.PatchFields))
		for key := range descriptor.PatchFields {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		patchFields := make([]hashPatchField, 0, len(keys))
		for _, key := range keys {
			field := descriptor.PatchFields[key]
			patchFields = append(patchFields, hashPatchField{Key: key, Path: field.Path, Kind: field.Kind, Label: field.Label, Order: field.Order, Description: field.Description, MaxRunes: field.MaxRunes})
		}
		items = append(items, hashDescriptor{
			Type: descriptor.Type, Version: descriptor.Version, Label: descriptor.Label,
			Purpose: descriptor.Purpose, GoodFor: descriptor.GoodFor, NotIdealFor: descriptor.NotIdealFor,
			Tradeoffs: descriptor.Tradeoffs, Actions: descriptor.Actions,
			DefaultWidth: descriptor.DefaultWidth, DefaultHeight: descriptor.DefaultHeight,
			InputKind: descriptor.InputKind, GenerationMode: descriptor.GenerationMode,
			ProjectionKind: descriptor.ProjectionKind, ProjectionField: descriptor.ProjectionField,
			Connection: hashConnectionPolicy{CanSource: descriptor.Connection.CanSource, CanTarget: descriptor.Connection.CanTarget, CanReference: descriptor.Connection.CanReference, AcceptedInputKinds: descriptor.Connection.AcceptedInputKinds, RejectedInputKinds: descriptor.Connection.RejectedInputKinds, MaxInputCount: descriptor.Connection.MaxInputCount},
			CanUpdate:  descriptor.CanUpdate, SummaryFields: descriptor.SummaryFields, DetailFields: descriptor.DetailFields, PatchFields: patchFields,
		})
	}
	return items
}
