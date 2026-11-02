package handler

import (
	"context"
	"mime/multipart"
	"net/http"
	"time"

	"qisitv/backend/internal/appearance"
	"qisitv/backend/internal/assistantruntime"
	"qisitv/backend/internal/beefapi"
	"qisitv/backend/internal/conversation"
	"qisitv/backend/internal/diagnostics"
	"qisitv/backend/internal/eagle"
	"qisitv/backend/internal/localapp"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
	localproject "qisitv/backend/internal/project"
	localtask "qisitv/backend/internal/task"
	"qisitv/backend/internal/textreplay"
	"qisitv/backend/internal/workspace"

	"github.com/gin-gonic/gin"
)

// RequestCoordinator is the narrow runtime boundary required by request
// throttling. Keeping it separate from app.Service prevents handlers from
// depending on process-global mutable state and makes multiple runtimes safe.
type RequestCoordinator interface {
	AllowRequest(context.Context, string, int, time.Duration) (bool, error)
	RequestRetryAfter(context.Context, string, time.Duration) time.Duration
}

type ProviderConfig interface {
	ReadLocalModelConfig() ([]byte, error)
	SaveLocalModelConfig([]byte) error
}

type VersionedProviderConfig interface {
	ProviderConfig
	LoadEffectiveModelConfig() (workspace.EffectiveModelConfig, workspace.ConfigHealth, error)
	SaveLocalModelConfigRevision([]byte, int64) (int64, error)
}

type RuntimeDependencies struct {
	RequestCoordinator RequestCoordinator
	ProviderConfig     ProviderConfig
	ModelCapability    localapp.ModelCapabilityPort
	Assets             localapp.AssetPort
	Projects           localapp.ProjectPort
	Tasks              localapp.TaskPort
	Generation         localapp.GenerationPort
	Conversations      *conversation.Service
	// TextReplay is the archive owned by the runtime; legacy callers use its app facade.
	TextReplay  textreplay.API
	BeefAPI     *beefapi.Service
	Eagle       *eagle.Client
	Diagnostics *diagnostics.Service
	Appearance  *appearance.Service
	// AssistantHost is the per-runtime supervisor for the built-in agent-host child.
	// Separate runtimes must not share this value.
	AssistantHost *assistantruntime.Host
	// DesktopTrust verifies both the launch token and the separate Wails UI bootstrap credential.
	// 桌面形态用它代替开发引导开关签发 UI 会话；服务端形态为 nil。
	DesktopTrust func(*http.Request) bool
}

type serviceRuntimeAdapter struct {
	allowRequest                func(context.Context, string, int, time.Duration) (bool, error)
	requestRetryAfter           func(context.Context, string, time.Duration) time.Duration
	readModelConfig             func() ([]byte, error)
	saveModelConfig             func([]byte) error
	resources                   func(string, int) ([]model.Resource, error)
	uploadLocalResource         func(string, *multipart.FileHeader, string, int, int, int64, ...string) (*model.Resource, error)
	listProjects                func(string) ([]localproject.Summary, error)
	tasksWithOptions            func(string, localtask.ListOptions) ([]localtask.Summary, error)
	createTask                  func(string, localtask.CreateRequest) (*model.Task, error)
	createTimelineRender        func(string, localtask.TimelineRenderCreateRequest) (*model.Task, error)
	createTimelineTranscription func(string, localtask.TimelineTranscriptionCreateRequest) (*model.Task, error)
	createDepthCapture          func(string, localtask.DepthCaptureCreateRequest) (*model.Task, error)
	recoverTask                 func(context.Context, string, string) (*model.Task, error)
}

type serviceRuntimeSource interface {
	RequestCoordinator
	ProviderConfig
	localapp.AssetPort
	localapp.ProjectPort
	localapp.TaskPort
	CreateLocalTask(string, localtask.CreateRequest) (*model.Task, error)
}

func newServiceRuntimeAdapter(value serviceRuntimeSource) serviceRuntimeAdapter {
	return serviceRuntimeAdapter{
		allowRequest: value.AllowRequest, requestRetryAfter: value.RequestRetryAfter,
		readModelConfig: value.ReadLocalModelConfig, saveModelConfig: value.SaveLocalModelConfig,
		resources: value.Resources, uploadLocalResource: value.UploadLocalResource,
		listProjects: value.ListProjects, tasksWithOptions: value.TasksWithOptions, createTask: value.CreateLocalTask,
		createTimelineRender: value.CreateTimelineRenderTask, createTimelineTranscription: value.CreateTimelineTranscriptionTask,
		createDepthCapture: value.CreateDepthCaptureTask, recoverTask: value.RecoverTask,
	}
}

func (a serviceRuntimeAdapter) AllowRequest(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	return a.allowRequest(ctx, key, limit, window)
}

func (a serviceRuntimeAdapter) RequestRetryAfter(ctx context.Context, key string, window time.Duration) time.Duration {
	return a.requestRetryAfter(ctx, key, window)
}

func (a serviceRuntimeAdapter) ReadLocalModelConfig() ([]byte, error) {
	return a.readModelConfig()
}

func (a serviceRuntimeAdapter) SaveLocalModelConfig(value []byte) error {
	return a.saveModelConfig(value)
}

func (a serviceRuntimeAdapter) Resources(userID string, limit int) ([]model.Resource, error) {
	return a.resources(userID, limit)
}

func (a serviceRuntimeAdapter) UploadLocalResource(userID string, header *multipart.FileHeader, kind string, width, height int, durationMs int64, identity ...string) (*model.Resource, error) {
	return a.uploadLocalResource(userID, header, kind, width, height, durationMs, identity...)
}

func (a serviceRuntimeAdapter) ListProjects(userID string) ([]localproject.Summary, error) {
	return a.listProjects(userID)
}

func (a serviceRuntimeAdapter) TasksWithOptions(userID string, options localtask.ListOptions) ([]localtask.Summary, error) {
	return a.tasksWithOptions(userID, options)
}

func (a serviceRuntimeAdapter) CreateTask(userID string, request localtask.CreateRequest) (*model.Task, error) {
	return a.createTask(userID, request)
}

func (a serviceRuntimeAdapter) CreateTimelineRenderTask(userID string, request localtask.TimelineRenderCreateRequest) (*model.Task, error) {
	return a.createTimelineRender(userID, request)
}

func (a serviceRuntimeAdapter) CreateTimelineTranscriptionTask(userID string, request localtask.TimelineTranscriptionCreateRequest) (*model.Task, error) {
	return a.createTimelineTranscription(userID, request)
}

func (a serviceRuntimeAdapter) CreateDepthCaptureTask(userID string, request localtask.DepthCaptureCreateRequest) (*model.Task, error) {
	return a.createDepthCapture(userID, request)
}

func (a serviceRuntimeAdapter) RecoverTask(ctx context.Context, userID, id string) (*model.Task, error) {
	return a.recoverTask(ctx, userID, id)
}

func requestAssetPort(c *gin.Context, fallback localapp.AssetPort) localapp.AssetPort {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.Assets != nil {
		return dependencies.Assets
	}
	return fallback
}

func requestProjectPort(c *gin.Context, fallback serviceRuntimeSource) localapp.ProjectPort {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.Projects != nil {
		return dependencies.Projects
	}
	return newServiceRuntimeAdapter(fallback)
}

func requestTaskPort(c *gin.Context, fallback serviceRuntimeSource) localapp.TaskPort {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.Tasks != nil {
		return dependencies.Tasks
	}
	return newServiceRuntimeAdapter(fallback)
}

func requestGenerationPort(c *gin.Context, fallback serviceRuntimeSource) localapp.GenerationPort {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.Generation != nil {
		return dependencies.Generation
	}
	return newServiceRuntimeAdapter(fallback)
}

// modelConfigFallback supplies the unversioned model-config read and write
// when a request has no injected provider port.
type modelConfigFallback interface {
	ReadLocalModelConfig() ([]byte, error)
	SaveLocalModelConfig([]byte) error
}

func requestProviderConfig(c *gin.Context, fallback modelConfigFallback) ProviderConfig {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.ProviderConfig != nil {
		return dependencies.ProviderConfig
	}
	if service, ok := fallback.(serviceRuntimeSource); ok {
		return newServiceRuntimeAdapter(service)
	}
	return modelConfigMethods{read: fallback.ReadLocalModelConfig, save: fallback.SaveLocalModelConfig}
}

type modelConfigMethods struct {
	read func() ([]byte, error)
	save func([]byte) error
}

func (m modelConfigMethods) ReadLocalModelConfig() ([]byte, error) { return m.read() }
func (m modelConfigMethods) SaveLocalModelConfig(value []byte) error {
	return m.save(value)
}

func requestModelCapability(c *gin.Context) localapp.ModelCapabilityPort {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.ModelCapability != nil {
		return dependencies.ModelCapability
	}
	return modelcatalog.NewCapabilityNormalizer()
}

func requestTextReplay(c *gin.Context, fallback textReplayAPI) textReplayAPI {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.TextReplay != nil {
		return dependencies.TextReplay
	}
	return fallback
}

const runtimeDependenciesKey = "canvas.runtime-dependencies"

func RuntimeDependenciesMiddleware(dependencies RuntimeDependencies) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(runtimeDependenciesKey, dependencies)
		c.Next()
	}
}

func runtimeDependencies(c *gin.Context) (RuntimeDependencies, bool) {
	value, ok := c.Get(runtimeDependenciesKey)
	if !ok {
		return RuntimeDependencies{}, false
	}
	dependencies, ok := value.(RuntimeDependencies)
	return dependencies, ok
}
