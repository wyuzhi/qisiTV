package app

import (
	localproject "qisitv/backend/internal/project"
)

const (
	AssetSourceUploaded = localproject.AssetSourceUploaded
	AssetSourceCanvas   = localproject.AssetSourceCanvas
)

type LinkProjectAssetRequest = localproject.LinkProjectAssetRequest
type UpdateProjectAssetRequest = localproject.UpdateProjectAssetRequest
type CreateAssetVersionRequest = localproject.CreateAssetVersionRequest
type ProjectAssetFilter = localproject.ProjectAssetFilter
type ConfirmProjectAssetCandidateRequest = localproject.ConfirmProjectAssetCandidateRequest

func (s *Service) ProjectAssets(userID string, projectID string) ([]ProjectAssetSummary, error) {
	return s.projectDomain().ProjectAssets(userID, projectID)
}
