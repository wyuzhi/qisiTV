package repository

import (
	"strings"
	"time"

	"qisitv/backend/internal/model"

	"gorm.io/gorm"
)

const taskSummarySelectColumns = "id, user_id, route_run, recovery_outcome, beef_usage_state, beef_billing_state, beef_reconcile_deadline, image_job_id, project_id, type, status, stage, progress, prompt, operation, provider, model, input_json, result_json, error, error_code, failure_diagnostics, provider_request_id, provider_cancel_status, provider_cancel_error, provider_cancel_attempts, provider_cancel_requested_at, provider_cancelled_at, provider_cancel_next_check_at, attempts, started_at, completed_at, created_at, updated_at"

func applyActiveCandidateTaskFilter(query *gorm.DB) *gorm.DB {
	return query.
		Where("status NOT IN ? OR recovery_outcome IS NULL OR recovery_outcome NOT IN ?", []model.TaskStatus{model.TaskStatusFailed, model.TaskStatusCancelled}, []string{"no_result", "unrecoverable"}).
		Where("status <> ? OR type NOT IN ?", model.TaskStatusSucceeded, []string{"text", "canvas_text"})
}

func (r *Repository) Tasks(userID string, limit int, projectID string, activeOnly bool) ([]model.Task, error) {
	var tasks []model.Task
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	query := r.db.Select(taskSummarySelectColumns).
		Where("user_id = ?", userID)
	if strings.TrimSpace(projectID) != "" {
		query = query.Where("project_id = ?", strings.TrimSpace(projectID))
	}
	if activeOnly {
		query = applyActiveCandidateTaskFilter(query)
	}
	err := query.Order("created_at desc, id desc").Limit(limit).Find(&tasks).Error
	return tasks, err
}

func (r *Repository) ActiveCandidateTasksAfter(userID string, projectID string, beforeCreatedAt *time.Time, beforeID string, limit int) ([]model.Task, error) {
	var tasks []model.Task
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	query := applyActiveCandidateTaskFilter(r.db.Select(taskSummarySelectColumns).Where("user_id = ?", userID))
	if strings.TrimSpace(projectID) != "" {
		query = query.Where("project_id = ?", strings.TrimSpace(projectID))
	}
	if beforeCreatedAt != nil {
		query = query.Where("created_at < ? OR (created_at = ? AND id < ?)", *beforeCreatedAt, *beforeCreatedAt, beforeID)
	}
	err := query.Order("created_at desc, id desc").Limit(limit).Find(&tasks).Error
	return tasks, err
}

func (r *Repository) LatestProviderRequestIDsForTasks(taskIDs []string) (map[string]string, error) {
	result := make(map[string]string, len(taskIDs))
	if len(taskIDs) == 0 {
		return result, nil
	}
	var logs []model.ApiCallLog
	err := r.db.Select("task_id", "provider_request_id", "created_at").
		Where("task_id IN ? AND provider_request_id <> '' AND (status <> ? OR (request_kind IS NOT NULL AND request_kind <> '' AND request_kind <> 'create'))", taskIDs, model.ApiCallStatusFailed).
		Order("created_at desc").
		Find(&logs).Error
	if err != nil {
		return nil, err
	}
	for _, row := range logs {
		if _, exists := result[row.TaskID]; exists {
			continue
		}
		if trimmed := strings.TrimSpace(row.ProviderRequestID); trimmed != "" {
			result[row.TaskID] = trimmed
		}
	}
	return result, nil
}

// SuccessfulWorkflowTasksForProject 返回需要补偿工作流产物的成功任务。
// 不设分页，供项目详情读取时修复浏览器中断造成的历史断点。
func (r *Repository) SuccessfulWorkflowTasksForProject(userID string, projectID string) ([]model.Task, error) {
	var tasks []model.Task
	err := r.db.Where("user_id = ? AND project_id = ? AND status = ?", userID, projectID, model.TaskStatusSucceeded).
		Order("completed_at asc, created_at asc").Find(&tasks).Error
	return tasks, err
}

func (r *Repository) TaskLogs(userID string, taskID string) ([]model.TaskLog, error) {
	var logs []model.TaskLog
	err := r.db.Order("created_at asc").Find(&logs, "user_id = ? AND task_id = ?", userID, taskID).Error
	return logs, err
}
