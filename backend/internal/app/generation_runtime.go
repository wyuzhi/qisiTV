package app

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/outbound"
)

type appResourcePort struct{ service *Service }

func (p appResourcePort) EnsureMetadata(ctx context.Context, userID, resourceID string) (generation.ResourceInfo, error) {
	resource, err := p.service.resourceDomain().EnsureMediaMetadata(ctx, userID, resourceID)
	if err != nil {
		return generation.ResourceInfo{}, err
	}
	return generation.ResourceInfoFromModel(userID, resource), nil
}

func (p appResourcePort) Lookup(userID, resourceID string) (generation.ResourceInfo, error) {
	resource, err := p.service.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		return generation.ResourceInfo{}, err
	}
	return generation.ResourceInfoFromModel(userID, resource), nil
}

func (p appResourcePort) Open(userID, resourceID string) (generation.ResourceInfo, io.ReadCloser, error) {
	resource, body, err := p.service.OpenResource(userID, resourceID)
	if err != nil {
		return generation.ResourceInfo{}, nil, err
	}
	return generation.ResourceInfoFromModel(userID, resource), body, nil
}

func (p appResourcePort) PublicURL(info generation.ResourceInfo, expiresAt time.Time) (string, error) {
	resource, err := p.service.repo.ResourceForUser(info.UserID, info.ID)
	if err != nil {
		return "", err
	}
	return p.service.directResourceURL(resource, expiresAt)
}

func (p appResourcePort) HTTPSPublicURL(info generation.ResourceInfo, expiresAt time.Time) (string, error) {
	resource, err := p.service.repo.ResourceForUser(info.UserID, info.ID)
	if err != nil {
		return "", err
	}
	return p.service.signedHTTPSPublicResourceURL(resource, expiresAt)
}

func (p appResourcePort) LocalMode() bool {
	return p.service != nil && p.service.IsLocalMode()
}

type appLimitsPort struct{ service *Service }

func (p appLimitsPort) GeneratedFileBytes(ctx context.Context) (int64, error) {
	policy, err := p.service.RuntimePolicy()
	if err != nil {
		return 0, err
	}
	return megabytes(policy.Resource.GeneratedFileMB), nil
}

func (p appLimitsPort) ResourceUploadBytes(ctx context.Context) (int64, error) {
	policy, err := p.service.RuntimePolicy()
	if err != nil {
		return 0, err
	}
	return megabytes(policy.Resource.ResourceUploadMB), nil
}

func (p appLimitsPort) CircuitOpen(ctx context.Context, channelID string) (bool, error) {
	if p.service == nil || p.service.coordinator == nil {
		return false, nil
	}
	return p.service.coordinator.CircuitOpen(ctx, channelID)
}

func (p appLimitsPort) AcquireChannelSlot(ctx context.Context, channelID, slotID string, timeout time.Duration) (func(), int, error) {
	return p.service.AcquireChannelSlot(ctx, channelID, slotID, timeout)
}

func (p appLimitsPort) RecordChannelResult(ctx context.Context, channelID string, failure bool) error {
	return p.service.RecordChannelResult(ctx, channelID, failure)
}

type appReceiptPort struct{ service *Service }

type appTaskStagePort struct {
	service *Service
	task    model.Task
}

func (p appTaskStagePort) SetStage(ctx context.Context, stage string) error {
	return generation.SetTaskStage(ctx, p.service.repo, p.service.log, p.task, stage)
}

type appTaskDeliveryPort struct {
	service *Service
	taskID  string
}

type appTaskDownloadCachePort struct {
	service        *Service
	userID, taskID string
}

func (p appTaskDownloadCachePort) PartialPath() string {
	return (generationDeliveryMediaAdapter{service: p.service}).artifactDownloadPartialPath(p.userID, p.taskID+":provider")
}

func (p appTaskDeliveryPort) ReportDelivery(progress outbound.ResumableProgress) {
	taskID := strings.TrimSpace(p.taskID)
	if p.service == nil || taskID == "" {
		return
	}
	identity := taskID + ":0"
	p.service.deliveryProgressRegistry().record(identity, deliveryProgressFromOutbound(identity, progress))
}

func (p appTaskDeliveryPort) ClearDelivery() {
	taskID := strings.TrimSpace(p.taskID)
	if p.service == nil || taskID == "" {
		return
	}
	p.service.deliveryProgressRegistry().clear(taskID + ":0")
	generation.LogTaskPhase(p.service.repo, p.service.log, taskID, "result_transfer_end")
}

func (p appReceiptPort) Observe(observation generation.TransportObservation) {
	if p.service == nil {
		generation.ObserveTransportReceipt(observation, nil, nil, nil)
		return
	}
	generation.ObserveTransportReceipt(observation, p.service.repo, func(ctx context.Context) (model.Task, bool) {
		t, ok := ctx.Value(imageTaskContext{}).(model.Task)
		return t, ok
	}, p.service.LogAPICall)
}

func (p appReceiptPort) NotifyPoll(ctx context.Context, event string, err error) {
	if p.service != nil {
		generation.NotifyPollReceipt(ctx, p.service.repo, p.service.log, event, err)
	}
}

func (p appReceiptPort) SyncProgress(taskID string, body []byte) {
	if p.service != nil {
		p.service.syncProviderTaskProgress(taskID, body)
	}
}

type appImagePort struct{ service *Service }

func (p appImagePort) Intercept(req *http.Request) (bool, []byte, string, error) {
	return generation.InterceptImageRequest(req, p.service != nil, func(r *http.Request) (*model.ImageSubmission, bool, error) {
		return prepareImageSubmission(p.service, r)
	}, func(ctx context.Context) model.Task {
		return ctx.Value(imageTaskContext{}).(model.Task)
	}, func(ctx context.Context, task model.Task, row *model.ImageSubmission) ([]byte, string, error) {
		return p.service.sendImageSubmission(ctx, task, row)
	})
}

type appPromptPort struct{ service *Service }

func (p appPromptPort) Compile(userID, operation string, values map[string]string) (string, error) {
	if p.service == nil {
		return "", errors.New("编译用户提示词失败：提示词端口未接入")
	}
	compiled, err := p.service.compilePrompt(userID, operation, values)
	if err != nil {
		return "", err
	}
	return compiled.Content, nil
}

func (p appPromptPort) ValidateResult(operation string, result map[string]any) error {
	return validatePromptTemplateResult(operation, result)
}

type appConfigPort struct{ service *Service }

func (p appConfigPort) Resolve(config generation.Config) (generation.Config, error) {
	if p.service == nil {
		return generation.Config{}, errors.New("无法解析系统渠道配置")
	}
	return p.service.resolveProviderConfig(config)
}

func (p appConfigPort) ApplyCapabilities(ctx context.Context, input *generation.Input) error {
	if p.service == nil || input == nil {
		return nil
	}
	return generation.ApplyStandardCapabilities(ctx, p.service.repo, p.service.ReadLocalModelConfig, input)
}

func (p appConfigPort) SyncArkPrivateAssets(ctx context.Context, userID string, input *generation.Input) error {
	if p.service == nil || input == nil {
		return nil
	}
	return p.service.prepareArkPrivateAssetReferences(ctx, userID, input)
}

type appStylePort struct{ service *Service }

func (p appStylePort) Apply(userID, projectID string, input *generation.Input) error {
	if p.service == nil {
		return errors.New("项目画风执行配置无效：画风端口未接入")
	}
	return p.service.applyGenerationStyleProfile(userID, projectID, input)
}

type appMediaProbe struct{}

func (appMediaProbe) ProbeSeedance2Video(config generation.Config, index int, media *generation.Media, data []byte) error {
	return applySeedance2VideoProbe(config, index, media, data)
}

func (s *Service) bindGenerationRuntime(ctx context.Context, meta generation.CallMeta) context.Context {
	return s.applyGenerationRuntime(ctx, meta, true)
}

func (s *Service) enrichGenerationRuntime(ctx context.Context, meta generation.CallMeta) context.Context {
	return s.applyGenerationRuntime(ctx, meta, false)
}

func (s *Service) applyGenerationRuntime(ctx context.Context, meta generation.CallMeta, replaceCall bool) context.Context {
	if s == nil {
		if replaceCall {
			ctx = generation.WithCallMeta(ctx, meta)
		} else {
			ctx = generation.EnrichCallMeta(ctx, meta)
		}
		return bindRequestReceipts(ctx)
	}
	runtime := generation.Runtime{
		ReferenceStorage: s.newReferenceStoragePort(),
		Resources:        appResourcePort{service: s},
		Limits:           appLimitsPort{service: s},
		Receipts:         appReceiptPort{service: s},
		Images:           appImagePort{service: s},
		ManagedMedia:     s.mediaAttempts().ManagedPort(),
		Prompt:           appPromptPort{service: s},
		Config:           appConfigPort{service: s},
		Style:            appStylePort{service: s},
		Probe:            appMediaProbe{},
		Call:             meta,
	}
	if existing, ok := generation.RuntimeFromContext(ctx); ok {
		runtime.Endpoints = existing.Endpoints
		runtime.Stages = existing.Stages
		runtime.Delivery = existing.Delivery
		runtime.ReferenceProgress = existing.ReferenceProgress
		if !replaceCall {
			runtime.Call = generation.IdentityCallMeta(existing.Call, meta)
		}
	}
	if s.dataDir != "" && runtime.Call.UserID != "" && runtime.Call.TaskID != "" {
		runtime.DownloadCache = appTaskDownloadCachePort{service: s, userID: runtime.Call.UserID, taskID: runtime.Call.TaskID}
	}
	return generation.WithRuntime(ctx, runtime)
}

func bindRequestReceipts(ctx context.Context) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	runtime, _ := generation.RuntimeFromContext(ctx)
	if runtime.Receipts != nil {
		return ctx
	}
	if metadata, ok := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext); ok {
		if strings.TrimSpace(runtime.Call.UserID) == "" && strings.TrimSpace(runtime.Call.TaskID) == "" {
			runtime.Call = metadata
		}
	}
	runtime.Receipts = appReceiptPort{}
	return generation.WithRuntime(ctx, runtime)
}
