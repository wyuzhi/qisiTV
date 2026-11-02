package app

import (
	"context"
	"errors"
	"time"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/provider/workflow"
)

type RunningHubWorkflowFetchRequest = workflow.FetchRequest

func isRunningHubInterface(value string) bool {
	pluginID, ok := workflowPluginIDForInterface(value)
	return ok && pluginID == WorkflowPluginRunningHub
}
func isWorkflowProviderInterface(value string) bool { return isRunningHubInterface(value) }
func validateWorkflowProviderConfig(mode string, config providerConfig) error {
	return mapOutboundError(workflow.ValidateConfig(mode, workflowConfigFromProvider(config)))
}
func (s *Service) runWorkflowProviderTask(ctx context.Context, input canvasGenerationInput) (map[string]any, error) {
	if isRunningHubInterface(input.Config.InterfaceType) {
		return s.runRunningHubWorkflow(ctx, input)
	}
	return nil, errors.New("未知工作流协议")
}
func (s *Service) recordWorkflowProviderRequest(ctx context.Context, requestID, stage string, nextPollAt *time.Time) error {
	return workflow.RecordAcceptedState(ctx, s.workflowReceiptConfig(), requestID, stage, nextPollAt)
}
func (s *Service) runRunningHubWorkflow(ctx context.Context, input canvasGenerationInput) (map[string]any, error) {
	converted := s.workflowInputFromCanvas(ctx, input)
	result, err := s.workflowClient(nil).Run(ctx, converted)
	return result, s.fenceWorkflowSubmission(ctx, converted, err)
}
func (s *Service) fenceWorkflowSubmission(ctx context.Context, input workflow.Input, err error) error {
	out, wrapUnknown := workflow.FenceSubmission(ctx, s.workflowReceiptConfig(), input, err, func(cause error) (error, bool) {
		mapped := uncertainVideoSubmission(ctx, cause)
		var notSent generation.RequestNotSentError
		var unknown providerSubmissionUnknownError
		var circuit providerCircuitOpenError
		return mapped, errors.As(mapped, &notSent) || errors.As(mapped, &unknown) || errors.Is(mapped, context.Canceled) || safeRouteRejection(mapped) || errors.As(mapped, &circuit)
	})
	if wrapUnknown {
		return providerSubmissionUnknownError{Cause: out}
	}
	return out
}
func (s *Service) uploadRunningHubMedia(ctx context.Context, root string, config providerConfig, media providerMedia) (string, error) {
	return s.workflowClient(nil).UploadMedia(ctx, root, workflowConfigFromProvider(config), workflowMedia(media), s.IsLocalMode())
}
func (s *Service) runningHubJSON(ctx context.Context, config providerConfig, endpoint string, body any, target *map[string]any) error {
	return s.workflowClient(nil).PostJSONTarget(ctx, workflowConfigFromProvider(config), endpoint, body, target)
}
func (s *Service) pollRunningHubWorkflow(ctx context.Context, config providerConfig, root, taskID, mode string) (map[string]any, error) {
	return s.workflowClient(nil).Poll(ctx, workflowConfigFromProvider(config), root, taskID, mode)
}
func (s *Service) pollRunningHubVideoWorkflowWithPolicy(ctx context.Context, config providerConfig, root, taskID string, policy videoPollPolicy) (map[string]any, error) {
	return s.workflowClient(&policy).PollVideo(ctx, workflowConfigFromProvider(config), root, taskID, toWorkflowPollPolicy(policy))
}
func runningHubRootURL(value string) string                    { return workflow.RootURL(value) }
func runningHubAPIKey(config providerConfig) string            { return workflow.APIKey(workflowConfigFromProvider(config)) }
func runningHubPayloadCode(payload map[string]any) (int, bool) { return workflow.PayloadCode(payload) }
func runningHubFailureMessage(payload map[string]any) string   { return workflow.FailureMessage(payload) }
