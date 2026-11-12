package repository

import (
	"qisitv/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const generationOutputResultKind = "generation_output"

type GenerationDeliveryItem struct {
	Result         model.Result
	Asset          *model.Asset
	Version        *model.AssetVersion
	Representation *model.AssetRepresentation
}

func (r *Repository) UpsertGenerationDelivery(items []GenerationDeliveryItem) error {
	if len(items) == 0 {
		return nil
	}
	return r.Transaction(func(tx *Repository) error {
		for _, item := range items {
			if err := tx.CommitOwnedGenerationDelivery(item); err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *Repository) CommitOwnedGenerationDelivery(item GenerationDeliveryItem) error {
	if item.Asset != nil {
		if err := insertOwnedAsset(r.db, item.Asset); err != nil {
			return err
		}
	}
	if item.Version != nil {
		if err := insertIgnoringConflict(r.db, item.Version); err != nil {
			return err
		}
	}
	if item.Representation != nil {
		if err := insertIgnoringConflict(r.db, item.Representation); err != nil {
			return err
		}
	}
	return upsertByID(r.db, &item.Result, []string{"user_id", "task_id", "kind", "url", "payload"})
}

func (r *Repository) GenerationOutputResults(taskID string) ([]model.Result, error) {
	var results []model.Result
	err := r.db.Where("task_id = ? AND kind = ?", taskID, generationOutputResultKind).Order("id asc").Find(&results).Error
	return results, err
}

func (r *Repository) GenerationOutputResultsForTasks(taskIDs []string) ([]model.Result, error) {
	if len(taskIDs) == 0 {
		return nil, nil
	}
	var results []model.Result
	err := r.db.Where("task_id IN ? AND kind = ?", taskIDs, generationOutputResultKind).Order("task_id asc, id asc").Find(&results).Error
	return results, err
}

// SucceededTasksForDelivery returns one id-keyset page of succeeded tasks with
// a result payload. Completeness is decided by the Deliverer, not this query.
func (r *Repository) SucceededTasksForDelivery(afterID string, limit int) ([]model.Task, error) {
	if limit <= 0 {
		limit = 64
	}
	query := r.db.Where("status = ? AND result_json <> ''", model.TaskStatusSucceeded)
	if afterID != "" {
		query = query.Where("id > ?", afterID)
	}
	var tasks []model.Task
	err := query.Order("id asc").Limit(limit).Find(&tasks).Error
	return tasks, err
}

// FailedCanvasGenerationTasks returns one id-keyset page of failed or cancelled
// canvas media generation tasks. Whether a node still shows them is decided by
// the canvas write, not this query.
func (r *Repository) FailedCanvasGenerationTasks(afterID string, limit int) ([]model.Task, error) {
	if limit <= 0 {
		limit = 64
	}
	query := r.db.Where("status IN ? AND type IN ? AND project_id <> ''",
		[]model.TaskStatus{model.TaskStatusFailed, model.TaskStatusCancelled},
		[]string{"canvas_image", "canvas_video", "canvas_audio"})
	if afterID != "" {
		query = query.Where("id > ?", afterID)
	}
	var tasks []model.Task
	err := query.Order("id asc").Limit(limit).Find(&tasks).Error
	return tasks, err
}

// UpdateCanvasBindRecovery stores or clears the background scanner's private
// canvas bind marker on a succeeded task. recovery_outcome also holds media
// recovery conclusions (no_result / unrecoverable), so this only replaces an
// empty value or an earlier canvas marker and never overwrites a conclusion.
// updated_at is left alone: the marker is scanner state, not a task change.
func (r *Repository) UpdateCanvasBindRecovery(userID, taskID string, marker *string) error {
	if r == nil || r.db == nil {
		return gorm.ErrInvalidDB
	}
	prefix := model.CanvasBindRecoveryPrefix
	return r.db.Model(&model.Task{}).
		Where("id = ? AND user_id = ? AND status = ?", taskID, userID, model.TaskStatusSucceeded).
		Where("recovery_outcome IS NULL OR recovery_outcome = '' OR substr(recovery_outcome, 1, ?) = ?", len(prefix), prefix).
		UpdateColumn("recovery_outcome", marker).Error
}

func insertOwnedAsset(tx *gorm.DB, asset *model.Asset) error {
	if err := tx.Create(asset).Error; err == nil {
		return nil
	} else if !isUniqueConstraint(err) {
		return err
	}
	var existing model.Asset
	if lookupErr := tx.First(&existing, "id = ?", asset.ID).Error; lookupErr != nil {
		return lookupErr
	}
	if existing.UserID != asset.UserID {
		return ErrAssetOwnedByAnotherUser
	}
	return nil
}

func insertIgnoringConflict(tx *gorm.DB, value any) error {
	err := tx.Create(value).Error
	if err == nil || isUniqueConstraint(err) {
		return nil
	}
	return err
}

func upsertByID(tx *gorm.DB, value any, assignments []string) error {
	return tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "id"}},
		DoUpdates: clause.AssignmentColumns(assignments),
	}).Create(value).Error
}
