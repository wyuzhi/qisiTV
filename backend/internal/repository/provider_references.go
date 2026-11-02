package repository

import (
	"encoding/json"
	"strings"

	"qisitv/backend/internal/model"
)

// providerReferenceCount is one row of the plugin retention audit: how many
// saved records still point at a protocol/provider ID.
type providerReferenceCount struct {
	Provider string
	Total    int64
}

// ChannelModelProtocolReferences counts saved system channel models per
// protocol. A retired protocol plugin must stay executable while a channel
// model still names it, otherwise editing or re-testing that model would lose
// the protocol it executes with.
func (r *Repository) ChannelModelProtocolReferences() (map[string]int64, error) {
	var rows []providerReferenceCount
	err := r.db.Model(&model.ChannelModel{}).
		Select("protocol AS provider, COUNT(*) AS total").
		Where("protocol IS NOT NULL AND protocol <> ''").
		Group("protocol").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	return referenceCountMap(rows), nil
}

// TaskProviderReferences counts the protocols that tasks awaiting a result
// still execute with.
//
// The top-level tasks.provider column cannot answer this: ordinary BYOK tasks
// leave it empty and route tasks set it to "managed", while the protocol that
// is actually dispatched lives in the task input at config.interfaceType. A
// query on provider alone therefore misses real in-flight work and would let a
// release delete the plugin those tasks still need. Both sources are read and
// de-duplicated per task.
//
// Only work that can still reach the provider is counted: queued or running
// tasks the worker keeps polling, failed tasks that hold an upstream task ID
// (manual recovery queries the same protocol instead of submitting again), and
// cancelled tasks whose upstream cancellation is still open.
// Finished tasks, tasks that failed before submission and text replay
// containers never call a provider again.
//
// A failed task's upstream ID may live only in its request log: manual recovery
// fills an empty tasks.provider_request_id from the latest api_call_logs row of
// that task with a non-empty provider_request_id before querying. Such tasks are
// counted the same way, so the audit matches what recovery can actually reach.
// The log is only read here, never copied back onto the task.
func (r *Repository) TaskProviderReferences() (map[string]int64, error) {
	active := []model.TaskStatus{model.TaskStatusQueued, model.TaskStatusRunning}
	var rows []taskReferenceRow
	err := r.db.Model(&model.Task{}).
		Select("provider", "input_json").
		Where(
			"status IN ? OR (status = ? AND (provider_request_id <> '' OR EXISTS (SELECT 1 FROM api_call_logs l WHERE l.task_id = tasks.id AND l.provider_request_id <> ''))) OR (status = ? AND provider_request_id <> '' AND provider_cancel_status = ?)",
			active, model.TaskStatusFailed, model.TaskStatusCancelled, model.ProviderCancelStatusRequested,
		).
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	counts := make(map[string]int64, len(rows))
	for _, row := range rows {
		for _, protocol := range taskProtocols(row.Provider, row.InputJSON) {
			counts[protocol]++
		}
	}
	return counts, nil
}

type taskReferenceRow struct {
	Provider  string
	InputJSON string
}

// taskProtocols lists the protocol IDs one task can still dispatch with,
// without duplicates. A legacy row may only carry the top-level provider; a
// BYOK row carries the protocol in its input config.
func taskProtocols(provider, inputJSON string) []string {
	seen := make(map[string]struct{}, 2)
	protocols := make([]string, 0, 2)
	add := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, exists := seen[id]; exists {
			return
		}
		seen[id] = struct{}{}
		protocols = append(protocols, id)
	}
	add(provider)
	add(inputProtocol(inputJSON))
	return protocols
}

// inputProtocol reads the dispatched protocol from the stored task input. It
// decodes only this one field; credential values are never read or returned.
func inputProtocol(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	var document struct {
		Config struct {
			InterfaceType string `json:"interfaceType"`
		} `json:"config"`
	}
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		return ""
	}
	return document.Config.InterfaceType
}

func referenceCountMap(rows []providerReferenceCount) map[string]int64 {
	counts := make(map[string]int64, len(rows))
	for _, row := range rows {
		if row.Provider == "" || row.Total <= 0 {
			continue
		}
		counts[row.Provider] = row.Total
	}
	return counts
}
