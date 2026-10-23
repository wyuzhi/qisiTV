package canvas

import (
	"encoding/json"

	"qisitv/backend/internal/asset"
	"qisitv/backend/internal/model"
)

func ClientAssetPayload(item model.Asset) json.RawMessage {
	return asset.ClientAssetPayload(item)
}
