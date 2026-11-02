package app

import (
	"qisitv/backend/internal/model"
	localproject "qisitv/backend/internal/project"
)

type CreateProjectAssetFolderRequest = localproject.CreateProjectAssetFolderRequest
type UpdateProjectAssetFolderRequest = localproject.UpdateProjectAssetFolderRequest

func validateProjectAssetFolderParent(folders []model.ProjectAssetFolder, folderID string, parentID string) error {
	return localproject.ValidateAssetFolderParent(folders, folderID, parentID)
}

func projectAssetFolderNameExists(folders []model.ProjectAssetFolder, parentID string, name string, excludeID string) bool {
	return localproject.AssetFolderNameExists(folders, parentID, name, excludeID)
}

func validateProjectAssetFolderTheme(value string) (string, error) {
	return localproject.ValidateAssetFolderTheme(value)
}
