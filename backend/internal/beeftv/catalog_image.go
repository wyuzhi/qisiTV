package beeftv

import (
	"encoding/json"

	"qisitv/backend/internal/modelcatalog"
)

// Keep the existing capability JSON shape intact. Its server owns model limits;
// validating the shape must not substitute a local model table or size cap.
func NormalizeCatalogImageCapability(raw json.RawMessage) (map[string]any, bool) {
	return modelcatalog.NormalizeCatalogImageCapability(raw)
}
