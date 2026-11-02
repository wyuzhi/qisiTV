package assets

import (
	"encoding/json"
	"sort"
	"strings"
)

func DocumentReferences(raw string, resourceIDs map[string]struct{}) bool {
	return len(DocumentReferencedIDs(raw, resourceIDs)) > 0
}

func DocumentReferencedIDs(raw string, resourceIDs map[string]struct{}) map[string]struct{} {
	matched := map[string]struct{}{}
	raw = strings.TrimSpace(raw)
	if raw == "" || len(resourceIDs) == 0 {
		return matched
	}
	found := map[string]struct{}{}
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err == nil {
		if scalar, ok := value.(string); ok {
			if resourceID := ResourceID(scalar); resourceID != "" {
				found[resourceID] = struct{}{}
			}
		} else {
			walkReferenceDocument(value, "", found)
		}
	} else if resourceID := ResourceID(raw); resourceID != "" {
		found[resourceID] = struct{}{}
	}
	for resourceID := range found {
		if _, exists := resourceIDs[resourceID]; exists {
			matched[resourceID] = struct{}{}
		}
	}
	return matched
}

func CollectOwnedDocumentReferences(raw string, resourceIDs map[string]struct{}) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return err
	}
	collectDecodedDocumentReferences(value, resourceIDs)
	return nil
}

// CollectOwnedDocumentReferencesFromDecoded reuses a decoded JSON document.
// Scientific notation and very long numbers retain the original parser's range
// checks, including values overwritten by duplicate keys during decoding.
func CollectOwnedDocumentReferencesFromDecoded(raw string, value any, resourceIDs map[string]struct{}) error {
	if referenceNumbersNeedValidation(raw) {
		return CollectOwnedDocumentReferences(raw, resourceIDs)
	}
	collectDecodedDocumentReferences(value, resourceIDs)
	return nil
}

func collectDecodedDocumentReferences(value any, resourceIDs map[string]struct{}) {
	if scalar, ok := value.(string); ok {
		if resourceID := ResourceID(scalar); resourceID != "" {
			resourceIDs[resourceID] = struct{}{}
		}
		return
	}
	walkReferenceDocument(value, "", resourceIDs)
}

// raw is already validated JSON. Skip strings (including escaped quotes) so
// resource IDs and prompts containing exponent-like text stay on the fast path.
func referenceNumbersNeedValidation(raw string) bool {
	digits := 0
	for i := 0; i < len(raw); i++ {
		if raw[i] == '"' {
			digits = 0
			for i++; i < len(raw); i++ {
				if raw[i] == '\\' {
					i++
				} else if raw[i] == '"' {
					break
				}
			}
		} else if raw[i] >= '0' && raw[i] <= '9' {
			digits++
			if digits >= 309 || (i+1 < len(raw) && (raw[i+1] == 'e' || raw[i+1] == 'E')) {
				return true
			}
		} else {
			digits = 0
		}
	}
	return false
}

func SortedIDs(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func walkReferenceDocument(value any, parentKey string, resourceIDs map[string]struct{}) {
	switch item := value.(type) {
	case map[string]any:
		for key, child := range item {
			walkReferenceDocument(child, key, resourceIDs)
		}
	case []any:
		for _, child := range item {
			walkReferenceDocument(child, parentKey, resourceIDs)
		}
	case string:
		if isResourceLocatorField(parentKey) {
			if resourceID := ResourceID(item); resourceID != "" {
				resourceIDs[resourceID] = struct{}{}
			}
		}
		if isBareResourceIDField(parentKey) {
			if resourceID := ValidID(item); resourceID != "" {
				resourceIDs[resourceID] = struct{}{}
			}
		}
	}
}

func isBareResourceIDField(field string) bool {
	switch field {
	case "resourceId", "resourceIds", "sampleResourceId", "referenceResourceId", "referenceResourceIds":
		return true
	default:
		return false
	}
}

func isResourceLocatorField(field string) bool {
	switch field {
	case "storageKey", "content", "previewContent", "drawingPreviewStorageKey", "drawingPreviewUrl", "url", "dataUrl", "coverUrl", "imageUrl", "videoUrl", "audioUrl", "referenceUrl", "referenceUrls", "artifactRef", "providerArtifactRef":
		return true
	default:
		return false
	}
}
