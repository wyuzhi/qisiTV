package repository

import (
	"strings"
	"time"

	"gorm.io/gorm"
	"qisitv/backend/internal/model"
)

// 读投影只取小字段；完整冻结请求由恢复路径按原任务、用户和 attempt 单独读取。
type ImageSubmissionEvidence struct {
	AttemptID        string
	TaskID           string
	UserID           string
	ResponseAccepted bool
}

type ImageRecoveryEvidence struct {
	Attempt    *model.RouteAttempt
	Submission *ImageSubmissionEvidence
	HasReceipt bool
}

// 固定次数批量读取，不为列表中的每个任务逐一查库。
func (r *Repository) ImageRecoveryEvidence(taskIDs []string) (map[string]ImageRecoveryEvidence, error) {
	facts := make(map[string]ImageRecoveryEvidence, len(taskIDs))
	if len(taskIDs) == 0 {
		return facts, nil
	}
	var attempts []model.RouteAttempt
	if err := r.db.Select("id", "task_id", "route_run", "channel_id", "dispatch_state", "started_at").Where("task_id IN ?", taskIDs).
		Where(`id = (SELECT ra.id FROM route_attempts ra WHERE ra.task_id = route_attempts.task_id ORDER BY ra.route_run DESC, ra.attempt_number DESC, ra.id ASC LIMIT 1)`).Find(&attempts).Error; err != nil {
		return nil, err
	}
	attemptIDs := make([]string, 0, len(attempts))
	for i := range attempts {
		a := &attempts[i]
		facts[a.TaskID] = ImageRecoveryEvidence{Attempt: a}
		attemptIDs = append(attemptIDs, a.ID)
	}
	if len(attemptIDs) > 0 {
		var submissions []ImageSubmissionEvidence
		if err := r.db.Model(&model.ImageSubmission{}).Select("attempt_id", "task_id", "user_id", "response_accepted").
			Where("attempt_id IN ? AND task_id IN ?", attemptIDs, taskIDs).Find(&submissions).Error; err != nil {
			return nil, err
		}
		for i := range submissions {
			row := &submissions[i]
			f := facts[row.TaskID]
			if f.Attempt != nil && f.Attempt.ID == row.AttemptID {
				f.Submission = row
				facts[row.TaskID] = f
			}
		}
	}
	var receipts []struct{ TaskID string }
	if err := r.db.Model(&model.ApiCallLog{}).Select("api_call_logs.task_id").
		Joins("JOIN tasks ON tasks.id = api_call_logs.task_id AND tasks.user_id = api_call_logs.user_id").
		Where("tasks.id IN ? AND capability = ? AND request_kind = ? AND method = ?", taskIDs, "image", "create", "POST").Group("api_call_logs.task_id").Scan(&receipts).Error; err != nil {
		return nil, err
	}
	for _, row := range receipts {
		f := facts[row.TaskID]
		f.HasReceipt = true
		facts[row.TaskID] = f
	}
	return facts, nil
}

func (r *Repository) FailedImagesForRecovery(afterID string, limit int) ([]model.Task, error) {
	var tasks []model.Task
	// The credential field only broadens the old-conclusion candidate scan.
	// The service verifies the exact managed identity before any API query.
	err := r.db.Where("tasks.id > ? AND tasks.type = ? AND tasks.status = ?", afterID, "canvas_image", model.TaskStatusFailed).
		Where("NOT "+upscaleTaskPredicate).
		Where(`((recovery_outcome IS NULL OR recovery_outcome = '') OR LOWER(TRIM(beef_usage_state)) IN ? OR LOWER(TRIM(beef_billing_state)) IN ? OR (recovery_outcome = 'unrecoverable' AND (input_json LIKE '%"credentialRef"%' OR EXISTS (SELECT 1 FROM route_attempts a WHERE a.task_id = tasks.id AND a.route_run = tasks.route_run AND a.channel_id = 'beefapi') OR EXISTS (SELECT 1 FROM image_submissions s WHERE s.task_id = tasks.id AND s.query_cipher <> '')))) AND (next_poll_at IS NULL OR next_poll_at <= ?)`, model.PendingMediaUsageStates(), model.PendingMediaBillingStates(), time.Now()).
		Where(`image_job_id <> '' OR stage = 'submission_unknown' OR EXISTS (SELECT 1 FROM api_call_logs l WHERE l.task_id = tasks.id AND l.user_id = tasks.user_id AND l.capability = 'image' AND l.request_kind = 'create' AND l.method = 'POST') OR (SELECT a.dispatch_state FROM route_attempts a WHERE a.task_id = tasks.id AND a.route_run = tasks.route_run ORDER BY a.attempt_number DESC, a.id ASC LIMIT 1) IN ('accepted', 'submission_unknown')`).
		Order("tasks.id ASC").Limit(limit).Find(&tasks).Error
	return tasks, err
}

// 不改变 status/route_run；后台恢复不是重新排队，也不会进入创建任务执行器。
func (r *Repository) FinishFailedImageRecovery(task model.Task, outcome *string, nextPollAt *time.Time) error {
	updates := map[string]any{
		"recovery_outcome": outcome,
		"next_poll_at":     nextPollAt,
		"updated_at":       time.Now(),
	}
	if strings.TrimSpace(task.ImageJobID) != "" {
		updates["image_job_id"] = strings.TrimSpace(task.ImageJobID)
	}
	if task.BeefBillingState != nil {
		updates["beef_billing_state"] = *task.BeefBillingState
	}
	if task.BeefReconcileDeadline != nil {
		updates["beef_reconcile_deadline"] = *task.BeefReconcileDeadline
	} else if task.BeefBillingState != nil && strings.TrimSpace(*task.BeefBillingState) != "" {
		updates["beef_reconcile_deadline"] = nil
	}
	result := taskLeaseWriter(r.db.Model(&model.Task{}), task.LeaseOwner).
		Where("id = ? AND user_id = ? AND status = ? AND route_run = ?", task.ID, task.UserID, model.TaskStatusFailed, task.RouteRun).
		Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskStateConflict
	}
	return nil
}

func (r *Repository) UpdateTaskImageJobID(taskID string, jobID string) error {
	taskID = strings.TrimSpace(taskID)
	jobID = strings.TrimSpace(jobID)
	if taskID == "" || jobID == "" {
		return nil
	}
	return r.db.Model(&model.Task{}).Where("id = ?", taskID).Updates(map[string]any{
		"image_job_id": jobID,
		"updated_at":   time.Now(),
	}).Error
}

func (r *Repository) UpdateTaskBeefImageSettlement(taskID string, billingState *string, reconcileDeadline *string) error {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" || (billingState == nil && reconcileDeadline == nil) {
		return nil
	}
	updates := map[string]any{"updated_at": time.Now()}
	if billingState != nil {
		normalized := strings.ToLower(strings.TrimSpace(*billingState))
		updates["beef_billing_state"] = normalized
		if normalized != "" && reconcileDeadline == nil {
			updates["beef_reconcile_deadline"] = nil
		}
	}
	if reconcileDeadline != nil {
		trimmed := strings.TrimSpace(*reconcileDeadline)
		if trimmed == "" {
			updates["beef_reconcile_deadline"] = nil
		} else {
			updates["beef_reconcile_deadline"] = trimmed
		}
	}
	return r.db.Model(&model.Task{}).Where("id = ?", taskID).Updates(updates).Error
}

// 仅持有失败任务恢复租约的同键重放可以跳过旧 worker 的 12 次限制。
func imageSubmissionTaskWriter(tx *gorm.DB, row *model.ImageSubmission, owner string, maxSends int) *gorm.DB {
	query := taskLeaseWriter(tx.Model(&model.Task{}), owner).Where("id = ? AND user_id = ?", row.TaskID, row.UserID)
	if maxSends > 0 {
		return query.Where("status = ?", model.TaskStatusRunning)
	}
	return query.Where("status = ? AND lease_owner LIKE ? AND (recovery_outcome IS NULL OR recovery_outcome = '')", model.TaskStatusFailed, "manual-recovery:%").
		Where("EXISTS (SELECT 1 FROM route_attempts a WHERE a.id = ? AND a.task_id = tasks.id AND a.route_run = tasks.route_run AND a.dispatch_state IN ?)", row.AttemptID, []string{"accepted", "submission_unknown"})
}
