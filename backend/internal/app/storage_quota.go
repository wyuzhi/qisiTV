package app

import (
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
	"qisitv/backend/internal/resource"
)

type AccountFileStorageUsage = resource.AccountFileStorageUsage

func (s *Service) AccountFileStorageUsage(u string) (*AccountFileStorageUsage, error)                                             { return resource.FileStorageUsageWithLoader(s.repo, s.RuntimePolicy, u) }
func validateStructuredStorageQuotaWithPolicy(u repository.UserStorageUsage, k string, c bool, d int64, p RuntimeResourcePolicy) error { return resource.ValidateStructuredStorageQuota(u, k, c, d, p) }
func validateStructuredCountQuotaWithPolicy(u repository.UserStorageUsage, k string, c int, d int64, p RuntimeResourcePolicy) error { return resource.ValidateStructuredCountQuota(u, k, c, d, p) }
func validateTaskStorageQuotaWithPolicy(u repository.UserStorageUsage, in int64, p RuntimeResourcePolicy) error                   { return resource.ValidateTaskStorageQuota(u, in, p) }
func validateAPICallLogQuotaWithPolicy(u repository.UserStorageUsage, in int64, p RuntimeResourcePolicy) error                    { return resource.ValidateAPICallLogQuota(u, in, p) }
func (s *Service) createTaskWithinStorageQuota(task *model.Task, policy RuntimePolicySetting) error                               { return resource.CreateTaskWithinStorageQuota(s.repo, &s.storageMu, task, policy) }
func createTaskWithStorageQuotaRepository(repo *repository.Repository, task *model.Task, policy RuntimePolicySetting) error       { return resource.CreateTaskWithStorageQuota(repo, task, policy) }
func (s *Service) saveTaskCompletionWithinStorageQuota(task *model.Task, resultJSON, opsJSON []byte, hasCanvasOps bool) error     { return resource.SaveTaskCompletionWithLoader(s.repo, &s.storageMu, s.RuntimePolicy, task, resultJSON, opsJSON, hasCanvasOps, s.completionInputJSON, s.captureCanvasWorkflowSource) }
