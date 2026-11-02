package repository

import (
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"qisitv/backend/internal/model"
	"time"
)

func (r *Repository) ImageSubmission(attemptID, taskID, userID string) (*model.ImageSubmission, error) {
	var row model.ImageSubmission
	err := r.db.Where("attempt_id = ? AND task_id = ? AND user_id = ?", attemptID, taskID, userID).First(&row).Error
	return &row, err
}

func (r *Repository) CreateImageSubmission(row *model.ImageSubmission) error {
	return r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(row).Error
}

func (r *Repository) ExpiredImageSubmissionRequests() ([]model.ImageSubmission, error) {
	var rows []model.ImageSubmission
	err := r.db.Select("attempt_id", "task_id", "user_id", "query_cipher", "created_at").Where("created_at < ? AND request_cipher <> ?", time.Now().Add(-24*time.Hour), "").Limit(100).Find(&rows).Error
	return rows, err
}

// The app extracts the small encrypted query identity before removing a large
// frozen request. This update never changes the original send fence.
func (r *Repository) ExpireImageSubmissionRequest(row model.ImageSubmission, queryCipher string) error {
	return r.db.Model(&model.ImageSubmission{}).Where("attempt_id = ? AND task_id = ? AND user_id = ?", row.AttemptID, row.TaskID, row.UserID).
		Updates(map[string]any{"request_cipher": "", "query_cipher": queryCipher}).Error
}

func (r *Repository) SaveImageQueryCipher(row model.ImageSubmission, cipher string) error {
	return r.db.Model(&model.ImageSubmission{}).Where("attempt_id = ? AND task_id = ? AND user_id = ? AND (query_cipher IS NULL OR query_cipher = '')", row.AttemptID, row.TaskID, row.UserID).
		Update("query_cipher", cipher).Error
}

func (r *Repository) CreateImageRetry(attempt *model.RouteAttempt, row *model.ImageSubmission) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(attempt).Error; err != nil {
			return err
		}
		return tx.Create(row).Error
	})
}

func (r *Repository) MarkImageSubmissionAccepted(row *model.ImageSubmission) error {
	result := r.db.Model(&model.ImageSubmission{}).Where("attempt_id = ? AND task_id = ? AND user_id = ?", row.AttemptID, row.TaskID, row.UserID).Update("response_accepted", true)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskStateConflict
	}
	row.ResponseAccepted = true
	return nil
}

func (r *Repository) ClaimImageSubmissionSend(row *model.ImageSubmission, owner string, maxSends int) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := imageSubmissionTaskWriter(tx, row, owner, maxSends).Count(&count).Error; err != nil {
			return err
		}
		if count != 1 {
			return ErrTaskStateConflict
		}
		query := tx.Model(&model.ImageSubmission{}).Where("attempt_id = ? AND task_id = ? AND user_id = ? AND send_count = ?", row.AttemptID, row.TaskID, row.UserID, row.SendCount)
		if maxSends > 0 {
			query = query.Where("send_count < ? OR response_accepted = ?", maxSends, true)
		}
		result := query.Update("send_count", gorm.Expr("send_count + 1"))
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrTaskStateConflict
		}
		row.SendCount++
		return nil
	})
}
