package plugins

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"qisitv/backend/internal/protocol"
)

// ReferenceUsage counts the saved state that still needs one provider ID. The
// audit only counts references; it never reads, copies or returns credentials.
type ReferenceUsage struct {
	// Configured counts saved connections and model profiles that name the ID.
	Configured int64 `json:"configured"`
	// PendingTasks counts tasks whose result may still be retrieved through the
	// original protocol: queued/running work, failed tasks that still hold an
	// upstream task ID, and cancelled tasks whose upstream cancellation is open.
	PendingTasks int64 `json:"pendingTasks"`
}

// ReferenceSource reports the provider IDs that saved configuration or
// unfinished tasks still need. It exists so bootstrap can stop a release from
// deleting an official plugin that old configuration still executes with.
//
// Implementations read local state only and must never log or expose credential
// material. A nil source means the caller has no inventory, and the historical
// "drop every built-in this release no longer ships" behavior stays in effect.
type ReferenceSource interface {
	ReferencedProviders() (map[string]ReferenceUsage, error)
}

// RetentionView explains why a plugin this release no longer ships is still
// installed. It is derived on every startup from saved configuration and
// unfinished tasks, so it is never persisted and never becomes a second source
// of truth: once the last reference disappears, the next startup stops
// retaining the record.
type RetentionView struct {
	// Retired marks a plugin that stays executable but must not be offered for
	// new selections.
	Retired bool `json:"retired"`
	// Reasons are user-facing explanations, e.g. "2 个未完成的任务仍在使用该协议".
	Reasons []string `json:"reasons,omitempty"`
	// Unknown reports that the reference inventory could not be read and the
	// plugin was retained conservatively instead of being deleted.
	Unknown bool `json:"unknown,omitempty"`
}

func cloneRetention(note *RetentionView) *RetentionView {
	if note == nil {
		return nil
	}
	return &RetentionView{Retired: note.Retired, Unknown: note.Unknown, Reasons: cloneStringSlice(note.Reasons)}
}

// referenceSnapshot is one startup inventory read, shared by every retention
// decision so a single reconcile never audits the same state twice.
type referenceSnapshot struct {
	usage map[string]ReferenceUsage
	// unavailable means the inventory could not be read at all. Removal decisions
	// then keep the installed definition; updates preserving all IDs still apply.
	unavailable bool
}

// snapshotReferences reads the inventory once. A nil source reports "no
// inventory", which keeps the historical behavior of callers that own their
// registry outright.
func (c *Runtime) snapshotReferences() referenceSnapshot {
	if c.references == nil {
		return referenceSnapshot{}
	}
	usage, err := c.references.ReferencedProviders()
	if err != nil {
		return referenceSnapshot{unavailable: true}
	}
	return referenceSnapshot{usage: usage}
}

// total counts the saved state that still needs this record's protocol IDs.
func (s referenceSnapshot) total(record RegistryRecord) (configured, pending int64) {
	for _, id := range recordProviderIDs(record.Raw) {
		usage := s.usage[id]
		configured += usage.Configured
		pending += usage.PendingTasks
	}
	return configured, pending
}

// retentionDecisions decides which built-in records survive this startup even
// though the release no longer ships their package. A record absent from the
// result is dropped, which keeps the historical cleanup for every plugin
// nothing references any more.
func (c *Runtime) retentionDecisions(missing []RegistryRecord, snapshot referenceSnapshot) map[string]*RetentionView {
	decisions := make(map[string]*RetentionView, len(missing))
	if len(missing) == 0 || c.references == nil {
		return decisions
	}
	if snapshot.unavailable {
		// An unreadable inventory must never delete an executable protocol.
		for _, record := range missing {
			decisions[record.ID] = &RetentionView{
				Retired: true,
				Unknown: true,
				Reasons: []string{"插件引用盘点失败，已按保守策略保留该协议"},
			}
		}
		return decisions
	}
	for _, record := range missing {
		if note := retentionFor(record, snapshot); note != nil {
			decisions[record.ID] = note
		}
	}
	return decisions
}

// deferralFor protects referenced IDs that a release removes. Existing tasks
// must receive compatible fixes too: their presence alone cannot pin a broken
// parser forever. Keeping an ID is a compatibility promise by the package
// maintainer, not proof of request/response compatibility; package regressions
// must cover old receipts and queries using the original upstream task ID.
func deferralFor(stored, next RegistryRecord, snapshot referenceSnapshot) *RetentionView {
	// A plugin this release ships but that is not installed yet has no old
	// definition to preserve. Deferring it would make a new plugin silently absent
	// for as long as the inventory stays unreadable, so only an existing record can
	// be deferred.
	if strings.TrimSpace(stored.ID) == "" || len(stored.Raw) == 0 {
		return nil
	}
	// Only the manifest describes how a task is queried and parsed; blob
	// bookkeeping (package path, hash) can change without changing execution.
	// Comparing it keeps a re-packaged identical definition from being reported as
	// a deferred upgrade.
	if string(stored.Raw) == string(next.Raw) {
		return nil
	}
	// Compare resolvable provider IDs and aliases on both sides. A package name
	// alone neither serves a saved protocol nor proves that it survived a rename.
	kept := resolvableProviderIDs(next.Raw)
	var configured, pending int64
	for id := range resolvableProviderIDs(stored.Raw) {
		if _, ok := kept[id]; !ok {
			if snapshot.unavailable {
				return &RetentionView{Reasons: []string{"插件引用盘点失败，无法确认新版本移除的协议是否仍被使用，升级已推迟"}}
			}
			configured += snapshot.usage[id].Configured
			pending += snapshot.usage[id].PendingTasks
		}
	}
	var reasons []string
	if configured > 0 {
		reasons = append(reasons, fmt.Sprintf("新版本删除或改名了 %d 个已保存的连接或模型配置仍在使用的协议，升级已推迟", configured))
	}
	if pending > 0 {
		reasons = append(reasons, fmt.Sprintf("新版本删除或改名了 %d 个未完成或待取回结果的任务仍在使用的协议，升级已推迟", pending))
	}
	if len(reasons) == 0 {
		return nil
	}
	return &RetentionView{Reasons: reasons}
}

// resolvableProviderIDs lists the IDs the registry resolves to this manifest's
// providers once installed, by the same rules as protocol.Registry.Resolve:
// provider IDs, their legacy aliases and the other names Resolve accepts.
func resolvableProviderIDs(raw []byte) map[string]struct{} {
	ids := make(map[string]struct{})
	adapters, err := protocol.LoadInstalledProviders(raw)
	if err != nil {
		return ids
	}
	for _, adapter := range adapters {
		for _, id := range protocol.ResolvableIDs(adapter.Metadata()) {
			ids[id] = struct{}{}
		}
	}
	return ids
}

func retentionFor(record RegistryRecord, snapshot referenceSnapshot) *RetentionView {
	configured, pending := snapshot.total(record)
	if configured <= 0 && pending <= 0 {
		return nil
	}
	note := &RetentionView{Retired: true}
	if configured > 0 {
		note.Reasons = append(note.Reasons, fmt.Sprintf("%d 个已保存的连接或模型配置仍在使用该协议", configured))
	}
	if pending > 0 {
		note.Reasons = append(note.Reasons, fmt.Sprintf("%d 个未完成或待取回结果的任务仍在使用该协议", pending))
	}
	return note
}

// recordProviderIDs lists every ID a saved configuration may use to reach this
// plugin: the plugin ID itself, each contributed provider ID, and every other ID
// protocol.Registry.Resolve maps onto those providers (legacy aliases such as
// `openai-video`). Configuration and tasks store provider IDs such as `newapi`
// for the `openai-videos` package, or only an alias the runtime still resolves,
// so matching on the package ID alone would miss real references.
func recordProviderIDs(raw []byte) []string {
	var manifest protocol.Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil
	}
	seen := make(map[string]struct{}, len(manifest.Contributes.Providers)+1)
	ids := make([]string, 0, len(manifest.Contributes.Providers)+1)
	appendID := func(id string) {
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
	appendID(manifest.Metadata.ID)
	for _, provider := range manifest.Contributes.Providers {
		appendID(provider.ID)
	}
	// Host-backed manifests cannot load without their execution engine; they keep
	// the IDs read from the manifest above.
	for id := range resolvableProviderIDs(raw) {
		appendID(id)
	}
	sort.Strings(ids)
	return ids
}

func applyRetention(plugins map[string]Record, notes map[string]*RetentionView) {
	for id, note := range notes {
		record, ok := plugins[id]
		if !ok {
			continue
		}
		record.Retention = cloneRetention(note)
		plugins[id] = record
	}
}
