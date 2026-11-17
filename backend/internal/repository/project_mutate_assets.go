package repository

import (
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (r *Repository) CreateProjectAssetVersionAndBump(userID, projectID string, asset *model.Asset, version *model.AssetVersion) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		var linked int64
		if err := tx.Model(&model.ProjectAssetLink{}).Where("project_id = ? AND asset_id = ?", projectID, asset.ID).Count(&linked).Error; err != nil {
			return err
		}
		if linked == 0 {
			return gorm.ErrRecordNotFound
		}
		var maxVersion int
		if err := tx.Model(&model.AssetVersion{}).Where("asset_id = ?", asset.ID).Select("COALESCE(MAX(version), 0)").Scan(&maxVersion).Error; err != nil {
			return err
		}
		version.Version = maxVersion + 1
		if err := tx.Create(version).Error; err != nil {
			return err
		}
		asset.PrimaryVersionID = version.ID
		asset.Status = model.AssetVersionStatusDraft
		result := tx.Model(&model.Asset{}).Where("id = ? AND user_id = ?", asset.ID, asset.UserID).Updates(map[string]any{
			"primary_version_id": asset.PrimaryVersionID, "status": asset.Status, "updated_at": asset.UpdatedAt,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return bumpProjectRevisionTx(tx, projectID, asset.UpdatedAt)
	})
}

func (r *Repository) UpdateProjectAssetCategoryAndBump(userID, projectID string, expectedRevision int64, asset *model.Asset) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		var linked int64
		if err := tx.Model(&model.ProjectAssetLink{}).Where("project_id = ? AND asset_id = ?", projectID, asset.ID).Count(&linked).Error; err != nil {
			return err
		}
		if linked == 0 {
			return gorm.ErrRecordNotFound
		}
		result := tx.Model(&model.Asset{}).Where("id = ? AND user_id = ?", asset.ID, asset.UserID).Updates(map[string]any{
			"category": asset.Category, "updated_at": asset.UpdatedAt,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return bumpProjectRevisionCASTx(tx, projectID, expectedRevision, asset.UpdatedAt)
	})
}

func (r *Repository) MoveProjectAssetActive(userID, projectID, assetID, folderID string, position int) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		if folderID != "" {
			if err := tx.First(&model.ProjectAssetFolder{}, "id = ? AND project_id = ?", folderID, projectID).Error; err != nil {
				return err
			}
		}
		result := tx.Model(&model.ProjectAssetLink{}).
			Where("project_id = ? AND asset_id = ?", projectID, assetID).
			Updates(map[string]any{"folder_id": folderID, "position": position})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return bumpProjectRevisionTx(tx, projectID, time.Now())
	})
}

func (r *Repository) UnlinkProjectAssetAndBump(userID, projectID, assetID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		var references int64
		if err := tx.Table("shot_asset_references").
			Joins("JOIN shots ON shots.id = shot_asset_references.shot_id").
			Joins("JOIN asset_versions ON asset_versions.id = shot_asset_references.asset_version_id").
			Where("shots.project_id = ? AND asset_versions.asset_id = ?", projectID, assetID).
			Count(&references).Error; err != nil {
			return err
		}
		if references > 0 {
			return ErrProjectAssetStillReferenced
		}
		result := tx.Delete(&model.ProjectAssetLink{}, "project_id = ? AND asset_id = ?", projectID, assetID)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return bumpProjectRevisionTx(tx, projectID, time.Now())
	})
}

func (r *Repository) CreateProjectAssetCandidatesAndBump(userID, projectID string, candidates []model.ProjectAssetCandidate) ([]model.ProjectAssetCandidate, error) {
	var inserted []model.ProjectAssetCandidate
	err := r.db.Transaction(func(tx *gorm.DB) error {
		created, runErr := createProjectAssetCandidatesAndBumpTx(tx, userID, projectID, candidates)
		inserted = created
		return runErr
	})
	return inserted, err
}

func createProjectAssetCandidatesAndBumpTx(tx *gorm.DB, userID, projectID string, candidates []model.ProjectAssetCandidate) ([]model.ProjectAssetCandidate, error) {
	if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
		return nil, err
	}
	inserted := make([]model.ProjectAssetCandidate, 0, len(candidates))
	for index := range candidates {
		result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&candidates[index])
		if result.Error != nil {
			return nil, result.Error
		}
		if result.RowsAffected == 1 {
			inserted = append(inserted, candidates[index])
		}
	}
	if len(inserted) == 0 {
		return inserted, nil
	}
	return inserted, bumpProjectRevisionTx(tx, projectID, time.Now())
}

func (r *Repository) CreateProjectAssetFolderActive(userID string, folder *model.ProjectAssetFolder) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, folder.ProjectID); err != nil {
			return err
		}
		if folder.ParentID != "" {
			if err := tx.First(&model.ProjectAssetFolder{}, "id = ? AND project_id = ?", folder.ParentID, folder.ProjectID).Error; err != nil {
				return err
			}
		}
		if err := tx.Create(folder).Error; err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, folder.ProjectID, folder.UpdatedAt)
	})
}

func (r *Repository) UpdateProjectAssetFolderActive(userID string, expectedRevision int64, folder *model.ProjectAssetFolder) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, folder.ProjectID); err != nil {
			return err
		}
		if folder.ParentID != "" {
			if err := tx.First(&model.ProjectAssetFolder{}, "id = ? AND project_id = ?", folder.ParentID, folder.ProjectID).Error; err != nil {
				return err
			}
		}
		result := tx.Model(&model.ProjectAssetFolder{}).
			Where("id = ? AND project_id = ?", folder.ID, folder.ProjectID).
			Updates(map[string]any{"parent_id": folder.ParentID, "name": folder.Name, "name_key": folder.NameKey, "style": folder.Style, "theme": folder.Theme, "position": folder.Position, "updated_at": folder.UpdatedAt})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return bumpProjectRevisionCASTx(tx, folder.ProjectID, expectedRevision, folder.UpdatedAt)
	})
}

func (r *Repository) DeleteProjectAssetFolderActive(userID, projectID, folderID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		var childCount int64
		if err := tx.Model(&model.ProjectAssetFolder{}).Where("project_id = ? AND parent_id = ?", projectID, folderID).Count(&childCount).Error; err != nil {
			return err
		}
		var assetCount int64
		if err := tx.Model(&model.ProjectAssetLink{}).Where("project_id = ? AND folder_id = ?", projectID, folderID).Count(&assetCount).Error; err != nil {
			return err
		}
		if childCount > 0 || assetCount > 0 {
			return ErrProjectAssetFolderNotEmpty
		}
		result := tx.Delete(&model.ProjectAssetFolder{}, "id = ? AND project_id = ?", folderID, projectID)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return bumpProjectRevisionTx(tx, projectID, time.Now())
	})
}

func (r *Repository) CreateProjectCharacterActive(userID, projectID string, asset *model.Asset, version *model.AssetVersion, link *model.ProjectAssetLink) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		if strings.TrimSpace(link.FolderID) != "" {
			if err := tx.First(&model.ProjectAssetFolder{}, "id = ? AND project_id = ?", link.FolderID, projectID).Error; err != nil {
				return err
			}
		}
		if err := tx.Create(asset).Error; err != nil {
			return err
		}
		if err := tx.Create(version).Error; err != nil {
			return err
		}
		if err := tx.Create(link).Error; err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, projectID, asset.UpdatedAt)
	})
}

func (r *Repository) SaveCharacterVersionActive(userID, projectID, expectedPrimaryVersionID string, asset *model.Asset, version *model.AssetVersion, representations []model.AssetRepresentation, voice *model.CharacterVoiceBinding) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		if err := saveCharacterVersionCAS(tx, expectedPrimaryVersionID, asset, version, representations, voice); err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, projectID, asset.UpdatedAt)
	})
}

func (r *Repository) ConfirmProjectCharacterCandidateActive(userID string, candidate *model.ProjectAssetCandidate, expectedPrimaryVersionID string, asset *model.Asset, version *model.AssetVersion, representations []model.AssetRepresentation, voice *model.CharacterVoiceBinding) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, candidate.ProjectID); err != nil {
			return err
		}
		if err := saveCharacterVersionCAS(tx, expectedPrimaryVersionID, asset, version, representations, voice); err != nil {
			return err
		}
		result := tx.Model(&model.ProjectAssetCandidate{}).
			Where("id = ? AND project_id = ? AND status = ?", candidate.ID, candidate.ProjectID, "pending_confirmation").
			Updates(map[string]any{"status": candidate.Status, "resolved_asset_id": candidate.ResolvedAssetID, "updated_at": candidate.UpdatedAt})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrInvalidData
		}
		return bumpProjectRevisionTx(tx, candidate.ProjectID, candidate.UpdatedAt)
	})
}

func (r *Repository) ConfirmProjectAssetCandidateActive(userID string, candidate *model.ProjectAssetCandidate, asset *model.Asset, version *model.AssetVersion, link *model.ProjectAssetLink, createAsset bool) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, candidate.ProjectID); err != nil {
			return err
		}
		if strings.TrimSpace(link.FolderID) != "" {
			if err := tx.First(&model.ProjectAssetFolder{}, "id = ? AND project_id = ?", link.FolderID, link.ProjectID).Error; err != nil {
				return err
			}
		}
		if createAsset {
			if err := tx.Create(asset).Error; err != nil {
				return err
			}
			if err := tx.Create(version).Error; err != nil {
				return err
			}
		} else if err := tx.First(&model.Asset{}, "id = ? AND user_id = ?", asset.ID, asset.UserID).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND asset_id = ?", link.ProjectID, link.AssetID).FirstOrCreate(link).Error; err != nil {
			return err
		}
		result := tx.Model(&model.ProjectAssetCandidate{}).
			Where("id = ? AND project_id = ? AND status = ?", candidate.ID, candidate.ProjectID, "pending_confirmation").
			Updates(map[string]any{"status": candidate.Status, "resolved_asset_id": candidate.ResolvedAssetID, "updated_at": candidate.UpdatedAt})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrInvalidData
		}
		return bumpProjectRevisionTx(tx, candidate.ProjectID, candidate.UpdatedAt)
	})
}

func saveCharacterVersionCAS(tx *gorm.DB, expectedPrimaryVersionID string, asset *model.Asset, version *model.AssetVersion, representations []model.AssetRepresentation, voice *model.CharacterVoiceBinding) error {
	if err := tx.Create(version).Error; err != nil {
		return err
	}
	if len(representations) > 0 {
		if err := tx.Create(&representations).Error; err != nil {
			return err
		}
	}
	if voice != nil {
		if err := tx.Create(voice).Error; err != nil {
			return err
		}
	}
	query := whereExpectedPointer(tx.Model(&model.Asset{}).Where("id = ? AND user_id = ?", asset.ID, asset.UserID), "primary_version_id", expectedPrimaryVersionID)
	result := query.Updates(map[string]any{
		"kind": asset.Kind, "category": asset.Category, "status": asset.Status, "primary_version_id": asset.PrimaryVersionID,
		"title": asset.Title, "payload_json": asset.PayloadJSON, "updated_at": asset.UpdatedAt,
	})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrProjectRevisionConflict
	}
	return nil
}

func requireProjectAssetVersionTx(tx *gorm.DB, projectID, versionID string) error {
	var version model.AssetVersion
	return tx.Table("asset_versions").Select("asset_versions.id").
		Joins("JOIN project_asset_links ON project_asset_links.asset_id = asset_versions.asset_id").
		Where("project_asset_links.project_id = ? AND asset_versions.id = ?", projectID, versionID).
		First(&version).Error
}

func (r *Repository) ProjectAssetCandidates(projectID string) ([]model.ProjectAssetCandidate, error) {
	var candidates []model.ProjectAssetCandidate
	err := r.db.Where("project_id = ?", projectID).Order("created_at asc").Find(&candidates).Error
	return candidates, err
}

func (r *Repository) ProjectAssetCandidate(projectID string, candidateID string) (*model.ProjectAssetCandidate, error) {
	var candidate model.ProjectAssetCandidate
	if err := r.db.First(&candidate, "id = ? AND project_id = ?", candidateID, projectID).Error; err != nil {
		return nil, err
	}
	return &candidate, nil
}

func (r *Repository) CreateProjectAssetCandidates(candidates []model.ProjectAssetCandidate) error {
	if len(candidates) == 0 {
		return nil
	}
	return r.db.Create(&candidates).Error
}

func (r *Repository) CreateProjectAssetCandidate(candidate *model.ProjectAssetCandidate) (bool, error) {
	result := r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(candidate)
	return result.RowsAffected == 1, result.Error
}

// ConfirmProjectAssetCandidate 将正式资产身份、首版本、项目引用和候选状态放在同一事务中，避免出现半确认数据。
func (r *Repository) ConfirmProjectAssetCandidate(candidate *model.ProjectAssetCandidate, asset *model.Asset, version *model.AssetVersion, link *model.ProjectAssetLink, createAsset bool) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := requireUnarchivedProjectTx(tx, candidate.ProjectID); err != nil {
			return err
		}
		if createAsset {
			if err := tx.Create(asset).Error; err != nil {
				return err
			}
			if err := tx.Create(version).Error; err != nil {
				return err
			}
		} else if err := tx.First(&model.Asset{}, "id = ? AND user_id = ?", asset.ID, asset.UserID).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND asset_id = ?", link.ProjectID, link.AssetID).FirstOrCreate(link).Error; err != nil {
			return err
		}
		result := tx.Model(&model.ProjectAssetCandidate{}).
			Where("id = ? AND project_id = ? AND status = ?", candidate.ID, candidate.ProjectID, "pending_confirmation").
			Updates(map[string]any{"status": candidate.Status, "resolved_asset_id": candidate.ResolvedAssetID, "updated_at": candidate.UpdatedAt})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrInvalidData
		}
		return tx.Model(&model.Project{}).Where("id = ?", candidate.ProjectID).
			Updates(map[string]any{"revision": gorm.Expr("revision + 1"), "updated_at": candidate.UpdatedAt}).Error
	})
}
