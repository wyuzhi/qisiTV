package repository

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func (r *Repository) ReleaseTaskLease(id string, owner string) error {
	return r.db.Model(&model.Task{}).
		Where("id = ? AND status = ? AND lease_owner = ?", id, model.TaskStatusRunning, owner).
		Updates(map[string]any{"lease_owner": "", "lease_expires_at": nil, "updated_at": time.Now()}).Error
}

func (r *Repository) AllTasks() ([]model.Task, error) {
	var tasks []model.Task
	return tasks, r.db.Find(&tasks).Error
}

func (r *Repository) CleanupDuplicateTaskPayloads() error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.TaskLog{}).Where("length(payload) > ?", 4000).Update("payload", "").Error; err != nil {
			return err
		}
		return nil
	})
}

func (r *Repository) Task(id string) (*model.Task, error) {
	var task model.Task
	if err := r.db.First(&task, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &task, nil
}

func (r *Repository) TaskForUser(userID string, id string) (*model.Task, error) {
	var task model.Task
	if err := r.db.First(&task, "id = ? AND user_id = ?", id, userID).Error; err != nil {
		return nil, err
	}
	return &task, nil
}

func (r *Repository) ActiveTaskCountForUser(userID string) (int64, error) {
	var count int64
	err := r.db.Model(&model.Task{}).Where("user_id = ? AND status IN ?", userID, []model.TaskStatus{model.TaskStatusQueued, model.TaskStatusRunning}).Count(&count).Error
	return count, err
}

func (r *Repository) ActiveTaskCountForProjectIDs(userID string, projectIDs []string) (int64, error) {
	if len(projectIDs) == 0 {
		return 0, nil
	}
	var count int64
	err := r.db.Model(&model.Task{}).
		Where("user_id = ? AND project_id IN ? AND status IN ?", userID, projectIDs, []model.TaskStatus{model.TaskStatusQueued, model.TaskStatusRunning}).
		Count(&count).Error
	return count, err
}

// 任务领取以数据库租约为真相；PostgreSQL 锁行跳过竞争任务，SQLite 继续依赖条件更新保证单实例原子性。
func (r *Repository) ClaimNextTask(owner string, leaseDuration time.Duration) (*model.Task, error) {
	var task model.Task
	now := time.Now()
	leaseExpiresAt := now.Add(leaseDuration)
	err := r.db.Transaction(func(tx *gorm.DB) error {
		query := tx.Where("(status = ? OR (status = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?))) AND (next_poll_at IS NULL OR next_poll_at <= ?)", model.TaskStatusQueued, model.TaskStatusRunning, now, now).
			Order("created_at asc").Limit(1)
		result := query.Find(&task)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			task = model.Task{}
			return nil
		}
		claim := tx.Model(&model.Task{}).Where("id = ?", task.ID).
			Where("(status = ? OR (status = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?))) AND (next_poll_at IS NULL OR next_poll_at <= ?)", model.TaskStatusQueued, model.TaskStatusRunning, now, now)
		updated := claim.
			Updates(map[string]any{
				"status":           model.TaskStatusRunning,
				"stage":            "后端接管任务",
				"progress":         15,
				"attempts":         gorm.Expr("attempts + ?", 1),
				"started_at":       gorm.Expr("COALESCE(started_at, ?)", now),
				"lease_owner":      owner,
				"lease_expires_at": leaseExpiresAt,
				"next_poll_at":     nil,
				"updated_at":       now,
			})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected == 0 {
			task = model.Task{}
			return nil
		}
		return tx.First(&task, "id = ?", task.ID).Error
	})
	if err != nil || task.ID == "" {
		return nil, err
	}
	return &task, nil
}

func (r *Repository) RenewTaskLease(id string, owner string, leaseDuration time.Duration) error {
	result := r.db.Model(&model.Task{}).
		Where("id = ? AND status = ? AND lease_owner = ? AND lease_expires_at > ?", id, model.TaskStatusRunning, owner, time.Now()).
		Updates(map[string]any{"lease_expires_at": time.Now().Add(leaseDuration), "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return errors.New("任务租约已失效")
	}
	return nil
}

func (r *Repository) UpdateTaskProviderState(id string, providerRequestID string, pollStage string, nextPollAt *time.Time) error {
	updates := map[string]any{"poll_stage": pollStage, "next_poll_at": nextPollAt, "updated_at": time.Now()}
	if strings.TrimSpace(providerRequestID) != "" {
		updates["provider_request_id"] = strings.TrimSpace(providerRequestID)
	}
	return r.db.Model(&model.Task{}).Where("id = ?", id).Updates(updates).Error
}

func (r *Repository) DeferRunningTaskForProviderPoll(id string, owner string, stage string, delay time.Duration, diagnostics ...*model.TaskFailureDiagnostics) error {
	now := time.Now()
	updates := map[string]any{"stage": stage, "error": "", "completed_at": nil, "next_poll_at": now.Add(delay), "lease_owner": "", "lease_expires_at": nil, "updated_at": now}
	if len(diagnostics) > 0 && diagnostics[0] != nil {
		data, err := json.Marshal(diagnostics[0])
		if err != nil {
			return err
		}
		updates["failure_diagnostics"] = string(data)
	}
	result := taskLeaseWriter(r.db.Model(&model.Task{}), owner).
		Where("id = ? AND status = ?", id, model.TaskStatusRunning).
		Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskStateConflict
	}
	return nil
}

// 人工恢复仅锁定失败任务；旧 worker 的租约可覆盖，但未过期的人工恢复租约不能并发抢占。
func (r *Repository) ClaimFailedTaskProviderRecovery(id string, userID string, owner string, leaseDuration time.Duration) error {
	now := time.Now()
	query := r.db.Model(&model.Task{}).Where(
		"id = ? AND status = ? AND (lease_owner = '' OR lease_owner NOT LIKE ? OR lease_expires_at IS NULL OR lease_expires_at <= ?)",
		id, model.TaskStatusFailed, "manual-recovery:%", now,
	)
	if strings.TrimSpace(userID) != "" {
		query = query.Where("user_id = ?", userID)
	}
	result := query.Updates(map[string]any{
		"lease_owner":      owner,
		"lease_expires_at": now.Add(leaseDuration),
		"updated_at":       now,
	})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskProviderRecoveryConflict
	}
	return nil
}

func (r *Repository) ReleaseTaskProviderRecovery(id string, owner string) error {
	return r.db.Model(&model.Task{}).
		Where("id = ? AND lease_owner = ?", id, owner).
		Updates(map[string]any{"lease_owner": "", "lease_expires_at": nil, "updated_at": time.Now()}).Error
}

func (r *Repository) UpdateTaskProgress(id string, stage string, progress int) error {
	return r.db.Model(&model.Task{}).Where("id = ? AND status = ?", id, model.TaskStatusRunning).Updates(map[string]any{
		"stage": stage, "progress": progress, "updated_at": time.Now(),
	}).Error
}

func (r *Repository) UpdateTaskProgressForLease(id string, owner string, stage string, progress int) error {
	result := taskLeaseWriter(r.db.Model(&model.Task{}), owner).
		Where("id = ? AND status = ?", id, model.TaskStatusRunning).
		Updates(map[string]any{"stage": stage, "progress": progress, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskStateConflict
	}
	return nil
}

// UpdateTaskStageForLease preserves the last provider-reported percentage.
func (r *Repository) UpdateTaskStageForLease(id string, owner string, stage string) error {
	result := taskLeaseWriter(r.db.Model(&model.Task{}), owner).
		Where("id = ? AND status = ?", id, model.TaskStatusRunning).
		Updates(map[string]any{"stage": stage, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskStateConflict
	}
	return nil
}

// 无租约任务仅能写无租约记录；有租约的执行者必须仍持有本次领取的有效 owner。
func taskLeaseWriter(db *gorm.DB, owner string) *gorm.DB {
	if owner == "" {
		return db.Where("(lease_owner = '' OR lease_owner IS NULL)")
	}
	return db.Where("lease_owner = ? AND lease_expires_at > ?", owner, time.Now())
}

// UpdateTaskProviderProgress records upstream-reported progress without allowing
// a delayed or out-of-order poll response to move the public percentage backwards.
func (r *Repository) UpdateTaskProviderProgress(id string, progress int) error {
	progress = max(0, min(100, progress))
	return r.db.Model(&model.Task{}).Where("id = ? AND status = ?", id, model.TaskStatusRunning).Updates(map[string]any{
		"stage":      "上游生成中",
		"progress":   gorm.Expr("CASE WHEN progress < ? THEN ? ELSE progress END", progress, progress),
		"updated_at": time.Now(),
	}).Error
}

func (r *Repository) SaveTaskCompletion(task *model.Task, expected model.TaskStatus, results []model.Result) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		updated := taskLeaseWriter(tx.Model(&model.Task{}), task.LeaseOwner).
			Where("id = ? AND status = ?", task.ID, expected).
			// Completion owns the result, not the worker's routing, lease or
			// cancellation snapshot, which may have changed during execution.
			Select("status", "stage", "progress", "result_json", "input_json", "workflow_source_cipher", "text_draft", "error", "error_code", "failure_diagnostics", "recovery_outcome", "next_poll_at", "completed_at", "updated_at").Updates(task)
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return ErrTaskStateConflict
		}
		for index := range results {
			if err := tx.Create(&results[index]).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *Repository) UpdateTaskTerminalState(id string, owner string, expected model.TaskStatus, status model.TaskStatus, stage string, errorText string, errorCode string, completedAt time.Time, diagnostics ...*model.TaskFailureDiagnostics) (bool, error) {
	var diagnosticJSON any
	if len(diagnostics) > 0 && diagnostics[0] != nil {
		data, err := json.Marshal(diagnostics[0])
		if err != nil {
			return false, err
		}
		diagnosticJSON = string(data)
	}
	result := taskLeaseWriter(r.db.Model(&model.Task{}), owner).
		Where("id = ? AND status = ?", id, expected).
		Updates(map[string]any{
			"status": status, "stage": stage, "error": errorText, "error_code": errorCode, "completed_at": &completedAt,
			"failure_diagnostics": diagnosticJSON,
			"lease_owner":         "", "lease_expires_at": nil, "updated_at": completedAt,
		})
	return result.RowsAffected == 1, result.Error
}

func (r *Repository) CancelTaskIfStatus(userID string, id string, expected model.TaskStatus, now time.Time) (bool, error) {
	result := r.db.Model(&model.Task{}).
		Where("id = ? AND user_id = ? AND status = ?", id, userID, expected).
		Updates(map[string]any{
			"status": model.TaskStatusCancelled, "stage": "任务已取消", "error": "任务已取消", "completed_at": &now,
			"lease_owner": "", "lease_expires_at": nil, "updated_at": now,
		})
	return result.RowsAffected == 1, result.Error
}

// 上游取消先落库再发请求；条件更新保证并发和重复取消只有一个调用方取得发送权。
func (r *Repository) ClaimTaskProviderCancellation(userID string, id string, now time.Time) error {
	result := r.db.Model(&model.Task{}).
		Where("id = ? AND user_id = ? AND status = ? AND provider_cancel_status = ''", id, userID, model.TaskStatusCancelled).
		Updates(map[string]any{
			"provider_cancel_status":        model.ProviderCancelStatusRequested,
			"provider_cancel_attempts":      1,
			"provider_cancel_requested_at":  &now,
			"provider_cancel_next_check_at": now.Add(15 * time.Second),
			"provider_cancel_error":         "",
			"updated_at":                    now,
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskProviderCancellationConflict
	}
	return nil
}

func (r *Repository) UpdateTaskProviderCancellation(id string, expected model.ProviderCancelStatus, status model.ProviderCancelStatus, errorText string, nextCheckAt *time.Time, cancelledAt *time.Time) error {
	updates := map[string]any{
		"provider_cancel_status":        status,
		"provider_cancel_error":         errorText,
		"provider_cancel_next_check_at": nextCheckAt,
		"lease_owner":                   "",
		"lease_expires_at":              nil,
		"updated_at":                    time.Now(),
	}
	if cancelledAt != nil {
		updates["provider_cancelled_at"] = cancelledAt
	}
	result := r.db.Model(&model.Task{}).Where("id = ? AND status = ? AND provider_cancel_status = ?", id, model.TaskStatusCancelled, expected).Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskProviderCancellationConflict
	}
	return nil
}

// 对账任务同样使用数据库租约，多实例和服务重启后只会有一个 worker 查询同一上游任务。
func (r *Repository) ClaimNextTaskProviderCancellation(owner string, leaseDuration time.Duration) (*model.Task, error) {
	var task model.Task
	now := time.Now()
	err := r.db.Transaction(func(tx *gorm.DB) error {
		query := tx.Where(
			"status = ? AND provider_cancel_status = ? AND (provider_cancel_next_check_at IS NULL OR provider_cancel_next_check_at <= ?) AND (lease_expires_at IS NULL OR lease_expires_at <= ?)",
			model.TaskStatusCancelled, model.ProviderCancelStatusRequested, now, now,
		).Order("provider_cancel_requested_at asc").Limit(1)
		if result := query.Find(&task); result.Error != nil || result.RowsAffected == 0 {
			task = model.Task{}
			return result.Error
		}
		claim := tx.Model(&model.Task{}).Where(
			"id = ? AND status = ? AND provider_cancel_status = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)",
			task.ID, model.TaskStatusCancelled, model.ProviderCancelStatusRequested, now,
		).Updates(map[string]any{
			"lease_owner":              owner,
			"lease_expires_at":         now.Add(leaseDuration),
			"provider_cancel_attempts": gorm.Expr("provider_cancel_attempts + 1"),
			"updated_at":               now,
		})
		if claim.Error != nil || claim.RowsAffected == 0 {
			task = model.Task{}
			return claim.Error
		}
		return tx.First(&task, "id = ?", task.ID).Error
	})
	if err != nil || task.ID == "" {
		return nil, err
	}
	return &task, nil
}
