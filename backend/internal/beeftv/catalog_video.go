package beeftv

import (
	"encoding/json"

	"infinite-canvas/backend/internal/modelcatalog"
)

// A managed declaration needs a version and explicit counts for each media
// kind. Missing counts must not turn into unsupported inputs after decoding.
func NormalizeVersionedVideoCapability(raw json.RawMessage, version string) (map[string]any, bool) {
	return modelcatalog.NormalizeVersionedVideoCapability(raw, version)
}

// NormalizeCatalogVideoCapability copies a gateway video_capabilities object
// using the existing BeefTV VideoCapabilityConfig field names and bounds.
// Omitted nested limits stay omitted so callers do not persist implicit zeros.
func NormalizeCatalogVideoCapability(raw json.RawMessage) (map[string]any, bool) {
	return modelcatalog.NormalizeCatalogVideoCapability(raw)
}

func normalizeCatalogDuration(input map[string]any) (map[string]any, bool) {
	return modelcatalog.NormalizeCatalogDuration(input)
}
