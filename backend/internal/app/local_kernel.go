package app

import (
	"context"
	"mime/multipart"
	"time"

	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

// LocalKernel is the intentionally narrow desktop-facing surface of Service.
// Method values prevent interface reflection from retaining the full Service
// method set, while keeping that linker concern out of the composition root.
type LocalKernel struct {
	workspaceOwner      func(string) (*model.User, error)
	cloudAgentRun       func(string, string) (*CloudAgentRun, error)
	listProjects        func(string) ([]ProjectSummary, error)
	resources           func(string, int) ([]model.Resource, error)
	uploadLocalResource func(string, *multipart.FileHeader, string, int, int, int64, ...string) (*model.Resource, error)
	tasksWithOptions    func(string, localtask.ListOptions) ([]localtask.Summary, error)
	createLocalTask     func(string, localtask.CreateRequest) (*model.Task, error)
	allowRequest        func(context.Context, string, int, time.Duration) (bool, error)
	requestRetryAfter   func(context.Context, string, time.Duration) time.Duration
	startWorker         func()
	stopWorker          func(context.Context) error
	close               func() error
}

func NewLocalKernel(service *Service) *LocalKernel {
	return &LocalKernel{
		workspaceOwner: service.WorkspaceOwner, cloudAgentRun: service.CloudAgentRun,
		listProjects: service.ListProjects, resources: service.Resources,
		uploadLocalResource: service.UploadLocalResource, tasksWithOptions: service.TasksWithOptions,
		createLocalTask: service.CreateLocalTask, allowRequest: service.AllowRequest,
		requestRetryAfter: service.RequestRetryAfter, startWorker: service.StartWorker,
		stopWorker: service.StopWorker, close: service.Close,
	}
}

func (k *LocalKernel) WorkspaceOwner(userID string) (*model.User, error) {
	return k.workspaceOwner(userID)
}

func (k *LocalKernel) CloudAgentRun(userID, runID string) (*CloudAgentRun, error) {
	return k.cloudAgentRun(userID, runID)
}

func (k *LocalKernel) ListProjects(userID string) ([]ProjectSummary, error) {
	return k.listProjects(userID)
}

func (k *LocalKernel) Resources(userID string, limit int) ([]model.Resource, error) {
	return k.resources(userID, limit)
}

func (k *LocalKernel) UploadLocalResource(userID string, header *multipart.FileHeader, kind string, width, height int, durationMs int64, identity ...string) (*model.Resource, error) {
	return k.uploadLocalResource(userID, header, kind, width, height, durationMs, identity...)
}

func (k *LocalKernel) TasksWithOptions(userID string, options localtask.ListOptions) ([]localtask.Summary, error) {
	return k.tasksWithOptions(userID, options)
}

func (k *LocalKernel) CreateLocalTask(userID string, request localtask.CreateRequest) (*model.Task, error) {
	return k.createLocalTask(userID, request)
}

func (k *LocalKernel) AllowRequest(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	return k.allowRequest(ctx, key, limit, window)
}

func (k *LocalKernel) RequestRetryAfter(ctx context.Context, key string, window time.Duration) time.Duration {
	return k.requestRetryAfter(ctx, key, window)
}

func (k *LocalKernel) StartWorker() { k.startWorker() }

func (k *LocalKernel) StopWorker(ctx context.Context) error { return k.stopWorker(ctx) }

func (k *LocalKernel) Close() error { return k.close() }
