package projectfolder

import (
	"fmt"
	"strings"
)

// Browser object URLs and IndexedDB keys are previews, not project media. Never
// acknowledge their manifest as durable unless the same media object supplies a
// canonical resource identity (whose bytes buildManifest subsequently verifies).
func normalizeDurableMedia(value any, mediaContext bool, location string) error {
	switch v := value.(type) {
	case map[string]any:
		if _, hasStorageKey := v["storageKey"]; hasStorageKey {
			mediaContext = true
		}
		if _, hasResourceID := v["resourceId"]; hasResourceID {
			mediaContext = true
		}
		if kind, _ := v["type"].(string); kind == "image" || kind == "video" || kind == "audio" {
			mediaContext = true
		}
		resourceID, _ := v["resourceId"].(string)
		if key, _ := v["storageKey"].(string); resourceID == "" && strings.HasPrefix(key, "resource:") {
			resourceID = strings.TrimPrefix(key, "resource:")
		}
		if !safeID.MatchString(resourceID) {
			resourceID = ""
		}
		for key, child := range v {
			if text, ok := child.(string); ok && ephemeralMediaReference(text) && mediaField(key, mediaContext) {
				if resourceID != "" && (key == "content" || key == "url" || key == "src" || key == "storageKey") {
					if key == "storageKey" {
						v[key] = "resource:" + resourceID
					} else {
						v[key] = "/api/resources/" + resourceID + "/file"
					}
					continue
				}
				return fmt.Errorf("project media is not durably stored at %s.%s; upload it to the local engine before saving", location, key)
			}
			if err := normalizeDurableMedia(child, mediaContext, location+"."+key); err != nil {
				return err
			}
		}
	case []any:
		for index, child := range v {
			if err := normalizeDurableMedia(child, mediaContext, fmt.Sprintf("%s[%d]", location, index)); err != nil {
				return err
			}
		}
	}
	return nil
}

func ephemeralMediaReference(value string) bool {
	for _, prefix := range []string{"blob:", "data:", "image:", "video:", "audio:", "media:", "local-media:"} {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(value)), prefix) {
			return true
		}
	}
	return false
}

func mediaField(key string, mediaContext bool) bool {
	if key == "content" {
		return mediaContext
	}
	lower := strings.ToLower(key)
	return lower == "src" || lower == "url" || lower == "storagekey" || lower == "blobkey" || lower == "previewkey" || lower == "poster" || strings.HasSuffix(lower, "url") || strings.HasSuffix(lower, "storagekey")
}
