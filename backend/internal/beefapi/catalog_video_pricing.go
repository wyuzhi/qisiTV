package beefapi

import (
	"encoding/json"

	"qisitv/backend/internal/modelcatalog"
)

func NormalizeCatalogVideoPricing(raw json.RawMessage) (map[string]any, bool) {
	return modelcatalog.NormalizeCatalogVideoPricing(raw)
}
