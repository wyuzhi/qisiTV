package beeftv

import (
	"encoding/json"

	"infinite-canvas/backend/internal/modelcatalog"
)

func NormalizeCatalogVideoPricing(raw json.RawMessage) (map[string]any, bool) {
	return modelcatalog.NormalizeCatalogVideoPricing(raw)
}
