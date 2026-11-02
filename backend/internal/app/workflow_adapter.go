package app

import (
	"context"
	"errors"
	"time"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/provider/workflow"
)

func (s *Service) workflowReceiptConfig() workflow.ReceiptConfig {
	return workflow.ReceiptConfig{
		HasService: s != nil, HasRepo: s != nil && s.repo != nil,
		TaskIdentity:     func(ctx context.Context) (string, string, bool) { m, ok := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext); return m.UserID, m.TaskID, ok },
		CheckTaskForUser: func(u, id string) error { _, err := s.repo.TaskForUser(u, id); return err },
		UpdateTaskState:  func(id, reqID, stage string, next *time.Time) error { return s.repo.UpdateTaskProviderState(id, reqID, stage, next) },
	}
}
func (s *Service) workflowClient(policy *videoPollPolicy) *workflow.Client {
	var override *workflow.PollPolicy
	if policy != nil {
		p := toWorkflowPollPolicy(*policy)
		override = &p
	}
	return workflow.NewClient(workflow.AdapterConfig{
		WithRequestKind: withProviderRequestKind, DoBinary: doBinary,
		HTTPStatus:      func(err error) (int, string, bool) { var e providerHTTPError; ok := errors.As(err, &e); return e.StatusCode, e.Body, ok },
		NewHTTPError:    func(code int, body string) error { return providerHTTPError{StatusCode: code, Body: body} },
		LoadMedia:       func(m workflow.Media) ([]byte, string, error) { return mediaBytes(providerMedia{ID: m.ID, Name: m.Name, Type: m.Type, DataURL: m.DataURL, URL: m.URL, MimeType: m.MimeType}) },
		Receipt:         s.workflowReceiptConfig(),
		LogProgress:     func(ctx context.Context, level, msg, payload string) { if s != nil { m, _ := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext); _ = s.log(m.UserID, m.TaskID, level, msg, payload) } },
		EnsurePlugin:    func(iface string) error { return s.RequireWorkflowPluginForInterface(iface) },
		Sleep:           sleepContext, PollDeadline: providerPollingDeadline,
		DefaultPolicy:   toWorkflowPollPolicy(defaultVideoPollPolicy()), OverridePolicy: override,
		PollVideo:       func(ctx context.Context, taskID string, p workflow.PollPolicy, q func(context.Context) (workflow.PollOutcome, error)) (map[string]any, error) { return runVideoPollLoop(ctx, taskID, fromWorkflowPollPolicy(p), func(ctx context.Context) (videoPollOutcome, error) { out, err := q(ctx); return videoPollOutcome{Done: out.Done, Result: out.Result}, err }) },
		DownloadVideo:   downloadWorkflowVideo,
	})
}
func downloadWorkflowVideo(ctx context.Context, taskID string, p workflow.PollPolicy, src workflow.BinarySource, renew func(context.Context) (workflow.BinarySource, error)) ([]byte, string, error) {
	var resolve func(context.Context) (generation.VideoResultSource, error)
	if renew != nil {
		resolve = func(ctx context.Context) (generation.VideoResultSource, error) { f, err := renew(ctx); return generation.VideoResultSource{URL: f.URL, Read: f.Read, CredentialValues: f.CredentialValues}, err }
	}
	dl := generation.VideoResultDownloader(providerConfig{BaseURL: src.ProviderURL}, taskID, generation.VideoResultSource{URL: src.URL, Read: src.Read, CredentialValues: src.CredentialValues}, resolve)
	data, mime, err := runVideoDownload(ctx, taskID, fromWorkflowPollPolicy(p), dl)
	return data, generation.NormalizedMediaMIMEType(mime, data), err
}
func workflowConfigFromProvider(c providerConfig) workflow.Config {
	return workflow.Config{InterfaceType: c.InterfaceType, BaseURL: c.BaseURL, APIKey: c.APIKey, Headers: c.Headers, Model: c.Model, Size: c.Size, Quality: c.Quality, TransparentBackground: c.TransparentBackground, Count: c.Count, VideoSeconds: c.VideoSeconds, VQuality: c.VQuality, VideoGenerateAudio: c.VideoGenerateAudio, VideoWatermark: c.VideoWatermark, AudioVoice: c.AudioVoice, AudioFormat: c.AudioFormat, AudioSpeed: c.AudioSpeed, AudioInstructions: c.AudioInstructions, SystemPrompt: c.SystemPrompt, WorkflowID: c.WorkflowID, WebappID: c.WebappID, WorkflowJSON: c.WorkflowJSON, WorkflowFields: c.WorkflowFields, RunningHubUploadKey: c.RunningHubUploadKey}
}
func (s *Service) workflowInputFromCanvas(ctx context.Context, in canvasGenerationInput) workflow.Input {
	var mask *workflow.Media
	if in.Mask != nil {
		m := workflowMedia(*in.Mask)
		mask = &m
	}
	return workflow.NewInput(in.Mode, in.Prompt, workflowConfigFromProvider(in.Config), workflowMediaList(in.ReferenceImages), workflowMediaList(in.ReferenceVideos), workflowMediaList(in.ReferenceAudios), mask, resumedProviderRequestID(ctx), s.IsLocalMode())
}
func workflowMediaList(items []providerMedia) []workflow.Media { return workflow.MapMedia(items, workflowMedia) }
func workflowMedia(m providerMedia) workflow.Media             { return workflow.Media{ID: m.ID, Name: m.Name, Type: m.Type, DataURL: m.DataURL, URL: m.URL, MimeType: m.MimeType} }
func toWorkflowPollPolicy(p videoPollPolicy) workflow.PollPolicy { return workflow.PollPolicy{InitialDelay: p.InitialDelay, Interval: p.Interval, MaxNotFoundMisses: p.MaxNotFoundMisses, MaxMalformedResponses: p.MaxMalformedResponses, MaxDownloadTries: p.MaxDownloadTries, RetryTransient: p.RetryTransient} }
func fromWorkflowPollPolicy(p workflow.PollPolicy) videoPollPolicy { return videoPollPolicy{InitialDelay: p.InitialDelay, Interval: p.Interval, MaxNotFoundMisses: p.MaxNotFoundMisses, MaxMalformedResponses: p.MaxMalformedResponses, MaxDownloadTries: p.MaxDownloadTries, RetryTransient: p.RetryTransient} }

type workflowRequestExecutor struct{}
type workflowPlugins struct{ service *Service }
type workflowReceipt struct{ service *Service }

func (workflowRequestExecutor) Execute(ctx context.Context, req workflow.Request) ([]byte, string, error)            { return (*Service)(nil).workflowClient(nil).Requests.Execute(ctx, req) }
func (p workflowPlugins) EnsureEnabled(ctx context.Context, iface string) error                                      { return p.service.workflowClient(nil).Plugins.EnsureEnabled(ctx, iface) }
func (r workflowReceipt) Ready(ctx context.Context) error                                                            { return r.service.workflowClient(nil).Receipt.Ready(ctx) }
func (r workflowReceipt) RecordAccepted(ctx context.Context, id, stage string, next *time.Time) error                { return r.service.workflowClient(nil).Receipt.RecordAccepted(ctx, id, stage, next) }
