package canvas

import (
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/assets"
)

const maxCanvasImageHistory = 50

func nonDataHistoryURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || strings.HasPrefix(strings.ToLower(trimmed), "data:") {
		return ""
	}
	return trimmed
}

func normalizedHistoryStorageKey(rawStorageKey, rawContent string) string {
	key := strings.TrimSpace(rawStorageKey)
	if key != "" {
		return key
	}
	if resourceID := firstDocResourceID("", nonDataHistoryURL(rawContent)); resourceID != "" {
		return "resource:" + resourceID
	}
	return ""
}

func buildHistoryEntryFromMetadata(metadata map[string]any) map[string]any {
	return buildHistoryEntryFromMetadataExcludingTask(metadata, "")
}

func buildOutgoingHistoryEntryForBind(metadata map[string]any, incomingTaskID string) map[string]any {
	return buildHistoryEntryFromMetadataExcludingTask(metadata, strings.TrimSpace(incomingTaskID))
}

func buildHistoryEntryFromMetadataExcludingTask(metadata map[string]any, excludedTaskID string) map[string]any {
	if metadata == nil {
		return nil
	}
	if isBatchRoot, _ := metadata["isBatchRoot"].(bool); isBatchRoot {
		return nil
	}
	if val, hasUpload := metadata["fileUpload"]; hasUpload && val != nil && val != false && val != "" {
		return nil
	}
	rawContent := nonDataHistoryURL(nodeString(metadata, "content"))
	rawStorageKey := normalizedHistoryStorageKey(nodeString(metadata, "storageKey"), rawContent)
	resourceID := firstDocResourceID(rawStorageKey, rawContent)
	if rawContent == "" && resourceID != "" {
		rawContent = assets.FileURL(resourceID)
	}
	if rawStorageKey == "" && rawContent == "" {
		return nil
	}
	taskID := strings.TrimSpace(nodeString(metadata, "taskId"))
	outputIndex, hasOutputIndex := intFromAny(metadata["taskOutputIndex"])
	sameAsIncomingTask := excludedTaskID != "" && taskID == excludedTaskID
	if sameAsIncomingTask {
		taskID = ""
		hasOutputIndex = false
		outputIndex = 0
	}
	id := ""
	switch {
	case taskID != "":
		id = fmt.Sprintf("%s:%d", taskID, outputIndex)
	case rawStorageKey != "":
		id = "storage:" + rawStorageKey
	default:
		id = "url:" + rawContent
	}
	entry := map[string]any{"id": id}
	if taskID != "" {
		entry["taskId"] = taskID
	}
	if hasOutputIndex {
		entry["outputIndex"] = outputIndex
	}
	if rawStorageKey != "" {
		entry["storageKey"] = rawStorageKey
	}
	if rawContent != "" {
		entry["content"] = rawContent
	}
	for _, key := range []string{"assetId", "mimeType", "model", "size", "quality", "prompt"} {
		if val := strings.TrimSpace(nodeString(metadata, key)); val != "" {
			entry[key] = val
		}
	}
	for _, key := range []string{"naturalWidth", "naturalHeight", "bytes"} {
		if num, ok := positiveNumberFromAny(metadata[key]); ok {
			entry[key] = num
		}
	}
	if !sameAsIncomingTask {
		if completed := strings.TrimSpace(nodeString(metadata, "taskCompletedAt")); completed != "" {
			entry["createdAt"] = completed
		} else if created := strings.TrimSpace(nodeString(metadata, "taskCreatedAt")); created != "" {
			entry["createdAt"] = created
		}
	}
	return entry
}

func archiveImageNodeHistoryBeforeClear(node map[string]any) bool {
	if nodeString(node, "type") != "image" {
		return false
	}
	metadata, _ := node["metadata"].(map[string]any)
	mergedSource := make(map[string]any)
	for _, key := range []string{"content", "storageKey", "assetId", "mimeType", "naturalWidth", "naturalHeight", "bytes"} {
		if val, ok := node[key]; ok && val != nil {
			mergedSource[key] = val
		}
	}
	for key, val := range metadata {
		mergedSource[key] = val
	}
	entry := buildHistoryEntryFromMetadata(mergedSource)
	if entry == nil {
		return false
	}
	if metadata == nil {
		metadata = map[string]any{}
		node["metadata"] = metadata
	}
	history := upsertImageHistorySlice(metadata["imageHistory"], entry, false, metadata["imageHistoryRemovedIds"])
	if len(history) == 0 {
		return false
	}
	metadata["imageHistory"] = history
	return true
}

func buildHistoryEntryFromPatch(metadata map[string]any, patch TaskOutputBind) map[string]any {
	entry := buildHistoryEntryFromMetadata(metadata)
	if entry == nil {
		return nil
	}
	if patch.OutputIndex >= 0 {
		entry["outputIndex"] = patch.OutputIndex
		if strings.TrimSpace(patch.TaskID) != "" {
			entry["id"] = fmt.Sprintf("%s:%d", strings.TrimSpace(patch.TaskID), patch.OutputIndex)
		}
	}
	if val := strings.TrimSpace(patch.TaskPrompt); val != "" {
		entry["prompt"] = val
	}
	if val := strings.TrimSpace(patch.TaskModel); val != "" {
		entry["model"] = val
	}
	if val := strings.TrimSpace(patch.TaskSize); val != "" {
		entry["size"] = val
	}
	if val := strings.TrimSpace(patch.TaskQuality); val != "" {
		entry["quality"] = val
	}
	if val := strings.TrimSpace(patch.TaskCompletedAt); val != "" {
		entry["createdAt"] = val
	}
	return entry
}

func sameHistoryEntryIdentity(left, right map[string]any) bool {
	leftKey := normalizedHistoryStorageKey(nodeString(left, "storageKey"), nodeString(left, "content"))
	rightKey := normalizedHistoryStorageKey(nodeString(right, "storageKey"), nodeString(right, "content"))
	if leftKey != "" && rightKey != "" {
		return leftKey == rightKey
	}
	leftContent := nonDataHistoryURL(nodeString(left, "content"))
	rightContent := nonDataHistoryURL(nodeString(right, "content"))
	if leftKey == "" && rightKey == "" && leftContent != "" && rightContent != "" {
		return leftContent == rightContent
	}
	leftID := strings.TrimSpace(nodeString(left, "id"))
	rightID := strings.TrimSpace(nodeString(right, "id"))
	return leftID != "" && rightID != "" && leftID == rightID
}

var preservedArchivedHistoryKeys = map[string]struct{}{
	"id":          {},
	"taskId":      {},
	"outputIndex": {},
	"prompt":      {},
	"model":       {},
	"size":        {},
	"quality":     {},
	"createdAt":   {},
}

func mergeHistoryEntry(existing, incoming map[string]any, overwriteGeneration bool) map[string]any {
	merged := make(map[string]any, len(existing)+len(incoming))
	for key, val := range existing {
		merged[key] = val
	}
	for key, val := range incoming {
		if val == nil {
			continue
		}
		if str, ok := val.(string); ok && strings.TrimSpace(str) == "" {
			continue
		}
		if !overwriteGeneration {
			if _, protected := preservedArchivedHistoryKeys[key]; protected {
				if prev, hasPrev := merged[key]; hasPrev && prev != nil {
					if prevStr, isStr := prev.(string); !isStr || strings.TrimSpace(prevStr) != "" {
						continue
					}
				}
			}
		}
		merged[key] = val
	}
	return merged
}

func removedHistoryIDSet(raw any) map[string]struct{} {
	out := map[string]struct{}{}
	switch typed := raw.(type) {
	case []any:
		for _, candidate := range typed {
			if text, ok := candidate.(string); ok && strings.TrimSpace(text) != "" {
				out[strings.TrimSpace(text)] = struct{}{}
			}
		}
	case []string:
		for _, text := range typed {
			if strings.TrimSpace(text) != "" {
				out[strings.TrimSpace(text)] = struct{}{}
			}
		}
	}
	return out
}

func upsertImageHistorySlice(raw any, item map[string]any, overwriteGeneration bool, removedRaw ...any) []any {
	var removed map[string]struct{}
	if len(removedRaw) > 0 {
		removed = removedHistoryIDSet(removedRaw[0])
	}
	list := make([]map[string]any, 0)
	if items, ok := raw.([]any); ok {
		for _, candidate := range items {
			entry, ok := candidate.(map[string]any)
			if !ok || entry == nil {
				continue
			}
			cloned := mergeHistoryEntry(nil, entry, true)
			if entryID := strings.TrimSpace(nodeString(cloned, "id")); entryID != "" {
				if _, isRemoved := removed[entryID]; isRemoved && (item == nil || !sameHistoryEntryIdentity(cloned, item)) {
					continue
				}
			}
			matchIdx := -1
			for idx, prev := range list {
				if sameHistoryEntryIdentity(prev, cloned) {
					matchIdx = idx
					break
				}
			}
			if matchIdx >= 0 {
				list[matchIdx] = mergeHistoryEntry(list[matchIdx], cloned, false)
			} else {
				list = append(list, cloned)
			}
		}
	}
	if item != nil {
		itemID := strings.TrimSpace(nodeString(item, "id"))
		_, itemRemoved := removed[itemID]
		if !itemRemoved || overwriteGeneration {
			matchIdx := -1
			for idx, prev := range list {
				if sameHistoryEntryIdentity(prev, item) {
					matchIdx = idx
					break
				}
			}
			if matchIdx >= 0 {
				list[matchIdx] = mergeHistoryEntry(list[matchIdx], item, overwriteGeneration)
			} else {
				list = append(list, item)
			}
		}
	}
	for len(list) > maxCanvasImageHistory {
		dropIdx := 0
		if item != nil {
			for idx, entry := range list {
				if !sameHistoryEntryIdentity(entry, item) {
					dropIdx = idx
					break
				}
			}
		}
		list = append(list[:dropIdx], list[dropIdx+1:]...)
	}
	out := make([]any, len(list))
	for idx, entry := range list {
		out[idx] = entry
	}
	return out
}

func intFromAny(val any) (int, bool) {
	switch typed := val.(type) {
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case float64:
		return int(typed), true
	default:
		return 0, false
	}
}

func positiveNumberFromAny(val any) (any, bool) {
	switch typed := val.(type) {
	case int:
		if typed > 0 {
			return typed, true
		}
	case int64:
		if typed > 0 {
			return typed, true
		}
	case float64:
		if typed > 0 {
			return typed, true
		}
	}
	return nil, false
}
