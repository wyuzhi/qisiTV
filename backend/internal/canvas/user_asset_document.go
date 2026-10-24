package canvas

import (
	"encoding/json"

	"qisitv/backend/internal/asset"
)

func validateUserAssetDocument(raw json.RawMessage) error {
	return asset.ValidateDocument(raw)
}
