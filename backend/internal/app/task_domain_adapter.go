package app

import (
	"context"
	"errors"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
	localtask "qisitv/backend/internal/task"
)

func (s *Service) taskDomain() *localtask.Service {
	if s.tasks != nil {
		return s.tasks
	}
	s.tasksOnce.Do(func() {
		if s.tasks == nil {
			s.tasks = localtask.NewService(localtask.NewStore(s.repo), s.taskDependencies())
		}
	})
	return s.tasks
}

func (s *Service) TaskService() *localtask.Service { return s.taskDomain() }

func (s *Service) taskDependencies() localtask.Dependencies {
	return localtask.Dependencies{
		BindTranscriptionModel: s.bindTranscriptionModel,
		Catalog:                taskCatalogAdapter{s},
		Secrets:                taskSecretsAdapter{s},
		Media:                  taskMediaAdapter{s},
		Projects:               taskProjectsAdapter{s},
		Policy:                 taskPolicyAdapter{s},
		Persist:                taskPersistAdapter{s},
		Runtime:                taskRuntimeAdapter{s},
		Images:                 taskImagesAdapter{s},
		Failures:               taskFailuresAdapter{},
		TextReplay:             s.TextReplay(),
		Provider:               taskProviderAdapter{s},
		Recovery:               taskRecoveryAdapter{s},
		Present:                taskPresenterAdapter{s},
		Logs:                   taskLogAdapter{s},
		Activity:               taskActivityAdapter{s},
		OwnedMedia:             taskOwnedMediaAdapter{s},
		Features:               taskFeaturesAdapter{s},
		NewID:                  newID,
	}
}

func toTaskCreateRequest(req CreateTaskRequest) localtask.CreateRequest {
	return localtask.CreateRequest{
		ProjectID: req.ProjectID, Type: req.Type, Operation: req.Operation, Prompt: req.Prompt,
		Provider: req.Provider, Model: req.Model, LogicalModelID: req.LogicalModelID,
		Input: req.Input, TraceID: req.TraceID, RequestID: req.RequestID,
	}
}

type taskCatalogAdapter struct{ s *Service }

func (a taskCatalogAdapter) Select(userID string, req localtask.SelectRequest) (localtask.SelectResult, error) {
	return localtask.SelectCatalogTask(userID, req, a.s.upscaleConfig, a.s.RequireWorkflowPluginForUser, func() (bool, error) {
		return a.s.FeatureEnabled(FeatureFrontendModels)
	}, a.s.taskSelectLookup(), a.s.likeAIUpscaleConfig)
}

func (a taskCatalogAdapter) PrepareRetry(task *model.Task, input map[string]any) error {
	if err := a.s.prepareLogicalTaskRetry(task, input); err != nil {
		return err
	}
	return a.s.validatePortraitTaskQuote(input)
}

func (a taskCatalogAdapter) RequireCustomChannels(input map[string]any) error {
	return a.s.requireCustomChannelsForTaskInput(input)
}

func (a taskCatalogAdapter) ValidateCapability(input map[string]any) error {
	return localtask.ValidateCatalogCapability(input, a.s.ValidateTaskCapability, a.s.validatePortraitTaskQuote)
}

func (taskCatalogAdapter) HasExecutableVideoConfig(input map[string]any) bool {
	return modelcatalog.HasExecutableVideoConfig(input)
}

type taskSecretsAdapter struct{ s *Service }

func (a taskSecretsAdapter) ResolveManaged(input map[string]any) (map[string]any, error) {
	return a.s.resolveManagedBeefAPISecrets(input)
}
func (a taskSecretsAdapter) Protect(input map[string]any) error { return a.s.protectTaskSecrets(input) }
func (a taskSecretsAdapter) DecryptInputJSON(raw string) (string, error) {
	return a.s.decryptTaskInputJSON(raw)
}

type taskMediaAdapter struct{ s *Service }

func (a taskMediaAdapter) ValidateTransport(userID string, input map[string]any) error {
	return localtask.ValidateTaskMediaTransport(userID, input, isWorkflowProviderInterface, a.s.resolveProviderConfig, a.s.bindGenerationRuntime, a.s.protocolRegistry())
}
func (taskMediaAdapter) ContainsInlineData(input map[string]any) bool {
	return containsInlineMediaDataURL(input)
}

type taskProjectsAdapter struct{ s *Service }

func (a taskProjectsAdapter) EnsureActive(userID, canvasOrProjectID string) error {
	return a.s.ensureTaskProjectActive(userID, canvasOrProjectID)
}

type taskOwnedMediaAdapter struct{ s *Service }

func (a taskOwnedMediaAdapter) Resource(userID, id string) (*model.Resource, error) {
	return a.s.Resource(userID, id)
}

type taskFeaturesAdapter struct{ s *Service }

func (a taskFeaturesAdapter) Require(name string) error { return a.s.RequireFeature(name) }

type taskPolicyAdapter struct{ s *Service }

func (a taskPolicyAdapter) ActiveTaskLimit() (int, error) {
	policy, err := a.s.RuntimePolicy()
	if err != nil {
		return 0, err
	}
	return policy.Task.ActiveTaskLimit, nil
}

type taskPersistAdapter struct{ s *Service }

func (a taskPersistAdapter) CreateAdmitted(task *model.Task, limit int) error {
	policy, err := a.s.RuntimePolicy()
	if err != nil {
		return err
	}
	policy.Task.ActiveTaskLimit = limit
	return a.s.createTaskWithinStorageQuota(task, policy)
}

type taskRuntimeAdapter struct{ s *Service }

func (a taskRuntimeAdapter) IsDraining() bool        { return a.s.IsDraining() }
func (a taskRuntimeAdapter) StopLocalWait(id string) { a.s.cancelActiveTask(id) }
func (a taskRuntimeAdapter) Dispatch(fn func()) bool { return a.s.runWorkerTask(fn) }

type taskImagesAdapter struct{ s *Service }

func (a taskImagesAdapter) ValidateRetry(task *model.Task) error {
	return a.s.validateImageTaskRetry(task)
}

type taskFailuresAdapter struct{}

func (taskFailuresAdapter) BlocksRetry(message, stage string) bool {
	return persistedFailureBlocksRetry(message, stage)
}
func (taskFailuresAdapter) IsModeration(message string) bool {
	return isContentModerationFailure(message)
}
func (taskFailuresAdapter) Category(message, stage string) generation.FailureCategory {
	if stage == "submission_unknown" {
		return generation.CategorySubmissionUncertain
	}
	return classifyTaskFailure(errors.New(message)).Category
}
func (taskFailuresAdapter) UserMessage(message string) string {
	return classifyTaskFailure(errors.New(message)).UserMessage()
}

type taskProviderAdapter struct{ s *Service }

func (a taskProviderAdapter) RequestCancel(ctx context.Context, task *model.Task) error {
	return a.s.requestProviderCancellation(ctx, task)
}

type taskRecoveryAdapter struct{ s *Service }

func (a taskRecoveryAdapter) ResetBackoff(userID, taskID string) error {
	return a.s.repo.ResetTaskRecoveryBackoff(userID, taskID)
}
func (a taskRecoveryAdapter) ResumeDelivery(ctx context.Context, userID, taskID string) (*model.Task, error) {
	return a.s.resumeTaskDeliveryForUser(ctx, userID, taskID)
}
func (a taskRecoveryAdapter) RecoverImage(ctx context.Context, userID, taskID string) (*model.Task, error) {
	return a.s.recoverFailedImageForUser(ctx, userID, taskID)
}
func (a taskRecoveryAdapter) RecoverVideoOrUpscale(ctx context.Context, userID, taskID string) (*model.Task, error) {
	return a.s.recoverFailedVideoOrUpscaleForUser(ctx, userID, taskID)
}

type taskPresenterAdapter struct{ s *Service }

func (a taskPresenterAdapter) Task(task model.Task) *model.Task {
	a.s.attachTaskDelivery(&task)
	return taskForOutput(task)
}
func (a taskPresenterAdapter) Summaries(tasks []model.Task) []localtask.Summary {
	summaries := taskSummariesForOutput(tasks)
	a.s.attachTaskSummaryDeliveries(tasks, summaries)
	return summaries
}
func (taskPresenterAdapter) Logs(logs []model.TaskLog) []model.TaskLog {
	return localtask.PresentTaskLogs(logs)
}

type taskLogAdapter struct{ s *Service }

func (a taskLogAdapter) Log(userID, taskID, level, message, payload string) error {
	return a.s.log(userID, taskID, level, message, payload)
}

type taskActivityAdapter struct{ s *Service }

func (a taskActivityAdapter) Record(userID, kind string, n int) {
	a.s.recordActivity(userID, kind, n)
}

func isRetiredAgentOperation(operation string) bool {
	return localtask.IsRetiredAgentOperation(operation)
}
func isRetiredAgentTaskInput(operation string, input map[string]any) bool {
	return localtask.IsRetiredAgentTaskInput(operation, input)
}
func retiredAgentTask(task *model.Task) bool {
	return localtask.RetiredAgentTask(task)
}
func clientOperationHash(req CreateTaskRequest) (string, error) {
	return localtask.ClientOperationHash(toTaskCreateRequest(req))
}
func clientOperationID(input map[string]any) (string, error) {
	return localtask.ClientOperationID(input)
}
func normalizeTaskInput(input map[string]any) (map[string]any, error) {
	return localtask.NormalizeInput(input)
}
func validateTaskType(taskType string) error {
	return localtask.ValidateType(taskType)
}
func (s *Service) validateRetryTaskType(userID string, taskType string, input map[string]any) error {
	return s.taskDomain().ValidateRetryType(userID, taskType, input)
}
