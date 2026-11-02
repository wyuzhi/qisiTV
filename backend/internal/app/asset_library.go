package app

import (
	"qisitv/backend/internal/asset"
)

type CreateAssetFolderRequest = asset.CreateAssetFolderRequest
type UpdateAssetFolderRequest = asset.UpdateAssetFolderRequest
type MoveUserAssetsRequest = asset.MoveUserAssetsRequest

// AssetLibraryService exposes the domain service to the HTTP composition layer.
func (s *Service) AssetLibraryService() *asset.Library { return s.assetLibrary() }

func (s *Service) assetLibrary() *asset.Library {
	return s.canvasDomain().Library()
}
