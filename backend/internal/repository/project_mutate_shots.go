package repository

import (
	"slices"
	"sort"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func (r *Repository) SaveShotWithRevisionActive(userID string, shot *model.Shot, revision *model.ShotRevision, create bool, expectedCurrentRevisionID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, shot.ProjectID); err != nil {
			return err
		}
		if strings.TrimSpace(shot.UnitID) != "" {
			if err := requireProjectUnitTx(tx, shot.ProjectID, shot.UnitID); err != nil {
				return err
			}
		}
		if create {
			if err := tx.Create(shot).Error; err != nil {
				return err
			}
		} else {
			query := whereExpectedPointer(tx.Model(&model.Shot{}).Where("id = ? AND project_id = ?", shot.ID, shot.ProjectID), "current_revision_id", expectedCurrentRevisionID)
			result := query.Updates(map[string]any{
				"unit_id": shot.UnitID, "title": shot.Title, "description": shot.Description, "position": shot.Position,
				"duration_ms": shot.DurationMs, "status": shot.Status, "updated_at": shot.UpdatedAt,
			})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return ErrProjectRevisionConflict
			}
		}
		var currentVersion int
		if err := tx.Model(&model.ShotRevision{}).Where("shot_id = ?", shot.ID).Select("COALESCE(MAX(version), 0)").Scan(&currentVersion).Error; err != nil {
			return err
		}
		revision.Version = currentVersion + 1
		if err := tx.Create(revision).Error; err != nil {
			return err
		}
		shot.CurrentRevisionID = revision.ID
		if err := tx.Model(&model.Shot{}).Where("id = ? AND project_id = ?", shot.ID, shot.ProjectID).Updates(map[string]any{
			"current_revision_id": revision.ID, "description": shot.Description, "duration_ms": shot.DurationMs,
			"status": shot.Status, "updated_at": shot.UpdatedAt,
		}).Error; err != nil {
			return err
		}
		if !create {
			if err := tx.Model(&model.ShotArtifact{}).Where("shot_id = ? AND status NOT IN ?", shot.ID, []string{"failed", "stale"}).Updates(map[string]any{"status": "stale", "selected": false, "updated_at": shot.UpdatedAt}).Error; err != nil {
				return err
			}
		}
		if err := invalidateUnitWorkflowTx(tx, shot.ProjectID, shot.UnitID, "storyboard", shot.UpdatedAt); err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, shot.ProjectID, shot.UpdatedAt)
	})
}

func (r *Repository) ReplaceProjectUnitShotsActive(userID, projectID, unitID string, shots []model.Shot, revisions []model.ShotRevision, references []model.ShotAssetReference, expectedShotIDs []string, expectedShotPointers map[string]string, expectedRevision int64) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		return replaceProjectUnitShotsTx(tx, userID, projectID, unitID, shots, revisions, references, expectedShotIDs, expectedShotPointers, expectedRevision)
	})
}

func replaceProjectUnitShotsTx(tx *gorm.DB, userID, projectID, unitID string, shots []model.Shot, revisions []model.ShotRevision, references []model.ShotAssetReference, expectedShotIDs []string, expectedShotPointers map[string]string, expectedRevision int64) error {
	if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
		return err
	}
	if err := requireProjectUnitTx(tx, projectID, unitID); err != nil {
		return err
	}
	seenVersions := make(map[string]struct{}, len(references))
	for _, reference := range references {
		versionID := strings.TrimSpace(reference.AssetVersionID)
		if versionID == "" {
			continue
		}
		if _, seen := seenVersions[versionID]; seen {
			continue
		}
		seenVersions[versionID] = struct{}{}
		if err := requireProjectAssetVersionTx(tx, projectID, versionID); err != nil {
			return err
		}
	}
	if err := assertShotExpectationsTx(tx, projectID, unitID, expectedShotIDs, expectedShotPointers); err != nil {
		return err
	}
	shotIDs := tx.Model(&model.Shot{}).Select("id").Where("project_id = ? AND unit_id = ?", projectID, unitID)
	if err := tx.Where("project_id = ? AND unit_id = ?", projectID, unitID).Delete(&model.ShotArtifact{}).Error; err != nil {
		return err
	}
	if err := tx.Where("shot_id IN (?)", shotIDs).Delete(&model.ShotRevision{}).Error; err != nil {
		return err
	}
	if err := tx.Where("shot_id IN (?)", shotIDs).Delete(&model.ShotAssetReference{}).Error; err != nil {
		return err
	}
	if err := tx.Where("project_id = ? AND shot_id IN (?)", projectID, shotIDs).Delete(&model.ProjectAssetCandidate{}).Error; err != nil {
		return err
	}
	if err := tx.Where("project_id = ? AND unit_id = ?", projectID, unitID).Delete(&model.Shot{}).Error; err != nil {
		return err
	}
	if err := tx.Create(&shots).Error; err != nil {
		return err
	}
	if len(revisions) > 0 {
		if err := tx.Create(&revisions).Error; err != nil {
			return err
		}
	}
	if len(references) > 0 {
		if err := tx.Create(&references).Error; err != nil {
			return err
		}
	}
	now := time.Now()
	if err := invalidateUnitWorkflowTx(tx, projectID, unitID, "storyboard", now); err != nil {
		return err
	}
	if expectedRevision <= 0 {
		return ErrExpectedRevisionRequired
	}
	return bumpProjectRevisionCASTx(tx, projectID, expectedRevision, now)
}

func (r *Repository) DeleteProjectShotActive(userID, projectID, shotID string, updatedAt time.Time) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		var shot model.Shot
		if err := tx.First(&shot, "id = ? AND project_id = ?", shotID, projectID).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND shot_id = ?", projectID, shotID).Delete(&model.ProductionTaskLink{}).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND shot_id = ?", projectID, shotID).Delete(&model.ShotArtifact{}).Error; err != nil {
			return err
		}
		if err := tx.Where("shot_id = ?", shotID).Delete(&model.ShotRevision{}).Error; err != nil {
			return err
		}
		if err := tx.Where("shot_id = ?", shotID).Delete(&model.ShotAssetReference{}).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND shot_id = ?", projectID, shotID).Delete(&model.ProjectAssetCandidate{}).Error; err != nil {
			return err
		}
		result := tx.Where("id = ? AND project_id = ?", shotID, projectID).Delete(&model.Shot{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		var remaining []model.Shot
		if err := tx.Select("id", "position").Where("project_id = ? AND unit_id = ?", projectID, shot.UnitID).Order("position asc, created_at asc, id asc").Find(&remaining).Error; err != nil {
			return err
		}
		for position, item := range remaining {
			if item.Position == position {
				continue
			}
			if err := tx.Model(&model.Shot{}).Where("id = ? AND project_id = ?", item.ID, projectID).Update("position", position).Error; err != nil {
				return err
			}
		}
		if err := invalidateUnitWorkflowTx(tx, projectID, shot.UnitID, "storyboard", updatedAt); err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, projectID, updatedAt)
	})
}

func (r *Repository) UpsertShotAssetReferenceActive(userID, projectID string, reference *model.ShotAssetReference, updatedAt time.Time) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		if err := tx.First(&model.Shot{}, "id = ? AND project_id = ?", reference.ShotID, projectID).Error; err != nil {
			return err
		}
		if err := requireProjectAssetVersionTx(tx, projectID, reference.AssetVersionID); err != nil {
			return err
		}
		result := tx.Model(&model.ShotAssetReference{}).Where("shot_id = ? AND asset_version_id = ? AND role = ?", reference.ShotID, reference.AssetVersionID, reference.Role).Updates(map[string]any{"status": reference.Status})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			if err := tx.Create(reference).Error; err != nil {
				return err
			}
		} else {
			var existing model.ShotAssetReference
			if err := tx.First(&existing, "shot_id = ? AND asset_version_id = ? AND role = ?", reference.ShotID, reference.AssetVersionID, reference.Role).Error; err != nil {
				return err
			}
			reference.ID = existing.ID
			reference.CreatedAt = existing.CreatedAt
		}
		if err := tx.Model(&model.ShotArtifact{}).Where("shot_id = ? AND status NOT IN ?", reference.ShotID, []string{"failed", "stale"}).Updates(map[string]any{"status": "stale", "selected": false, "updated_at": updatedAt}).Error; err != nil {
			return err
		}
		var shot model.Shot
		if err := tx.First(&shot, "id = ? AND project_id = ?", reference.ShotID, projectID).Error; err != nil {
			return err
		}
		if err := invalidateUnitWorkflowTx(tx, projectID, shot.UnitID, "storyboard", updatedAt); err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, projectID, updatedAt)
	})
}

func (r *Repository) DeleteShotAssetReferenceActive(userID, projectID, shotID, referenceID string, updatedAt time.Time) (bool, error) {
	deleted := false
	err := r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := requireActiveProjectTx(tx, userID, projectID); err != nil {
			return err
		}
		result := tx.Where("id = ? AND shot_id = ?", referenceID, shotID).Delete(&model.ShotAssetReference{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		deleted = true
		if err := tx.Model(&model.ShotArtifact{}).Where("shot_id = ? AND status NOT IN ?", shotID, []string{"failed", "stale"}).Updates(map[string]any{"status": "stale", "selected": false, "updated_at": updatedAt}).Error; err != nil {
			return err
		}
		var shot model.Shot
		if err := tx.First(&shot, "id = ? AND project_id = ?", shotID, projectID).Error; err != nil {
			return err
		}
		if err := invalidateUnitWorkflowTx(tx, projectID, shot.UnitID, "storyboard", updatedAt); err != nil {
			return err
		}
		return bumpProjectRevisionTx(tx, projectID, updatedAt)
	})
	return deleted, err
}

func requireProjectUnitTx(tx *gorm.DB, projectID, unitID string) error {
	return tx.First(&model.ProjectUnit{}, "id = ? AND project_id = ?", unitID, projectID).Error
}

func assertShotExpectationsTx(tx *gorm.DB, projectID, unitID string, expectedShotIDs []string, expectedShotPointers map[string]string) error {
	var current []model.Shot
	if err := tx.Select("id", "current_revision_id").Where("project_id = ? AND unit_id = ?", projectID, unitID).Find(&current).Error; err != nil {
		return err
	}
	if expectedShotIDs != nil {
		currentIDs := make([]string, 0, len(current))
		for _, shot := range current {
			currentIDs = append(currentIDs, shot.ID)
		}
		sort.Strings(currentIDs)
		expected := append([]string(nil), expectedShotIDs...)
		sort.Strings(expected)
		if !slices.Equal(currentIDs, expected) {
			return ErrProjectUnitShotsChanged
		}
	}
	if expectedShotPointers != nil {
		if len(current) != len(expectedShotPointers) {
			return ErrProjectUnitShotsChanged
		}
		for _, shot := range current {
			expected, ok := expectedShotPointers[shot.ID]
			if !ok || expected != shot.CurrentRevisionID {
				return ErrProjectUnitShotsChanged
			}
		}
	}
	return nil
}

func whereExpectedPointer(tx *gorm.DB, column, expected string) *gorm.DB {
	if strings.TrimSpace(expected) == "" {
		return tx.Where("("+column+" IS NULL OR "+column+" = ?)", "")
	}
	return tx.Where(column+" = ?", expected)
}
