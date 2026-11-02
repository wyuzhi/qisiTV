package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
)

type providerAnalyticsKey = generation.AnalyticsKey
type providerAnalyticsContext = generation.AnalyticsContext
type styleExecutionPlanDocument = generation.StyleExecutionPlanDocument

func withProviderAnalytics(ctx context.Context, service *Service, task model.Task) context.Context {
	metadata := generation.TaskAnalyticsContext(task)
	ctx = context.WithValue(ctx, providerAnalyticsKey{}, metadata)
	return service.bindGenerationRuntime(ctx, metadata)
}

func resumedProviderRequestID(ctx context.Context) string {
	return generation.ResumedProviderRequestIDFromAnalytics(ctx)
}

func withProviderRequestKind(ctx context.Context, requestKind string) context.Context {
	return generation.WithProviderRequestKind(ctx, requestKind)
}

func canonicalCallMeta(ctx context.Context) generation.CallMeta {
	return generation.CanonicalCallMeta(ctx)
}

func newProviderPayloadError(raw string) providerPayloadError {
	return generation.NewPayloadError(raw, providerPayloadErrorMessage(raw))
}

func providerUserFacingErrorMessage(err error) string {
	if err == nil {
		return generation.ClassifyError(nil).UserMessage()
	}
	return classifyTaskFailure(err).UserMessage()
}

func providerPayloadErrorCategory(raw string) (string, bool) {
	failure := generation.ClassifyText(raw)
	if failure.Category == generation.CategoryUnknown {
		return "", false
	}
	return failure.UserMessage(), true
}

func providerPayloadErrorMessage(raw string) string {
	return generation.ClassifyText(raw).UserMessage()
}

func (s *Service) processCanvasGenerationTask(ctx context.Context, userID string, taskProjectID string, taskType string, fallbackPrompt string, rawInput string) (map[string]interface{}, error) {
	ctx = withProtocolRegistry(ctx, s.protocolRegistry())
	var input canvasGenerationInput
	defer func() { recordTaskDiagnosticInput(ctx, input) }()
	if err := json.Unmarshal([]byte(rawInput), &input); err != nil {
		return nil, fmt.Errorf("任务输入解析失败：%w", err)
	}
	ctx = s.enrichGenerationRuntime(ctx, generation.CallMeta{UserID: userID, TaskID: taskExecutionID(ctx), ProjectID: taskProjectID, TaskType: taskType})
	if strings.TrimSpace(input.Prompt) == "" {
		input.Prompt = fallbackPrompt
	}
	if input.Mode == "" && strings.HasPrefix(taskType, "video_") {
		input.Mode = "video"
	}
	if input.Mode == "text" && strings.HasPrefix(taskType, "canvas_text") && input.AgentRequests == nil {
		textPublisher := newTaskTextStreamPublisher(s, userID, taskExecutionID(ctx))
		input.OnTextDelta = textPublisher.Publish
		defer textPublisher.Close()
	}
	return generation.Execute(ctx, input)
}

func providerMediaHydrationPolicyFor(ctx context.Context, input canvasGenerationInput) providerMediaHydrationPolicy {
	return generation.MediaHydrationPolicyFor(ctx, input)
}

func providerPrefersMediaURLs(interfaceType string, input canvasGenerationInput) bool {
	return generation.PrefersMediaURLs(interfaceType, input)
}

func (s *Service) applyGenerationStyleProfile(userID string, taskProjectID string, input *canvasGenerationInput) error {
	return generation.ApplyGenerationStyleProfile(s.repo, userID, taskProjectID, input)
}

func equivalentStyleProfileJSON(left string, right string) (bool, error) {
	return generation.EquivalentStyleProfileJSON(left, right)
}

func resolveGenerationStyleExecution(profile styleProfileDocument, generationModel string, interfaceType string) (string, string, []string) {
	return generation.ResolveGenerationStyleExecution(profile, generationModel, interfaceType)
}

func (s *Service) validateResolvedImageCapability(input *canvasGenerationInput) error {
	return generation.ValidateResolvedImageCapability(s.repo, s.ReadLocalModelConfig, input)
}

func (s *Service) resolveImageCapability(input *canvasGenerationInput) error {
	return generation.ResolveImageCapability(s.repo, s.ReadLocalModelConfig, input)
}

func (s *Service) hydrateVideoReferenceMetadata(ctx context.Context, userID string, input *canvasGenerationInput) error {
	ctx = s.enrichGenerationRuntime(ctx, generation.CallMeta{UserID: userID})
	return generation.HydrateVideoReferenceMetadata(ctx, userID, input)
}

func applySeedance2VideoProbe(config providerConfig, index int, media *providerMedia, data []byte) error {
	return generation.ApplySeedance2VideoProbe(config, index, media, data)
}

func (s *Service) hydrateGenerationMedia(userID string, input *canvasGenerationInput, policy providerMediaHydrationPolicy) error {
	return s.hydrateGenerationMediaWithContext(context.Background(), userID, input, policy)
}

func (s *Service) hydrateGenerationMediaWithContext(ctx context.Context, userID string, input *canvasGenerationInput, policy providerMediaHydrationPolicy) error {
	ctx = s.enrichGenerationRuntime(ctx, generation.CallMeta{UserID: userID})
	return generation.HydrateMedia(ctx, userID, input, policy)
}

func (s *Service) hydrateProviderMedia(userID string, media *providerMedia, policy providerMediaHydrationPolicy) error {
	ctx := s.enrichGenerationRuntime(context.Background(), generation.CallMeta{UserID: userID})
	return generation.HydrateOne(ctx, userID, media, policy)
}

func resourceUsesObjectStorage(resource *model.Resource) bool {
	if resource == nil {
		return false
	}
	return (generation.ResourceInfo{Provider: resource.Provider}).UsesObjectStorage()
}

func (s *Service) resolveProviderConfig(config providerConfig) (providerConfig, error) {
	if err := s.requireActiveProvider(config.InterfaceType, config.BaseURL); err != nil {
		return providerConfig{}, err
	}
	return generation.ResolveProviderConfig(s.repo, s.IsLocalMode(), s.SystemChannel, config)
}

func providerChannelModelKey(config providerConfig) string {
	return generation.ProviderChannelModelKey(config)
}

func systemChannelIDFromBaseURL(baseURL string) string {
	return modelcatalog.SystemChannelIDFromBaseURL(baseURL)
}

func firstNonEmptyString(values ...string) string {
	return kernel.FirstNonEmpty(values...)
}

func dataURL(mimeType string, data []byte) string {
	return generation.DataURL(mimeType, data)
}

func stringField(payload map[string]interface{}, key string) string {
	value, err := optionalJSONString(payload, key)
	if err != nil {
		return ""
	}
	return value
}

func withSystemPrompt(config providerConfig, prompt string) string {
	return generation.WithSystemPrompt(config, prompt)
}
