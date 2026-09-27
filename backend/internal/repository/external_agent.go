package repository

import (
	"gorm.io/gorm"
	"qisitv/backend/internal/model"
)

// WithExternalAgentCanvasTransaction makes queue admission/writeback and its
// canvas projection one unit; the caller supplies domain validation.
func (r *Repository) WithExternalAgentCanvasTransaction(fn func(*Repository) error) error {
	return r.db.Transaction(func(tx *gorm.DB) error { return fn(New(tx)) })
}

func (r *Repository) PendingExternalAgentWritebacks(limit int, afterIDs ...string) ([]model.Task, error) {
	var tasks []model.Task
	query := r.db.Where("operation = ? AND status IN ? AND input_json LIKE ?", "external_agent_generate", []model.TaskStatus{model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled}, `%"externalAgentWriteback":"pending"%`)
	if len(afterIDs) > 0 && afterIDs[0] != "" {
		query = query.Where("id > ?", afterIDs[0])
	}
	err := query.Order("id asc").Limit(limit).Find(&tasks).Error
	return tasks, err
}

func (r *Repository) CompleteExternalAgentWriteback(task *model.Task, inputJSON string) error {
	result := r.db.Model(&model.Task{}).Where("id = ? AND user_id = ? AND status = ? AND input_json = ?", task.ID, task.UserID, task.Status, task.InputJSON).UpdateColumn("input_json", inputJSON)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskStateConflict
	}
	return nil
}
