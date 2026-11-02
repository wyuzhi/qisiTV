package resource

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/platform"
	"qisitv/backend/internal/repository"
	localtask "qisitv/backend/internal/task"
)

type AccountFileStorageUsage struct {
	UsedBytes  int64 `json:"usedBytes"`
	TotalBytes int64 `json:"totalBytes"`
}

func FileStorageUsage(repo *repository.Repository, policy platform.RuntimePolicySetting, userID string) (*AccountFileStorageUsage, error) {
	usedBytes, err := repo.UserStoredFileBytes(userID)
	if err != nil {
		return nil, err
	}
	return &AccountFileStorageUsage{
		UsedBytes:  usedBytes,
		TotalBytes: policy.Resource.StoredFileGB * 1024 * 1024 * 1024,
	}, nil
}

func structuredBytes(usage repository.UserStorageUsage) int64 {
	return usage.AssetBytes + usage.CanvasBytes
}

func ValidateStructuredStorageQuota(usage repository.UserStorageUsage, kind string, creating bool, deltaBytes int64, policy platform.RuntimeResourcePolicy) error {
	created := 0
	if creating {
		created = 1
	}
	return ValidateStructuredCountQuota(usage, kind, created, deltaBytes, policy)
}

func ValidateStructuredCountQuota(usage repository.UserStorageUsage, kind string, createdCount int, deltaBytes int64, policy platform.RuntimeResourcePolicy) error {
	if structuredBytes(usage)+deltaBytes > policy.StructuredDataMB*1024*1024 {
		return kernel.QuotaExceeded(fmt.Sprintf("账号画布和素材数据已达到 %dMB 上限，请先删除不需要的内容", policy.StructuredDataMB))
	}
	if createdCount <= 0 {
		return nil
	}
	switch kind {
	case "asset":
		if usage.AssetCount+int64(createdCount) > policy.AssetCount {
			return kernel.QuotaExceeded(fmt.Sprintf("账号素材数量已达到 %d 个上限", policy.AssetCount))
		}
	case "canvas":
		if usage.CanvasCount+int64(createdCount) > policy.CanvasCount {
			return kernel.QuotaExceeded(fmt.Sprintf("账号画布数量已达到 %d 个上限", policy.CanvasCount))
		}
	}
	return nil
}

func ValidateTaskStorageQuota(usage repository.UserStorageUsage, incomingBytes int64, policy platform.RuntimeResourcePolicy) error {
	if usage.TaskCount >= policy.TaskCount {
		return kernel.QuotaExceeded(fmt.Sprintf("账号任务历史已达到 %d 条上限，请联系管理员归档", policy.TaskCount))
	}
	return ValidateTaskDataGrowthQuota(usage, incomingBytes, policy)
}

func ValidateTaskDataGrowthQuota(usage repository.UserStorageUsage, incomingBytes int64, policy platform.RuntimeResourcePolicy) error {
	if usage.TaskBytes+incomingBytes > policy.TaskDataGB*1024*1024*1024 {
		return kernel.QuotaExceeded(fmt.Sprintf("账号任务历史数据已达到 %dGB 上限，请联系管理员归档", policy.TaskDataGB))
	}
	return nil
}

func ValidateAPICallLogQuota(usage repository.UserStorageUsage, incomingBytes int64, policy platform.RuntimeResourcePolicy) error {
	if usage.APICallCount >= policy.APICallLogCount {
		return kernel.QuotaExceeded(fmt.Sprintf("账号上游请求日志已达到 %d 条上限，请联系管理员归档", policy.APICallLogCount))
	}
	return ValidateTaskDataGrowthQuota(usage, incomingBytes, policy)
}

func ValidateStructuredReplacementQuota(usage repository.UserStorageUsage, kind string, count int, bytes int64, policy platform.RuntimeResourcePolicy) error {
	deltaBytes := bytes
	switch kind {
	case "asset":
		if int64(count) > policy.AssetCount {
			return kernel.QuotaExceeded(fmt.Sprintf("账号素材数量不能超过 %d 个", policy.AssetCount))
		}
		deltaBytes -= usage.AssetBytes
	case "canvas":
		if int64(count) > policy.CanvasCount {
			return kernel.QuotaExceeded(fmt.Sprintf("账号画布数量不能超过 %d 个", policy.CanvasCount))
		}
		deltaBytes -= usage.CanvasBytes
	}
	return ValidateStructuredStorageQuota(usage, kind, false, deltaBytes, policy)
}

func CreateTaskWithStorageQuota(repo *repository.Repository, task *model.Task, policy platform.RuntimePolicySetting) error {
	usage, err := repo.UserStorageUsage(task.UserID)
	if err != nil {
		return TaskStorageError(err)
	}
	incomingBytes := int64(len([]byte(task.Prompt)) + len([]byte(task.InputJSON)) + len([]byte(task.Error)))
	if err := ValidateTaskStorageQuota(usage, incomingBytes, policy.Resource); err != nil {
		return err
	}
	err = repo.CreateTaskWithActiveLimit(task, policy.Task.ActiveTaskLimit)
	if err == nil || errors.Is(err, repository.ErrActiveTaskLimit) || errors.Is(err, repository.ErrLogicalModelUnavailable) {
		return err
	}
	return TaskStorageError(err)
}

func TaskStorageError(cause error) error {
	if full := kernel.DiskFullError(cause); full != nil {
		return full
	}
	if mapped := localtask.AdmissionValidationError(cause); mapped != nil {
		return mapped
	}
	return &kernel.AppError{Status: 500, Code: 500, Reason: "local_storage_failed", Message: "本地任务保存失败，尚未提交生成。请重启 BeefTV 后重试；若仍失败，请更新应用并联系支持", Cause: cause}
}

func SaveTaskCompletionWithinStorageQuota(
	repo *repository.Repository,
	lock *sync.Mutex,
	policy platform.RuntimePolicySetting,
	task *model.Task,
	resultJSON []byte,
	opsJSON []byte,
	hasCanvasOps bool,
	completionInputJSON func(model.Task, []byte) (string, error),
	captureWorkflowSource func(model.Task) (string, error),
) (returnErr error) {
	defer func() {
		if full := kernel.DiskFullError(returnErr); full != nil {
			returnErr = full
		}
	}()
	if lock != nil {
		lock.Lock()
		defer lock.Unlock()
	}

	usage, err := repo.UserStorageUsage(task.UserID)
	if err != nil {
		return err
	}
	publicInputJSON, err := completionInputJSON(*task, resultJSON)
	if err != nil {
		return err
	}
	sourceCipher, err := captureWorkflowSource(*task)
	if err != nil {
		return err
	}
	taskDelta := int64(len(resultJSON) + len(publicInputJSON) + len(sourceCipher) - len(task.ResultJSON) - len(task.InputJSON) - len(task.WorkflowSourceCipher))

	results := make([]model.Result, 0, 2)
	structuredDelta := int64(0)
	if hasCanvasOps {
		results = append(results, model.Result{ID: kernel.NewID(), UserID: task.UserID, TaskID: task.ID, Kind: "canvas_ops", Payload: string(opsJSON)})
	}
	for index := range results {
		taskDelta += int64(len(results[index].URL) + len(results[index].Payload))
	}
	if err := ValidateTaskDataGrowthQuota(usage, taskDelta, policy.Resource); err != nil {
		return err
	}
	if err := ValidateStructuredStorageQuota(usage, "canvas", false, structuredDelta, policy.Resource); err != nil {
		return err
	}

	expectedStatus := task.Status
	completed := *task
	completed.Status = model.TaskStatusSucceeded
	completed.RecoveryOutcome = nil
	completed.NextPollAt = nil
	completed.Stage = "任务完成"
	completed.Progress = 100
	completed.ResultJSON = string(resultJSON)
	completed.InputJSON = publicInputJSON
	completed.WorkflowSourceCipher = sourceCipher
	now := time.Now()
	completed.CompletedAt = &now
	if err := repo.SaveTaskCompletion(&completed, expectedStatus, results); err != nil {
		return err
	}
	*task = completed
	return nil
}

func FileStorageUsageWithLoader(repo *repository.Repository, loadPolicy func() (platform.RuntimePolicySetting, error), userID string) (*AccountFileStorageUsage, error) {
	p, err := loadPolicy()
	if err != nil {
		return nil, err
	}
	return FileStorageUsage(repo, p, userID)
}

func CreateTaskWithinStorageQuota(repo *repository.Repository, mu *sync.Mutex, task *model.Task, policy platform.RuntimePolicySetting) error {
	mu.Lock()
	defer mu.Unlock()
	return CreateTaskWithStorageQuota(repo, task, policy)
}

func SaveTaskCompletionWithLoader(repo *repository.Repository, mu *sync.Mutex, loadPolicy func() (platform.RuntimePolicySetting, error), task *model.Task, resultJSON, opsJSON []byte, hasCanvasOps bool, completionInput func(model.Task, []byte) (string, error), captureSource func(model.Task) (string, error)) error {
	p, err := loadPolicy()
	if err != nil {
		return err
	}
	return SaveTaskCompletionWithinStorageQuota(repo, mu, p, task, resultJSON, opsJSON, hasCanvasOps, completionInput, captureSource)
}
