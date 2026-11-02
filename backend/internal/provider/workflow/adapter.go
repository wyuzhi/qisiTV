package workflow

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"qisitv/backend/internal/outbound"
)

type ReceiptConfig struct {
	HasService       bool
	HasRepo          bool
	TaskIdentity     func(ctx context.Context) (userID, taskID string, ok bool)
	CheckTaskForUser func(userID, taskID string) error
	UpdateTaskState  func(taskID, requestID, stage string, nextPollAt *time.Time) error
}

type AdapterConfig struct {
	WithRequestKind func(ctx context.Context, kind string) context.Context
	DoBinary        func(req *http.Request) (data []byte, mimeType string, err error)
	HTTPStatus      func(err error) (statusCode int, body string, ok bool)
	NewHTTPError    func(statusCode int, body string) error
	LoadMedia       func(media Media) ([]byte, string, error)
	Receipt         ReceiptConfig
	LogProgress     func(ctx context.Context, level, message, payload string)
	EnsurePlugin    func(interfaceType string) error
	Sleep           func(ctx context.Context, d time.Duration) error
	PollDeadline    func(ctx context.Context) time.Time
	DefaultPolicy   PollPolicy
	OverridePolicy  *PollPolicy
	PollVideo       func(ctx context.Context, taskID string, policy PollPolicy, query func(context.Context) (PollOutcome, error)) (map[string]any, error)
	DownloadVideo   func(ctx context.Context, taskID string, policy PollPolicy, source BinarySource, renew func(context.Context) (BinarySource, error)) ([]byte, string, error)
}

func NewClient(cfg AdapterConfig) *Client {
	return &Client{
		Requests: configRequestExecutor{cfg: cfg},
		Media:    configMediaLoader{load: cfg.LoadMedia},
		Receipt:  configReceipt{cfg: cfg.Receipt},
		Progress: configProgress{log: cfg.LogProgress},
		Plugins:  configPlugins{hasService: cfg.Receipt.HasService, ensure: cfg.EnsurePlugin},
		Time:     configTime{sleep: cfg.Sleep, deadline: cfg.PollDeadline},
		Poller:   configPoller{cfg: cfg},
	}
}

type configPoller struct{ cfg AdapterConfig }

func (p configPoller) effectivePolicy(policy PollPolicy) PollPolicy {
	base := p.cfg.DefaultPolicy
	if p.cfg.OverridePolicy != nil {
		base = *p.cfg.OverridePolicy
	}
	return MergePollPolicy(base, policy)
}

func (p configPoller) Poll(ctx context.Context, taskID string, policy PollPolicy, query func(context.Context) (PollOutcome, error)) (map[string]any, error) {
	return p.cfg.PollVideo(ctx, taskID, p.effectivePolicy(policy), query)
}

func (p configPoller) Download(ctx context.Context, taskID string, policy PollPolicy, source BinarySource, renew func(context.Context) (BinarySource, error)) ([]byte, string, error) {
	var wrappedRenew func(context.Context) (BinarySource, error)
	if renew != nil {
		wrappedRenew = func(ctx context.Context) (BinarySource, error) {
			fresh, err := renew(ctx)
			var pending StatusError
			if errors.As(err, &pending) && pending.Err == nil && p.cfg.NewHTTPError != nil {
				err = p.cfg.NewHTTPError(pending.StatusCode, pending.Body)
			}
			return fresh, err
		}
	}
	return p.cfg.DownloadVideo(ctx, taskID, p.effectivePolicy(policy), source, wrappedRenew)
}

func MapMedia[T any](items []T, fn func(T) Media) []Media {
	if items == nil {
		return nil
	}
	res := make([]Media, len(items))
	for i, item := range items {
		res[i] = fn(item)
	}
	return res
}

type configRequestExecutor struct {
	cfg AdapterConfig
}

func (e configRequestExecutor) Execute(ctx context.Context, req Request) ([]byte, string, error) {
	if req.Kind != "" && e.cfg.WithRequestKind != nil {
		ctx = e.cfg.WithRequestKind(ctx, req.Kind)
	}
	var body *bytes.Reader
	if len(req.Body) > 0 {
		body = bytes.NewReader(req.Body)
	} else {
		body = bytes.NewReader(nil)
	}
	httpReq, err := http.NewRequestWithContext(ctx, req.Method, req.URL, body)
	if err != nil {
		return nil, "", err
	}
	if req.ContentType != "" {
		httpReq.Header.Set("Content-Type", req.ContentType)
	}
	outbound.ApplyOutboundHeaders(httpReq, req.Headers)
	data, mimeType, err := e.cfg.DoBinary(httpReq)
	if err != nil {
		if e.cfg.HTTPStatus != nil {
			if statusCode, errBody, ok := e.cfg.HTTPStatus(err); ok && statusCode > 0 {
				return nil, "", StatusError{StatusCode: statusCode, Body: errBody, Err: err}
			}
		}
		return nil, "", err
	}
	return data, mimeType, nil
}

type configMediaLoader struct {
	load func(media Media) ([]byte, string, error)
}

func (m configMediaLoader) LocalBytes(media Media) ([]byte, string, error) {
	if m.load == nil {
		return nil, "", nil
	}
	return m.load(media)
}

type configReceipt struct {
	cfg ReceiptConfig
}

func (r configReceipt) Ready(ctx context.Context) error {
	if !r.cfg.HasService {
		return errors.New("工作流缺少受理回执端口")
	}
	if !r.cfg.HasRepo || r.cfg.TaskIdentity == nil {
		return errors.New("工作流缺少本地任务回执上下文")
	}
	userID, taskID, ok := r.cfg.TaskIdentity(ctx)
	userID, taskID = strings.TrimSpace(userID), strings.TrimSpace(taskID)
	if !ok || taskID == "" || userID == "" {
		return errors.New("工作流缺少本地任务回执上下文")
	}
	if r.cfg.CheckTaskForUser != nil {
		if err := r.cfg.CheckTaskForUser(userID, taskID); err != nil {
			return fmt.Errorf("工作流缺少本地任务回执上下文：%w", err)
		}
	}
	return nil
}

func (r configReceipt) RecordAccepted(ctx context.Context, requestID, stage string, nextPollAt *time.Time) error {
	if !r.cfg.HasService {
		return errors.New("工作流缺少受理回执端口")
	}
	return RecordAcceptedState(ctx, r.cfg, requestID, stage, nextPollAt)
}

func (r configReceipt) UpdateStage(ctx context.Context, requestID, stage string, nextPollAt *time.Time) error {
	if !r.cfg.HasService {
		return errors.New("工作流缺少受理回执端口")
	}
	return UpdateTaskStage(ctx, r.cfg, requestID, stage, nextPollAt)
}

func RecordAcceptedState(ctx context.Context, cfg ReceiptConfig, requestID, stage string, nextPollAt *time.Time) error {
	if !cfg.HasService || !cfg.HasRepo || cfg.TaskIdentity == nil || cfg.UpdateTaskState == nil {
		return errors.New("工作流缺少本地任务回执上下文")
	}
	_, taskID, ok := cfg.TaskIdentity(ctx)
	if !ok || strings.TrimSpace(taskID) == "" {
		return errors.New("工作流缺少本地任务回执上下文")
	}
	return cfg.UpdateTaskState(taskID, requestID, stage, nextPollAt)
}

func UpdateTaskStage(ctx context.Context, cfg ReceiptConfig, requestID, stage string, nextPollAt *time.Time) error {
	if !cfg.HasService || !cfg.HasRepo || cfg.TaskIdentity == nil || cfg.UpdateTaskState == nil {
		return nil
	}
	_, taskID, ok := cfg.TaskIdentity(ctx)
	if !ok || taskID == "" {
		return nil
	}
	return cfg.UpdateTaskState(taskID, requestID, stage, nextPollAt)
}

type configProgress struct {
	log func(ctx context.Context, level, message, payload string)
}

func (p configProgress) Log(ctx context.Context, level, message, payload string) {
	if p.log != nil {
		p.log(ctx, level, message, payload)
	}
}

type configPlugins struct {
	hasService bool
	ensure     func(interfaceType string) error
}

func (p configPlugins) EnsureEnabled(_ context.Context, interfaceType string) error {
	if !p.hasService || p.ensure == nil {
		return errors.New("工作流缺少插件授权端口")
	}
	return p.ensure(interfaceType)
}

type configTime struct {
	sleep    func(ctx context.Context, d time.Duration) error
	deadline func(ctx context.Context) time.Time
}

func (configTime) Now() time.Time { return time.Now() }

func (t configTime) Sleep(ctx context.Context, d time.Duration) error {
	if t.sleep == nil {
		return nil
	}
	return t.sleep(ctx, d)
}

func (t configTime) PollDeadline(ctx context.Context) time.Time {
	if t.deadline == nil {
		return time.Time{}
	}
	return t.deadline(ctx)
}

func (configTime) LegacyPollInterval() time.Duration { return 2500 * time.Millisecond }

func NewInput(mode, prompt string, cfg Config, images, videos, audios []Media, mask *Media, resumedID string, local bool) Input {
	in := Input{
		Mode: mode, Prompt: prompt, Config: cfg,
		ReferenceImages: images, ReferenceVideos: videos, ReferenceAudios: audios,
		ResumedRequestID: resumedID, LocalWorkspace: local,
	}
	if mask != nil {
		cp := *mask
		in.Mask = &cp
	}
	return in
}

func MergePollPolicy(base, override PollPolicy) PollPolicy {
	out := base
	if override.InitialDelay > 0 {
		out.InitialDelay = override.InitialDelay
	}
	if override.Interval > 0 {
		out.Interval = override.Interval
	}
	if override.MaxNotFoundMisses > 0 {
		out.MaxNotFoundMisses = override.MaxNotFoundMisses
	}
	if override.MaxMalformedResponses > 0 {
		out.MaxMalformedResponses = override.MaxMalformedResponses
	}
	if override.MaxDownloadTries > 0 {
		out.MaxDownloadTries = override.MaxDownloadTries
	}
	if override.RetryTransient {
		out.RetryTransient = true
	}
	return out
}

func (c *Client) PostJSONTarget(ctx context.Context, config Config, endpoint string, body any, target *map[string]any) error {
	result, err := c.PostJSON(ctx, config, endpoint, "", body)
	if err == nil && target != nil {
		*target = result
	}
	return err
}

func FenceSubmission(ctx context.Context, receipt ReceiptConfig, input Input, err error, mapUncertain func(error) (error, bool)) (error, bool) {
	if err == nil {
		return nil, false
	}
	var accepted AcceptedNotRecorded
	if errors.As(err, &accepted) {
		if requestID := strings.TrimSpace(accepted.RequestID); requestID != "" {
			stage := strings.TrimSpace(accepted.Stage)
			if stage == "" {
				stage = "submitted"
			}
			_ = RecordAcceptedState(ctx, receipt, requestID, stage, nil)
		}
		return err, true
	}
	if strings.TrimSpace(input.ResumedRequestID) != "" {
		return err, false
	}
	var uncertain CreateUncertain
	if !errors.As(err, &uncertain) {
		return err, false
	}
	if mapped, keep := mapUncertain(err); keep {
		return mapped, false
	}
	return err, true
}
