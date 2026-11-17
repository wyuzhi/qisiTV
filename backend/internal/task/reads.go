package task

import (
	"strings"
	"time"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
)

func (s *Service) Get(userID, id string) (*model.Task, error) {
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	if s.deps.Present == nil {
		return nil, unavailable()
	}
	task, err := s.store.TaskForUser(userID, id)
	if err != nil {
		return nil, err
	}
	s.hydrateProviderRequestID(task)
	return presentTask(s.deps.Present, *task)
}

// FindOperation recovers an admission receipt without reconstructing its inputs.
func (s *Service) FindOperation(userID, projectID, operationID string) (*model.Task, error) {
	projectID = strings.TrimSpace(projectID)
	key, err := ClientOperationID(map[string]any{"metadata": map[string]any{"clientOperationId": operationID}})
	if err != nil {
		return nil, err
	}
	if projectID == "" || key == "" {
		return nil, kernel.BadAuthRequest("查询生成任务需要画布和提交标识")
	}
	if s.store == nil {
		return nil, unavailable()
	}
	task, err := s.store.TaskByClientOperation(userID, key)
	if err != nil {
		return nil, err
	}
	if task == nil || task.ProjectID != projectID {
		return nil, kernel.NotFound("尚未找到这次提交的任务")
	}
	s.hydrateProviderRequestID(task)
	return presentTask(s.deps.Present, *task)
}

func (s *Service) Logs(userID, id string) ([]model.TaskLog, error) {
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	if s.deps.Present == nil {
		return nil, unavailable()
	}
	logs, err := s.store.Logs(userID, id)
	if err != nil {
		return nil, err
	}
	return presentLogs(s.deps.Present, logs)
}

type activeCandidateStore interface {
	ListActiveCandidatesAfter(userID string, projectID string, beforeCreatedAt *time.Time, beforeID string, limit int) ([]model.Task, error)
}

type batchProviderRequestIDStore interface {
	LatestProviderRequestIDs(taskIDs []string) (map[string]string, error)
}

func needsOutcomeProviderRequestID(task model.Task) bool {
	if task.ProviderRequestID != "" {
		return false
	}
	if task.Status != model.TaskStatusFailed && task.Status != model.TaskStatusCancelled {
		return false
	}
	if task.RecoveryOutcome != nil && (*task.RecoveryOutcome == RecoveryNoResult || *task.RecoveryOutcome == RecoveryUnrecoverable) {
		return false
	}
	return true
}

func (s *Service) hydrateOutcomeProviderRequestIDs(tasks []model.Task) {
	if s == nil || s.store == nil || len(tasks) == 0 {
		return
	}
	missing := make([]string, 0)
	for i := range tasks {
		if needsOutcomeProviderRequestID(tasks[i]) {
			missing = append(missing, tasks[i].ID)
		}
	}
	if len(missing) == 0 {
		return
	}
	if batcher, ok := s.store.(batchProviderRequestIDStore); ok {
		if ids, err := batcher.LatestProviderRequestIDs(missing); err == nil {
			for i := range tasks {
				if needsOutcomeProviderRequestID(tasks[i]) {
					tasks[i].ProviderRequestID = ids[tasks[i].ID]
				}
			}
		}
		return
	}
	for i := range tasks {
		if needsOutcomeProviderRequestID(tasks[i]) {
			s.hydrateProviderRequestID(&tasks[i])
		}
	}
}

func isActiveTaskSummary(summary Summary) bool {
	if summary.Outcome != nil {
		switch strings.ToLower(strings.TrimSpace(summary.Outcome.Phase)) {
		case "running", "fetching", "retrievable":
			return true
		default:
			return false
		}
	}
	return summary.Status == model.TaskStatusQueued || summary.Status == model.TaskStatusRunning
}

func filterActiveTaskSummaries(summaries []Summary, limit int) []Summary {
	active := make([]Summary, 0, len(summaries))
	for _, summary := range summaries {
		if isActiveTaskSummary(summary) {
			active = append(active, summary)
			if limit > 0 && len(active) >= limit {
				break
			}
		}
	}
	return active
}

func (s *Service) list(userID string, options ListOptions) ([]Summary, error) {
	if s.store == nil {
		return nil, kernel.WrapAppError(kernel.CodeInternal, "任务服务不可用", errStoreRequired)
	}
	if s.deps.Present == nil {
		return nil, unavailable()
	}
	if !options.ActiveOnly {
		tasks, err := s.store.List(userID, options.Limit, options.ProjectID, false)
		if err != nil {
			return nil, err
		}
		s.hydrateOutcomeProviderRequestIDs(tasks)
		return presentSummaries(s.deps.Present, tasks)
	}
	want := options.Limit
	if want <= 0 || want > 100 {
		want = 50
	}
	if pager, ok := s.store.(activeCandidateStore); ok {
		const pageSize = 100
		collected := make([]Summary, 0, want)
		var beforeCreatedAt *time.Time
		var beforeID string
		for len(collected) < want {
			batch, err := pager.ListActiveCandidatesAfter(userID, options.ProjectID, beforeCreatedAt, beforeID, pageSize)
			if err != nil {
				return nil, err
			}
			if len(batch) == 0 {
				break
			}
			s.hydrateOutcomeProviderRequestIDs(batch)
			projected, err := presentSummaries(s.deps.Present, batch)
			if err != nil {
				return nil, err
			}
			for _, summary := range projected {
				if isActiveTaskSummary(summary) {
					collected = append(collected, summary)
					if len(collected) >= want {
						break
					}
				}
			}
			if len(batch) < pageSize {
				break
			}
			last := batch[len(batch)-1]
			cursorTime := last.CreatedAt
			beforeCreatedAt = &cursorTime
			beforeID = last.ID
		}
		return collected, nil
	}
	tasks, err := s.store.List(userID, want, options.ProjectID, true)
	if err != nil {
		return nil, err
	}
	s.hydrateOutcomeProviderRequestIDs(tasks)
	projected, err := presentSummaries(s.deps.Present, tasks)
	if err != nil {
		return nil, err
	}
	return filterActiveTaskSummaries(projected, want), nil
}
