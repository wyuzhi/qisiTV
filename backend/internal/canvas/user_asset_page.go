package canvas

import "qisitv/backend/internal/asset"

type UserAssetPage = asset.UserAssetPage
type UserAssetPageFilter = asset.UserAssetPageFilter

func (s *Service) UserAssetsPage(userID string, page int, pageSize int, filter UserAssetPageFilter) (UserAssetPage, error) {
	return s.Library().UserAssetsPage(userID, page, pageSize, filter)
}
