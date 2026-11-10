package protocol

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type ManifestOperation struct {
	DefaultPathPrefix   string             `json:"defaultPathPrefix,omitempty"`
	Method              string             `json:"method"`
	Path                string             `json:"path"`
	PathTemplate        any                `json:"pathTemplate,omitempty"`
	OriginPath          bool               `json:"originPath,omitempty"`
	ContentType         string             `json:"contentType,omitempty"`
	ContentTypeTemplate any                `json:"contentTypeTemplate,omitempty"`
	Headers             map[string]any     `json:"headers,omitempty"`
	Query               map[string]any     `json:"query,omitempty"`
	Body                any                `json:"body,omitempty"`
	Fields              map[string]string  `json:"fields,omitempty"`
	Files               []ManifestFilePart `json:"files,omitempty"`
}

type ManifestFilePart struct {
	Name     string `json:"name"`
	Source   any    `json:"source"`
	Filename any    `json:"filename,omitempty"`
	MIMEType any    `json:"mimeType,omitempty"`
}

type ManifestResponse struct {
	Stream          *ManifestImageStream `json:"stream,omitempty"`
	DetectImageMIME bool                 `json:"detectImageMime,omitempty"`
	TaskIDPaths     []string             `json:"taskIdPaths,omitempty"`
	StatusPaths     []string             `json:"statusPaths,omitempty"`
	ErrorPaths      []string             `json:"errorPaths,omitempty"`
	MessagePaths    []string             `json:"messagePaths,omitempty"`
	TextPaths       []string             `json:"textPaths,omitempty"`
	ReasoningPaths  []string             `json:"reasoningPaths,omitempty"`
	ResultURLPaths  []string             `json:"resultUrlPaths,omitempty"`
	ResultPaths     []string             `json:"resultPaths,omitempty"`
	ResultKind      string               `json:"resultKind,omitempty"`
	ResultEphemeral bool                 `json:"resultEphemeral,omitempty"`
	// BinaryPayload 表示 create 同步返回二进制媒体（如 /audio/speech 的音频流）。
	// 声明式解析会把整个响应体包装为对应能力的单个媒体结果，不做 JSON 路径提取。
	BinaryPayload bool `json:"binaryPayload,omitempty"`
	TaskID        any  `json:"taskId,omitempty"`
	Status        any  `json:"status,omitempty"`
	Message       any  `json:"message,omitempty"`
	Text          any  `json:"text,omitempty"`
	Reasoning     any  `json:"reasoning,omitempty"`
	Images        any  `json:"images,omitempty"`
	Videos        any  `json:"videos,omitempty"`
	Audios        any  `json:"audios,omitempty"`
	Usage         any  `json:"usage,omitempty"`
	// SuccessCodes 声明协议自己的业务成功码：命中的 errorPaths 值不再算失败。
	// 只有显式声明该字段的协议生效（即梦 CV 接口用 code=10000 表示成功），
	// 未声明的协议继续沿用共享的「零值即成功」规则。
	SuccessCodes []any `json:"successCodes,omitempty"`
}

// ManifestAgentResponse describes the provider response shape for a
// tool-capable text request. Tool call paths are resolved against each item in
// ToolCallsPath.
type ManifestAgentResponse struct {
	TextPaths              []string `json:"textPaths,omitempty"`
	ReasoningPaths         []string `json:"reasoningPaths,omitempty"`
	ToolCallsPath          string   `json:"toolCallsPath,omitempty"`
	ToolCallIDPaths        []string `json:"toolCallIdPaths,omitempty"`
	ToolCallNamePaths      []string `json:"toolCallNamePaths,omitempty"`
	ToolCallArgsPaths      []string `json:"toolCallArgumentsPaths,omitempty"`
	ToolCallSignaturePaths []string `json:"toolCallThoughtSignaturePaths,omitempty"`
}

func LoadInstalledPlugin(data []byte) (Adapter, error) {
	adapters, err := LoadInstalledProviders(data)
	if err != nil {
		return nil, err
	}
	if len(adapters) == 0 {
		return nil, fmt.Errorf("plugin does not provide an executable provider")
	}
	return adapters[0], nil
}

// LoadInstalledProviders loads every provider contribution from one plugin
// package. The package remains the lifecycle and permission unit; providers
// are separate execution entries in the runtime index.
func LoadInstalledProviders(data []byte) ([]Adapter, error) {
	manifest, err := decodeManifest(data)
	if err != nil {
		return nil, err
	}
	if len(manifest.Contributes.Providers) == 0 {
		adapter, err := loadDeclarativeManifest(manifest)
		if err != nil {
			return nil, err
		}
		return []Adapter{adapter}, nil
	}
	result := make([]Adapter, 0, len(manifest.Contributes.Providers))
	for index := range manifest.Contributes.Providers {
		adapter, err := loadDeclarativeManifestProvider(manifest, index)
		if err != nil {
			return nil, err
		}
		result = append(result, adapter)
	}
	return result, nil
}

func validatePluginMetadata(metadata Metadata) error {
	if strings.TrimSpace(metadata.ID) == "" || strings.TrimSpace(metadata.Version) == "" || !validManifestIdentifier(metadata.ID) {
		return fmt.Errorf("protocol plugin metadata is invalid")
	}
	if len(metadata.Categories) == 0 || len(metadata.Scopes) == 0 {
		return fmt.Errorf("protocol plugin metadata requires categories and scopes")
	}
	for _, capability := range metadata.Categories {
		if capability != CapabilityText && capability != CapabilityImage && capability != CapabilityVideo && capability != CapabilityAudio {
			return fmt.Errorf("unsupported protocol capability %q", capability)
		}
	}
	for _, scope := range metadata.Scopes {
		switch scope {
		case SurfaceAdminSystemChannel, SurfaceUserCustomChannel, SurfaceCanvas, SurfaceCreation, SurfaceAgent:
		default:
			return fmt.Errorf("unsupported protocol scope %q", scope)
		}
	}
	return nil
}

type metadataAdapter struct {
	metadata Metadata
	delegate Adapter
}

func (a metadataAdapter) Metadata() Metadata { return a.metadata }
func (a metadataAdapter) MediaAuth() ManifestAuth {
	if adapter, ok := a.delegate.(MediaAuthAdapter); ok {
		return adapter.MediaAuth()
	}
	return ManifestAuth{}
}
func (a metadataAdapter) AgentAvailable() bool {
	capability, ok := a.delegate.(AgentCapability)
	return ok && capability.AgentAvailable()
}
func (a metadataAdapter) ResultAvailable() bool {
	capability, ok := a.delegate.(ResultCapability)
	return ok && capability.ResultAvailable()
}
func (a metadataAdapter) BuildCreate(ctx context.Context, c RequestContext) (RequestSpec, error) {
	return a.delegate.BuildCreate(ctx, c)
}
func (a metadataAdapter) ParseCreate(ctx context.Context, body []byte) (CreateResult, error) {
	return a.delegate.ParseCreate(ctx, body)
}
func (a metadataAdapter) BuildPoll(ctx context.Context, c PollContext) (RequestSpec, error) {
	return a.delegate.BuildPoll(ctx, c)
}
func (a metadataAdapter) ParsePoll(ctx context.Context, c PollContext, body []byte) (PollResult, error) {
	return a.delegate.ParsePoll(ctx, c, body)
}
func (a metadataAdapter) BuildCancel(ctx context.Context, c PollContext) (RequestSpec, error) {
	return a.delegate.BuildCancel(ctx, c)
}
func (a metadataAdapter) BuildResult(ctx context.Context, c PollContext) (RequestSpec, error) {
	adapter, ok := a.delegate.(ResultAdapter)
	if !ok {
		return RequestSpec{}, unavailable(a.metadata)
	}
	return adapter.BuildResult(ctx, c)
}
func (a metadataAdapter) BuildAgent(ctx context.Context, c AgentRequestContext) (RequestSpec, error) {
	adapter, ok := a.delegate.(AgentAdapter)
	if !ok {
		return RequestSpec{}, unavailable(a.metadata)
	}
	return adapter.BuildAgent(ctx, c)
}
func (a metadataAdapter) ParseAgent(ctx context.Context, body []byte) (AgentResult, error) {
	adapter, ok := a.delegate.(AgentAdapter)
	if !ok {
		return AgentResult{}, unavailable(a.metadata)
	}
	return adapter.ParseAgent(ctx, body)
}

func LoadManifest(data []byte) (Adapter, error) {
	manifest, err := decodeManifest(data)
	if err != nil {
		return nil, err
	}
	return loadDeclarativeManifest(manifest)
}

func decodeManifest(data []byte) (Manifest, error) {
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode plugin manifest: %w", err)
	}
	if err := ValidateManifest(manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func loadDeclarativeManifest(manifest Manifest) (Adapter, error) {
	manifest.Runtime.Backend = "declarative"
	if err := normalizeManifest(&manifest); err != nil {
		return nil, err
	}
	return manifestAdapter{manifest: manifest}, nil
}

func loadDeclarativeManifestProvider(manifest Manifest, index int) (Adapter, error) {
	pluginID := manifest.Metadata.ID
	module := strings.TrimSpace(manifest.Contributes.Providers[index].Module)
	manifest.Runtime.Backend = "declarative"
	if module != "" {
		manifest.Runtime.Backend = ExecutionModule
	}
	if err := normalizeManifestForProvider(&manifest, index); err != nil {
		return nil, err
	}
	if module != "" {
		return ModuleProvider{Info: manifest.Metadata, Plugin: pluginID, Module: module, Auth: manifest.Auth}, nil
	}
	return manifestAdapter{manifest: manifest}, nil
}

func ValidateManifest(manifest Manifest) error {
	if version := strings.TrimSpace(manifest.APIVersion); version != "beeftv.plugin/v1" && version != "beeftv.plugin/v2" && version != "beeftv.plugin/v3" {
		return fmt.Errorf("unsupported protocol manifest apiVersion %q", manifest.APIVersion)
	}
	if strings.TrimSpace(manifest.Metadata.ID) == "" || strings.TrimSpace(manifest.Metadata.Version) == "" {
		return fmt.Errorf("protocol manifest metadata requires id and version")
	}
	if strings.TrimSpace(manifest.Metadata.Name) == "" {
		return fmt.Errorf("protocol manifest metadata requires name")
	}
	if !validManifestIdentifier(manifest.Metadata.ID) {
		return fmt.Errorf("protocol manifest metadata id is invalid")
	}
	if len(manifest.Metadata.Name) > 160 || len(manifest.Metadata.Vendor) > 120 {
		return fmt.Errorf("protocol manifest metadata name or vendor is too long")
	}
	if len(manifest.Contributes.Providers) == 0 && !hasNonProviderContribution(manifest.Contributes) && strings.TrimSpace(manifest.Client) == "" {
		return fmt.Errorf("plugin must declare at least one contribution")
	}
	if err := validateManifestPackageExtensions(manifest); err != nil {
		return err
	}
	if backend := strings.TrimSpace(manifest.Runtime.Backend); backend != "" && backend != "declarative" {
		return fmt.Errorf("unsupported plugin backend %q", backend)
	}
	if len(manifest.Contributes.Providers) == 0 {
		return nil
	}
	providerIDs := make(map[string]struct{}, len(manifest.Contributes.Providers))
	for index, provider := range manifest.Contributes.Providers {
		if strings.TrimSpace(provider.ID) == "" || strings.TrimSpace(provider.Label) == "" || !validManifestIdentifier(provider.ID) {
			return fmt.Errorf("provider contribution %d requires a valid id and label", index)
		}
		if _, exists := providerIDs[provider.ID]; exists {
			return fmt.Errorf("duplicate provider contribution %q", provider.ID)
		}
		providerIDs[provider.ID] = struct{}{}
		if err := validateProviderRenames(provider, providerIDs); err != nil {
			return err
		}
		if err := validateProviderSurface(provider); err != nil {
			return err
		}
		if strings.TrimSpace(provider.Module) != "" {
			if err := validateModuleProvider(provider); err != nil {
				return fmt.Errorf("provider %q: %w", provider.ID, err)
			}
			continue
		}
		requiresV3 := len(provider.Variables) > 0 || provider.Response.Stream != nil || provider.Response.DetectImageMIME || provider.MediaUpload != nil
		for _, operation := range []*ManifestOperation{&provider.Create, provider.Poll, provider.Cancel, provider.Result, provider.Agent} {
			requiresV3 = requiresV3 || (operation != nil && operation.DefaultPathPrefix != "")
		}
		if strings.TrimSpace(manifest.APIVersion) != "beeftv.plugin/v3" && requiresV3 {
			return fmt.Errorf("provider %q requires beeftv.plugin/v3 for variables, defaultPathPrefix or image response extensions", provider.ID)
		}
		if provider.MediaUpload != nil {
			if err := validateManifestMediaUpload(*provider.MediaUpload, provider.BaseURL); err != nil {
				return fmt.Errorf("provider %q mediaUpload: %w", provider.ID, err)
			}
		}
		var expressions []any
		for _, operation := range []*ManifestOperation{&provider.Create, provider.Poll, provider.Cancel, provider.Result, provider.Agent} {
			if operation != nil {
				expressions = append(expressions, operation.Body)
			}
		}
		for _, rule := range provider.Validations {
			expressions = append(expressions, rule.Assert)
		}
		if err := validateManifestVariables(provider.Variables, expressions...); err != nil {
			return fmt.Errorf("provider %q: %w", provider.ID, err)
		}
		if stream := provider.Response.Stream; stream != nil {
			if strings.TrimSpace(stream.TypePath) == "" || len(stream.ItemEvents) == 0 || stream.Images == nil || provider.Response.BinaryPayload {
				return fmt.Errorf("provider %q image stream requires typePath, itemEvents and images, without binaryPayload", provider.ID)
			}
		}
		if err := validateManifestOperation(provider.Create); err != nil {
			return fmt.Errorf("provider %q create operation: %w", provider.ID, err)
		}
		if provider.Agent != nil {
			if err := validateManifestOperation(*provider.Agent); err != nil {
				return fmt.Errorf("provider %q agent operation: %w", provider.ID, err)
			}
			if provider.AgentResponse == nil {
				return fmt.Errorf("provider %q agent response mapping is required when agent operation is declared", provider.ID)
			}
		}
		if provider.Poll != nil {
			if err := validateManifestOperation(*provider.Poll); err != nil {
				return fmt.Errorf("provider %q poll operation: %w", provider.ID, err)
			}
		}
		if provider.Cancel != nil {
			if err := validateManifestOperation(*provider.Cancel); err != nil {
				return fmt.Errorf("provider %q cancel operation: %w", provider.ID, err)
			}
		}
		if provider.Result != nil {
			if err := validateManifestOperation(*provider.Result); err != nil {
				return fmt.Errorf("provider %q result operation: %w", provider.ID, err)
			}
		}
		for ruleIndex, rule := range provider.Validations {
			if rule.Assert == nil || strings.TrimSpace(rule.Message) == "" {
				return fmt.Errorf("provider %q validation %d requires assert and message", provider.ID, ruleIndex)
			}
		}
	}
	return nil
}

func validateProviderSurface(provider ManifestProvider) error {
	if len(provider.Capabilities) == 0 || len(provider.Scopes) == 0 {
		return fmt.Errorf("provider contribution %q requires capabilities and scopes", provider.ID)
	}
	for _, capability := range provider.Capabilities {
		if capability != CapabilityText && capability != CapabilityImage && capability != CapabilityVideo && capability != CapabilityAudio {
			return fmt.Errorf("unsupported protocol capability %q", capability)
		}
	}
	for _, scope := range provider.Scopes {
		switch scope {
		case SurfaceAdminSystemChannel, SurfaceUserCustomChannel, SurfaceCanvas, SurfaceCreation, SurfaceAgent:
		default:
			return fmt.Errorf("unsupported protocol scope %q", scope)
		}
	}
	return nil
}

func normalizeManifest(manifest *Manifest) error {
	if manifest == nil {
		return fmt.Errorf("plugin manifest is missing")
	}
	if len(manifest.Contributes.Providers) == 0 {
		manifest.Metadata.Execution = manifest.Runtime.Backend
		return nil
	}
	return normalizeManifestForProvider(manifest, 0)
}

func normalizeManifestForProvider(manifest *Manifest, index int) error {
	if manifest == nil || index < 0 || index >= len(manifest.Contributes.Providers) {
		return fmt.Errorf("plugin provider contribution is missing")
	}
	provider := manifest.Contributes.Providers[index]
	// Released enterprise profiles used the package name as the protocol ID.
	// Keep those profiles on this installed adapter, including its disabled state.
	manifest.Metadata.LegacyAliases = providerLegacyAliases(manifest.Metadata.ID, provider)
	manifest.Metadata.ID = provider.ID
	manifest.Metadata.Categories = provider.Capabilities
	manifest.Metadata.Scopes = provider.Scopes
	manifest.Metadata.Parameters = provider.Parameters
	manifest.Metadata.Create = operationSummary(provider.Create)
	manifest.Metadata.Poll = operationSummaryPtr(provider.Poll)
	manifest.Metadata.Cancel = operationSummaryPtr(provider.Cancel)
	manifest.Metadata.ContentType = provider.Create.ContentType
	manifest.Metadata.BaseURL = strings.TrimSpace(provider.BaseURL)
	manifest.Metadata.RequiresPublicMediaURLs = provider.RequiresPublicMediaURLs
	for kind, transport := range provider.MediaTransport {
		if (kind != "image" && kind != "video" && kind != "audio") || (transport != "inline" && transport != "url") {
			return fmt.Errorf("invalid media transport %s: %s", kind, transport)
		}
	}
	manifest.Metadata.MediaTransport = provider.MediaTransport
	manifest.Metadata.MediaUpload = provider.MediaUpload
	manifest.Metadata.Execution = manifest.Runtime.Backend
	manifest.Create = provider.Create
	manifest.Agent = provider.Agent
	manifest.Poll = provider.Poll
	manifest.Cancel = provider.Cancel
	manifest.ResultOperation = provider.Result
	manifest.Response = provider.Response
	manifest.AgentResponse = provider.AgentResponse
	manifest.Auth = provider.Auth
	manifest.Validations = provider.Validations
	manifest.Variables = provider.Variables
	return nil
}

func hasNonProviderContribution(contributes ManifestContributions) bool {
	return len(contributes.Workflows) > 0 || len(contributes.CanvasNodes) > 0 || len(contributes.Skills) > 0 || len(contributes.Extensions) > 0
}

func operationSummary(operation ManifestOperation) string {
	path := strings.ReplaceAll(operation.Path, "{{model}}", "{model}")
	path = strings.ReplaceAll(path, "{{taskId}}", "{task_id}")
	return strings.ToUpper(operation.Method) + " " + path
}

func operationSummaryPtr(operation *ManifestOperation) string {
	if operation == nil {
		return ""
	}
	return operationSummary(*operation)
}

func validateManifestOperation(operation ManifestOperation) error {
	if prefix := operation.DefaultPathPrefix; prefix != "" && (!isRelativePath(prefix) || strings.Contains(prefix, "..") || strings.ContainsAny(prefix, "?#\\")) {
		return fmt.Errorf("invalid default path prefix")
	}
	method := strings.ToUpper(strings.TrimSpace(operation.Method))
	if method != http.MethodGet && method != http.MethodPost && method != http.MethodDelete && method != http.MethodPut {
		return fmt.Errorf("unsupported HTTP method %q", operation.Method)
	}
	if operation.PathTemplate == nil && !isRelativePath(operation.Path) {
		return fmt.Errorf("path must be relative: %q", operation.Path)
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(defaultValue(operation.ContentType, "application/json"), ";")[0]))
	switch contentType {
	case "application/json", "multipart/form-data", "application/x-www-form-urlencoded", "application/octet-stream", "":
	default:
		return fmt.Errorf("unsupported content type %q", operation.ContentType)
	}
	if len(operation.Files) > 0 && operation.ContentTypeTemplate == nil && contentType != "multipart/form-data" {
		return fmt.Errorf("file parts require multipart/form-data")
	}
	for _, file := range operation.Files {
		if strings.TrimSpace(file.Name) == "" || file.Source == nil {
			return fmt.Errorf("multipart file part requires name and source")
		}
	}
	return nil
}

type manifestAdapter struct{ manifest Manifest }

func (a manifestAdapter) Metadata() Metadata      { return a.manifest.Metadata }
func (a manifestAdapter) MediaAuth() ManifestAuth { return a.manifest.Auth }
func (a manifestAdapter) AgentAvailable() bool {
	return a.manifest.Agent != nil && a.manifest.AgentResponse != nil
}
func (a manifestAdapter) ResultAvailable() bool { return a.manifest.ResultOperation != nil }
func (a manifestAdapter) BuildCreate(_ context.Context, c RequestContext) (RequestSpec, error) {
	c.Request = applyManifestTaskOptions(a.manifest.Metadata.ID, c.Request)
	if len(a.manifest.Contributes.Providers) == 0 {
		return RequestSpec{}, fmt.Errorf("plugin %s does not provide a provider", a.manifest.Metadata.ID)
	}
	variables, err := manifestRequestVariables(a.manifest.Variables, c.Request)
	if err != nil {
		return RequestSpec{}, err
	}
	if err := validateManifestRequest(a.manifest.Validations, c.Request, variables); err != nil {
		return RequestSpec{}, err
	}
	spec, err := buildManifestOperation(a.manifest.Create, a.manifest.Auth, c.Request, "", variables)
	if err != nil {
		return RequestSpec{}, err
	}
	applyManifestBodyFields(a.manifest.Metadata.ID, &spec, c.Request)
	return spec, nil
}
func (a manifestAdapter) ParseCreate(_ context.Context, body []byte) (CreateResult, error) {
	if a.manifest.Response.BinaryPayload {
		return binaryPayloadCreateResult(a.manifest.Response.ResultKind, body)
	}
	payload, err := decodeObject(body)
	if err != nil {
		return CreateResult{}, err
	}
	result := a.parse(payload, PollContext{})
	if a.manifest.Response.DetectImageMIME {
		if err := detectInlineImageMIME(result.Result); err != nil {
			return CreateResult{}, err
		}
	}
	return result, nil
}

// binaryPayloadCreateResult 把同步二进制响应包装为单个媒体结果。MIME 以响应内容探测为准，
// 空响应必须失败，不能把空内容伪装成生成成功。
func binaryPayloadCreateResult(resultKind string, body []byte) (CreateResult, error) {
	if len(body) == 0 {
		return CreateResult{}, fmt.Errorf("binary payload response is empty")
	}
	mimeType := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(body), ";")[0]))
	reference := MediaReference{DataURL: "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(body), MIMEType: mimeType}
	result := &Result{}
	switch resultKind {
	case "audio":
		result.Audios = []MediaReference{reference}
	case "image":
		result.Images = []MediaReference{reference}
	case "video":
		result.Videos = []MediaReference{reference}
	default:
		return CreateResult{}, fmt.Errorf("binary payload response requires resultKind image, video or audio, got %q", resultKind)
	}
	return CreateResult{Status: StatusSucceeded, Result: result}, nil
}
func (a manifestAdapter) BuildPoll(_ context.Context, c PollContext) (RequestSpec, error) {
	if a.manifest.Poll == nil {
		return RequestSpec{}, fmt.Errorf("protocol %s has no poll operation", a.manifest.Metadata.ID)
	}
	request := c.Request
	request.Model = c.Model
	return a.buildOperation(*a.manifest.Poll, request, c.TaskID)
}
func (a manifestAdapter) ParsePoll(_ context.Context, c PollContext, body []byte) (PollResult, error) {
	payload, err := decodeObject(body)
	if err != nil {
		return PollResult{}, err
	}
	result := a.parse(payload, c)
	return PollResult{TaskID: result.TaskID, Status: result.Status, Result: result.Result, Message: result.Message}, nil
}
func (a manifestAdapter) BuildCancel(_ context.Context, c PollContext) (RequestSpec, error) {
	if a.manifest.Cancel == nil {
		return RequestSpec{}, fmt.Errorf("protocol %s does not support cancellation", a.manifest.Metadata.ID)
	}
	request := c.Request
	request.Model = c.Model
	return a.buildOperation(*a.manifest.Cancel, request, c.TaskID)
}

func (a manifestAdapter) BuildResult(_ context.Context, c PollContext) (RequestSpec, error) {
	if a.manifest.ResultOperation == nil {
		return RequestSpec{}, fmt.Errorf("protocol %s has no result operation", a.manifest.Metadata.ID)
	}
	request := c.Request
	request.Model = c.Model
	return a.buildOperation(*a.manifest.ResultOperation, request, c.TaskID)
}

func (a manifestAdapter) buildOperation(operation ManifestOperation, request GenerationRequest, taskID string) (RequestSpec, error) {
	variables, err := manifestRequestVariables(a.manifest.Variables, request)
	if err != nil {
		return RequestSpec{}, err
	}
	return buildManifestOperation(operation, a.manifest.Auth, request, taskID, variables)
}

func (a manifestAdapter) parse(payload map[string]any, c PollContext) CreateResult {
	response := a.manifest.Response
	env := map[string]any{"response": payload, "taskId": c.TaskID, "request": manifestRequestValues(c.Request)}
	id := manifestResponseString(response.TaskID, env)
	if id == "" {
		id = firstPathValue(payload, response.TaskIDPaths...)
	}
	if id == "" {
		id = c.TaskID
	}
	statusText := manifestResponseString(response.Status, env)
	if statusText == "" {
		statusText = firstPathValue(payload, response.StatusPaths...)
	}
	status := normalizeStatus(statusText)
	if status == "" {
		status = StatusPending
	}
	message := manifestResponseString(response.Message, env)
	if message == "" {
		message = firstPathValue(payload, response.MessagePaths...)
	}
	if manifestError(payload, response.ErrorPaths, response.SuccessCodes) {
		status = StatusFailed
	}
	result := &Result{
		Text:      manifestResponseString(response.Text, env),
		Reasoning: manifestResponseString(response.Reasoning, env),
	}
	if result.Text == "" {
		result.Text = firstPathValue(payload, response.TextPaths...)
	}
	if result.Reasoning == "" {
		result.Reasoning = firstPathValue(payload, response.ReasoningPaths...)
	}
	result.Images = manifestResponseMedia(response.Images, env, "image", response.ResultEphemeral)
	result.Videos = manifestResponseMedia(response.Videos, env, "video", response.ResultEphemeral)
	result.Audios = manifestResponseMedia(response.Audios, env, "audio", response.ResultEphemeral)
	// WhatsToken returns completed /v1/videos results as data[].url. Older
	// channel-1 manifests only declared the common top-level URL fields, so
	// accept this stable gateway shape without requiring a package migration.
	if a.manifest.Metadata.ID == "newapi-channel-1" && len(result.Videos) == 0 {
		for _, item := range arrayValue(payload["data"]) {
			if object, ok := item.(map[string]any); ok {
				if value := firstString(object, "url", "video_url", "videoUrl"); value != "" {
					result.Videos = append(result.Videos, MediaReference{URL: value, Kind: "video", Ephemeral: response.ResultEphemeral})
				}
			}
		}
	}
	if response.Usage != nil {
		if value, err := evaluateManifestValue(response.Usage, env); err == nil {
			result.Usage = manifestObject(value)
		}
	}
	paths := append([]string{}, a.manifest.Response.ResultURLPaths...)
	paths = append(paths, a.manifest.Response.ResultPaths...)
	for _, path := range paths {
		for _, value := range mediaPathValues(payload, path) {
			item := MediaReference{URL: value, Kind: a.manifest.Response.ResultKind, Ephemeral: a.manifest.Response.ResultEphemeral}
			switch a.manifest.Response.ResultKind {
			case "image":
				result.Images = append(result.Images, item)
			case "audio":
				result.Audios = append(result.Audios, item)
			default:
				result.Videos = append(result.Videos, item)
			}
		}
	}
	attachLastFrameMetadata(result.Videos, payload)
	if status == StatusPending && (result.Text != "" || len(result.Images) > 0 || len(result.Videos) > 0 || len(result.Audios) > 0) {
		status = StatusSucceeded
	}
	if result.Text == "" && result.Reasoning == "" && len(result.Images) == 0 && len(result.Videos) == 0 && len(result.Audios) == 0 {
		result = nil
	}
	return CreateResult{TaskID: id, Status: status, Result: result, Message: message}
}

var manifestVariableName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func validateManifestVariables(bindings []ManifestVariable, expressions ...any) error {
	known := map[string]bool{}
	var check func(any) error
	check = func(value any) error {
		switch value := value.(type) {
		case map[string]any:
			if ref, ok := value["$ref"].(string); ok && strings.HasPrefix(ref, "vars.") {
				name := strings.Split(strings.TrimPrefix(ref, "vars."), ".")[0]
				if !known[name] {
					return fmt.Errorf("unknown or forward provider variable %q", name)
				}
			}
			for _, child := range value {
				if err := check(child); err != nil {
					return err
				}
			}
		case []any:
			for _, child := range value {
				if err := check(child); err != nil {
					return err
				}
			}
		}
		return nil
	}
	for _, binding := range bindings {
		if !manifestVariableName.MatchString(binding.Name) || binding.Value == nil {
			return fmt.Errorf("provider variable requires a simple name and value")
		}
		if known[binding.Name] {
			return fmt.Errorf("duplicate provider variable %q", binding.Name)
		}
		if err := check(binding.Value); err != nil {
			return err
		}
		known[binding.Name] = true
	}
	for _, expression := range expressions {
		if err := check(expression); err != nil {
			return err
		}
	}
	return nil
}

func manifestRequestVariables(bindings []ManifestVariable, request GenerationRequest) (map[string]any, error) {
	values := map[string]any{}
	env := map[string]any{"request": manifestRequestValues(request), "vars": values}
	for _, binding := range bindings {
		if !manifestVariableName.MatchString(binding.Name) {
			return nil, fmt.Errorf("provider variable requires a simple name")
		}
		if _, exists := values[binding.Name]; exists {
			return nil, fmt.Errorf("duplicate provider variable %q", binding.Name)
		}
		value, err := evaluateManifestValue(binding.Value, env)
		if err != nil {
			return nil, fmt.Errorf("provider variable %s: %w", binding.Name, err)
		}
		values[binding.Name] = value
	}
	return values, nil
}

func validateManifestRequest(rules []ManifestValidation, request GenerationRequest, variables ...map[string]any) error {
	if draftTaskID, ok := request.Extra["draft_task_id"].(string); len(rules) == 0 || (ok && strings.TrimSpace(draftTaskID) != "") {
		return nil
	}
	env := map[string]any{"request": manifestRequestValues(request)}
	if len(variables) > 0 {
		env["vars"] = variables[0]
	}
	for _, rule := range rules {
		value, err := evaluateManifestValue(rule.Assert, env)
		if err != nil {
			return fmt.Errorf("协议参数校验表达式错误：%w", err)
		}
		if !manifestTruthy(value) {
			return fmt.Errorf("%s", strings.TrimSpace(rule.Message))
		}
	}
	return nil
}

func manifestResponseString(template any, env map[string]any) string {
	if template == nil {
		return ""
	}
	value, err := evaluateManifestValue(template, env)
	if err != nil {
		return ""
	}
	items := manifestArray(value)
	parts := make([]string, 0, len(items))
	for _, item := range items {
		if text := strings.TrimSpace(manifestString(item)); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "")
}

func manifestResponseMedia(template any, env map[string]any, kind string, ephemeral bool) []MediaReference {
	if template == nil {
		return nil
	}
	value, err := evaluateManifestValue(template, env)
	if err != nil {
		return nil
	}
	return mediaReferencesFromManifestValue(value, kind, ephemeral)
}

func mediaReferencesFromManifestValue(value any, kind string, ephemeral bool) []MediaReference {
	result := make([]MediaReference, 0)
	for _, item := range manifestArray(value) {
		switch typed := item.(type) {
		case string:
			trimmed := strings.TrimSpace(typed)
			if trimmed == "" {
				continue
			}
			reference := MediaReference{Kind: kind, Ephemeral: ephemeral}
			if strings.HasPrefix(trimmed, "data:") {
				reference.DataURL = trimmed
			} else {
				reference.URL = trimmed
			}
			result = append(result, reference)
		case map[string]any:
			if kind == "video" {
				if video, ok := typed["video"].(map[string]any); ok {
					typed = video
				}
			}
			reference := MediaReference{
				ID: manifestString(typed["id"]), URL: manifestString(typed["url"]), DataURL: manifestString(typed["dataUrl"]),
				Kind: defaultValue(manifestString(typed["kind"]), kind), Role: manifestString(typed["role"]), MIMEType: manifestString(typed["mimeType"]),
				Name: manifestString(typed["name"]), Order: manifestInt(typed["order"]), Weight: manifestFloat(typed["weight"]), Ephemeral: ephemeral || manifestTruthy(typed["ephemeral"]),
			}
			if metadata, ok := typed["metadata"].(map[string]any); ok {
				reference.Metadata = metadata
			}
			if reference.URL == "" {
				reference.URL = firstString(typed, "file_url", "fileUrl", "image_url", "imageUrl", "video_url", "videoUrl", "audio_url", "audioUrl", "uri")
			}
			if reference.DataURL == "" {
				reference.DataURL = firstString(typed, "data_url", "b64_json")
				if kind == "video" && reference.DataURL == "" {
					reference.DataURL = firstString(typed, "bytesBase64Encoded")
				}
			}
			// OpenAI / Ark 等渠道常直接返回裸 b64_json；声明式结果下载要求 data URL。
			reference.DataURL = normalizeManifestInlineDataURL(reference.DataURL, reference.Kind, firstString(typed, "output_format", "mime_type", "mimeType"))
			if reference.URL != "" || reference.DataURL != "" {
				result = append(result, reference)
			}
		}
	}
	return result
}

func normalizeManifestInlineDataURL(value, kind, formatHint string) string {
	value = strings.TrimSpace(value)
	if value == "" || strings.HasPrefix(value, "data:") {
		return value
	}
	return "data:" + manifestInlineMediaMIME(kind, formatHint) + ";base64," + value
}

func manifestInlineMediaMIME(kind, formatHint string) string {
	hint := strings.ToLower(strings.TrimSpace(formatHint))
	switch hint {
	case "image/png", "image/jpeg", "image/webp", "image/gif", "audio/mpeg", "audio/wav", "audio/ogg", "video/mp4", "video/webm":
		return hint
	case "image/jpg":
		return "image/jpeg"
	case "audio/mp3":
		return "audio/mpeg"
	case "png":
		return "image/png"
	case "jpeg", "jpg":
		return "image/jpeg"
	case "webp":
		return "image/webp"
	case "gif":
		return "image/gif"
	case "mp3", "mpeg":
		return "audio/mpeg"
	case "wav":
		return "audio/wav"
	case "mp4":
		return "video/mp4"
	case "webm":
		return "video/webm"
	}
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "audio":
		return "audio/mpeg"
	case "video":
		return "video/mp4"
	default:
		return "image/png"
	}
}

var (
	manifestMDImageRegex   = regexp.MustCompile(`!\[[^\]]*\]\(([^)\s]+)\)`)
	manifestHTMLVideoRegex = regexp.MustCompile(`(?i)<video[^>]+src=['"]([^'"]+)['"]`)
)

func mediaPathValues(payload map[string]any, path string) []string {
	value := pathValue(payload, path)
	if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
		trimmed := strings.TrimSpace(text)
		if matches := manifestMDImageRegex.FindAllStringSubmatch(trimmed, -1); len(matches) > 0 {
			var res []string
			for _, m := range matches {
				if len(m) > 1 && m[1] != "" {
					res = append(res, m[1])
				}
			}
			if len(res) > 0 {
				return res
			}
		}
		if matches := manifestHTMLVideoRegex.FindAllStringSubmatch(trimmed, -1); len(matches) > 0 {
			var res []string
			for _, m := range matches {
				if len(m) > 1 && m[1] != "" {
					res = append(res, m[1])
				}
			}
			if len(res) > 0 {
				return res
			}
		}
		return []string{trimmed}
	}
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		switch typed := item.(type) {
		case string:
			if strings.TrimSpace(typed) != "" {
				values = append(values, strings.TrimSpace(typed))
			}
		case map[string]any:
			if url := firstString(typed, "url", "file_url", "fileUrl", "video_url", "videoUrl", "image_url", "imageUrl"); url != "" {
				values = append(values, url)
			}
		}
	}
	return values
}

func buildManifestOperation(operation ManifestOperation, auth ManifestAuth, request GenerationRequest, taskID string, variables ...map[string]any) (RequestSpec, error) {
	requestValues := manifestRequestValues(request)
	env := map[string]any{"request": requestValues, "taskId": taskID}
	if len(variables) > 0 {
		env["vars"] = variables[0]
	}
	var body any
	if operation.Body != nil {
		value, err := evaluateManifestValue(operation.Body, env)
		if err != nil {
			return RequestSpec{}, fmt.Errorf("evaluate request body: %w", err)
		}
		body = normalizeManifestValue(value)
	} else if len(operation.Fields) > 0 {
		legacyBody := make(map[string]any, len(operation.Fields))
		for key, expression := range operation.Fields {
			value := manifestExpressionValue(expression, request, taskID)
			if value == nil {
				continue
			}
			setMapPath(legacyBody, key, value)
		}
		body = normalizeManifestValue(legacyBody)
	}
	pathValue := any(operation.Path)
	if operation.PathTemplate != nil {
		pathValue = operation.PathTemplate
	}
	evaluatedPath, err := evaluateManifestValue(pathValue, env)
	if err != nil {
		return RequestSpec{}, fmt.Errorf("evaluate request path: %w", err)
	}
	path := strings.ReplaceAll(manifestString(evaluatedPath), "{{taskId}}", url.PathEscape(taskID))
	path = strings.ReplaceAll(path, "{{model}}", url.PathEscape(request.Model))
	path = interpolateManifestString(path, env)
	if !isRelativePath(path) {
		return RequestSpec{}, fmt.Errorf("evaluated request path must be relative: %q", path)
	}
	headers, err := evaluateManifestStringMap(operation.Headers, env)
	if err != nil {
		return RequestSpec{}, fmt.Errorf("evaluate request headers: %w", err)
	}
	query, err := evaluateManifestQuery(operation.Query, env)
	if err != nil {
		return RequestSpec{}, fmt.Errorf("evaluate request query: %w", err)
	}
	files, err := evaluateManifestFiles(operation.Files, env)
	if err != nil {
		return RequestSpec{}, err
	}
	contentTypeValue := any(operation.ContentType)
	if operation.ContentTypeTemplate != nil {
		contentTypeValue = operation.ContentTypeTemplate
	}
	evaluatedContentType, err := evaluateManifestValue(contentTypeValue, env)
	if err != nil {
		return RequestSpec{}, fmt.Errorf("evaluate request content type: %w", err)
	}
	contentType := defaultValue(manifestString(evaluatedContentType), "application/json")
	return RequestSpec{Method: strings.ToUpper(operation.Method), Path: path, DefaultPathPrefix: operation.DefaultPathPrefix, OriginPath: operation.OriginPath, ContentType: contentType, Headers: headers, Query: query, Body: body, Files: files, Auth: auth}, nil
}

func evaluateManifestStringMap(values map[string]any, env map[string]any) (map[string]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	result := make(map[string]string, len(values))
	for key, template := range values {
		value, err := evaluateManifestValue(template, env)
		if err != nil {
			return nil, err
		}
		if text := strings.TrimSpace(manifestString(value)); text != "" {
			result[key] = text
		}
	}
	return result, nil
}

func evaluateManifestQuery(values map[string]any, env map[string]any) (map[string][]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	result := make(map[string][]string, len(values))
	for key, template := range values {
		value, err := evaluateManifestValue(template, env)
		if err != nil {
			return nil, err
		}
		for _, item := range manifestArray(value) {
			if text := strings.TrimSpace(manifestString(item)); text != "" {
				result[key] = append(result[key], text)
			}
		}
	}
	return result, nil
}

func evaluateManifestFiles(parts []ManifestFilePart, env map[string]any) ([]RequestFilePart, error) {
	result := make([]RequestFilePart, 0)
	for _, part := range parts {
		source, err := evaluateManifestValue(part.Source, env)
		if err != nil {
			return nil, fmt.Errorf("evaluate multipart file %q: %w", part.Name, err)
		}
		filename, err := evaluateManifestValue(part.Filename, env)
		if err != nil {
			return nil, fmt.Errorf("evaluate multipart filename %q: %w", part.Name, err)
		}
		mimeType, err := evaluateManifestValue(part.MIMEType, env)
		if err != nil {
			return nil, fmt.Errorf("evaluate multipart MIME type %q: %w", part.Name, err)
		}
		for index, value := range manifestArray(source) {
			references := mediaReferencesFromManifestValue(value, "file", false)
			for _, reference := range references {
				name := strings.TrimSpace(manifestString(filename))
				if name == "" {
					name = reference.Name
				}
				if name == "" {
					name = fmt.Sprintf("%s-%d", part.Name, index+1)
				}
				contentType := strings.TrimSpace(manifestString(mimeType))
				if contentType == "" {
					contentType = reference.MIMEType
				}
				result = append(result, RequestFilePart{Name: part.Name, Filename: name, MIMEType: contentType, Reference: reference})
			}
		}
	}
	return result, nil
}

func normalizeManifestValue(value any) any {
	switch v := value.(type) {
	case map[string]any:
		if len(v) == 0 {
			return v
		}
		isSequential := true
		for i := 0; i < len(v); i++ {
			if _, ok := v[strconv.Itoa(i)]; !ok {
				isSequential = false
				break
			}
		}
		if isSequential {
			arr := make([]any, len(v))
			for i := 0; i < len(v); i++ {
				arr[i] = normalizeManifestValue(v[strconv.Itoa(i)])
			}
			return arr
		}
		res := make(map[string]any, len(v))
		for k, val := range v {
			res[k] = normalizeManifestValue(val)
		}
		return res
	case []any:
		arr := make([]any, len(v))
		for i, val := range v {
			arr[i] = normalizeManifestValue(val)
		}
		return arr
	default:
		return value
	}
}

func manifestExpressionValue(expression string, request GenerationRequest, taskID string) any {
	expression = strings.TrimSpace(expression)
	source := expression
	transforms := []string{}
	if separator := strings.IndexByte(expression, '|'); separator >= 0 {
		source = strings.TrimSpace(expression[:separator])
		transforms = strings.Split(expression[separator+1:], "|")
	}

	var value any
	switch {
	case source == "taskId":
		value = taskID
	case strings.HasPrefix(source, "request."):
		value = pathValue(manifestRequestValues(request), strings.TrimPrefix(source, "request."))
	default:
		value = source
	}
	for _, transform := range transforms {
		value = applyManifestTransform(value, transform, request)
		if value == nil {
			break
		}
	}
	return value
}

// manifestRequestValues is deliberately a small, JSON-shaped view of the
// platform request. It lets uploaded manifests address media items by index
// without exposing Go structs or adding provider-specific host code.
func manifestRequestValues(request GenerationRequest) map[string]any {
	// providerOptions 是 map[string]map[string]any，模板路径只认 map[string]any；
	// 直接放进去会让 request.providerOptions.<namespace>.<key> 永远取到 nil。
	providerOptions, _ := requestAsManifestValue(request.ProviderOptions)
	userContent := make([]any, 0)
	if strings.TrimSpace(request.Prompt) != "" {
		userContent = append(userContent, map[string]any{"type": "text", "text": request.Prompt})
	}
	for _, img := range request.Images {
		val := defaultValue(img.URL, img.DataURL)
		if val != "" {
			userContent = append(userContent, map[string]any{"type": "image_url", "image_url": map[string]any{"url": val}})
		}
	}
	for _, vid := range request.Videos {
		val := defaultValue(vid.URL, vid.DataURL)
		if val != "" {
			userContent = append(userContent, map[string]any{"type": "video_url", "video_url": map[string]any{"url": val}})
		}
	}
	for _, aud := range request.Audios {
		val := defaultValue(aud.URL, aud.DataURL)
		if val != "" {
			userContent = append(userContent, map[string]any{"type": "audio_url", "audio_url": map[string]any{"url": val}})
		}
	}
	messages := make([]any, 0, len(request.Messages)+2)
	// instructions 是统一的系统指令字段，但多数 OpenAI 系协议只映射 request.messages。
	// 系统指令必须进入消息数组，否则会被静默丢弃；带独立 system 字段的协议（Claude、
	// Gemini、Responses）在各自模板里过滤 system 角色，不会重复发送。
	if instructions := strings.TrimSpace(request.Instructions); instructions != "" && !hasSystemMessage(request.Messages) {
		messages = append(messages, map[string]any{"role": "system", "content": instructions})
	}
	for _, message := range request.Messages {
		if strings.TrimSpace(message.Role) == "" || message.Content == nil {
			continue
		}
		messages = append(messages, map[string]any{"role": message.Role, "content": message.Content})
	}
	if len(userContent) > 0 {
		content := any(userContent)
		if len(userContent) == 1 && len(request.Images)+len(request.Videos)+len(request.Audios) == 0 {
			content = request.Prompt
		}
		messages = append(messages, map[string]any{"role": "user", "content": content})
	}

	inputs := request.Inputs
	if len(inputs) == 0 {
		inputs = append(inputs, request.Images...)
		inputs = append(inputs, request.Videos...)
		inputs = append(inputs, request.Audios...)
	}
	output := request.Output
	if output.Count == 0 {
		output.Count = request.ImageCount
	}
	if output.Duration == 0 {
		output.Duration = request.Duration
	}
	if output.AspectRatio == "" {
		output.AspectRatio = request.AspectRatio
	}
	if output.Resolution == "" {
		output.Resolution = request.Resolution
	}
	if output.Quality == "" {
		output.Quality = request.Quality
	}
	output.GenerateAudio = output.GenerateAudio || request.GenerateAudio
	output.Watermark = output.Watermark || request.Watermark
	outputValue, _ := requestAsManifestValue(output)

	return map[string]any{
		"capability":      request.Capability,
		"model":           request.Model,
		"prompt":          request.Prompt,
		"instructions":    request.Instructions,
		"messages":        messages,
		"inputs":          manifestMediaValues(inputs),
		"images":          manifestMediaValues(request.Images),
		"videos":          manifestMediaValues(request.Videos),
		"audios":          manifestMediaValues(request.Audios),
		"imageCount":      request.ImageCount,
		"duration":        request.Duration,
		"aspectRatio":     request.AspectRatio,
		"resolution":      request.Resolution,
		"quality":         request.Quality,
		"generateAudio":   request.GenerateAudio,
		"watermark":       request.Watermark,
		"operation":       request.Operation,
		"output":          outputValue,
		"providerOptions": providerOptions,
		"extra":           request.Extra,
	}
}

func hasSystemMessage(messages []Message) bool {
	for _, message := range messages {
		if strings.EqualFold(strings.TrimSpace(message.Role), "system") {
			return true
		}
	}
	return false
}

func requestAsManifestValue(value any) (any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var result any
	if err := json.Unmarshal(encoded, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func manifestModelID(request GenerationRequest) string {
	modelID := strings.TrimSpace(request.Model)
	if separator := strings.LastIndex(modelID, "::"); separator >= 0 {
		modelID = modelID[separator+2:]
	}
	return strings.ToLower(modelID)
}

func manifestMediaValues(values []MediaReference) []any {
	result := make([]any, 0, len(values))
	for index, value := range values {
		order := value.Order
		if order == 0 && index > 0 {
			order = index
		}
		resolved := defaultValue(value.URL, value.DataURL)
		result = append(result, map[string]any{
			"id":       value.ID,
			"url":      value.URL,
			"dataUrl":  value.DataURL,
			"value":    resolved,
			"kind":     value.Kind,
			"role":     value.Role,
			"mimeType": value.MIMEType,
			"name":     value.Name,
			"order":    order,
			"weight":   value.Weight,
			"metadata": value.Metadata,
			"source": map[string]any{
				"type":     manifestMediaSourceType(value),
				"value":    resolved,
				"mimeType": value.MIMEType,
			},
			"ephemeral": value.Ephemeral,
		})
	}
	return result
}

func manifestMediaSourceType(value MediaReference) string {
	if value.DataURL != "" {
		return "data"
	}
	if value.URL != "" {
		return "url"
	}
	return "unknown"
}

func applyManifestTransform(value any, transform string, request GenerationRequest) any {
	transform = strings.ToLower(strings.TrimSpace(transform))
	if transform == "bool" || transform == "boolean" {
		switch v := value.(type) {
		case bool:
			return v
		case string:
			s := strings.ToLower(strings.TrimSpace(v))
			return s == "true" || s == "1" || s == "yes"
		case int, int64, float64:
			return v != 0
		default:
			return false
		}
	}
	if transform == "int" || transform == "integer" {
		switch v := value.(type) {
		case int:
			return v
		case int64:
			return int(v)
		case float64:
			return int(v)
		case string:
			if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
				return n
			}
			return 0
		default:
			return 0
		}
	}
	if transform == "omit_zero" {
		switch v := value.(type) {
		case int:
			if v == 0 {
				return nil
			}
		case int64:
			if v == 0 {
				return nil
			}
		case float64:
			if v == 0 {
				return nil
			}
		case string:
			if strings.TrimSpace(v) == "0" || strings.TrimSpace(v) == "" {
				return nil
			}
		}
	}
	cleanModel := manifestModelID(request)
	if strings.HasPrefix(transform, "omit_unless_model_contains:") {
		needle := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(transform, "omit_unless_model_contains:")))
		if needle == "" || !strings.Contains(cleanModel, needle) {
			return nil
		}
	}
	if strings.HasPrefix(transform, "omit_if_model_contains:") {
		needle := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(transform, "omit_if_model_contains:")))
		if needle != "" && strings.Contains(cleanModel, needle) {
			return nil
		}
	}
	if strings.HasPrefix(transform, "omit_unless_model_equals:") {
		target := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(transform, "omit_unless_model_equals:")))
		if target == "" || cleanModel != target {
			return nil
		}
	}
	if strings.HasPrefix(transform, "omit_if_model_equals:") {
		target := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(transform, "omit_if_model_equals:")))
		if target != "" && cleanModel == target {
			return nil
		}
	}
	text, ok := value.(string)
	if transform == "omit_empty" && (!ok || strings.TrimSpace(text) == "") {
		return nil
	}
	if transform == "omit_auto" && (!ok || strings.TrimSpace(text) == "" || strings.EqualFold(strings.TrimSpace(text), "auto") || strings.EqualFold(strings.TrimSpace(text), "default")) {
		return nil
	}
	if !ok {
		return value
	}
	switch transform {
	case "trim":
		return strings.TrimSpace(text)
	case "lower", "lowercase":
		return strings.ToLower(text)
	case "upper", "uppercase":
		return strings.ToUpper(text)
	case "resolution_p":
		if regexp.MustCompile(`^\d+$`).MatchString(strings.TrimSpace(text)) {
			return strings.TrimSpace(text) + "p"
		}
		return text
	case "video-resolution", "video_resolution", "videoresolution":
		// Compatibility for already-installed 1.0.1 manifests. New plugins
		// should declare exact enum values and use generic string transforms.
		return normalizeLegacyManifestVideoResolution(text)
	default:
		return value
	}
}

func normalizeLegacyManifestVideoResolution(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return ""
	}
	for _, char := range normalized {
		if char < '0' || char > '9' {
			return normalized
		}
	}
	return normalized + "p"
}

func pathValue(payload map[string]any, path string) any {
	return manifestPathValue(payload, path)
}

func arrayValue(value any) []any {
	items, _ := value.([]any)
	return items
}

func firstPathValue(payload map[string]any, paths ...string) string {
	for _, path := range paths {
		if strings.Contains(path, "*") {
			if text := strings.Join(manifestTextPathValues(payload, strings.Split(path, ".")), ""); strings.TrimSpace(text) != "" {
				return strings.TrimSpace(text)
			}
			continue
		}
		value := pathValue(payload, path)
		if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text)
		}
	}
	return ""
}

// Responses text may follow reasoning/tool items and span multiple content
// blocks. Wildcards collect text in wire order without guessing array indexes.
func manifestTextPathValues(value any, parts []string) []string {
	if len(parts) == 0 {
		if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
			return []string{text}
		}
		return nil
	}
	if parts[0] == "*" {
		var values []string
		for _, item := range arrayValue(value) {
			values = append(values, manifestTextPathValues(item, parts[1:])...)
		}
		return values
	}
	return manifestTextPathValues(manifestPathValue(value, parts[0]), parts[1:])
}

// manifestError 判断声明的错误路径上是否出现了失败值。successCodes 是协议自己
// 声明的业务成功码（即梦 CV 用 code=10000 表示成功）：只有在该路径值命中成功码时
// 才跳过失败判定，其余厂商的协议不声明这个字段，判定规则保持原样。
func manifestError(payload map[string]any, paths []string, successCodes []any) bool {
	for _, path := range paths {
		value := pathValue(payload, path)
		if manifestValueInSuccessCodes(value, successCodes) {
			continue
		}
		switch typed := value.(type) {
		case nil:
			continue
		case string:
			switch strings.ToLower(strings.TrimSpace(typed)) {
			case "", "0", "ok", "success", "succeeded", "true":
				continue
			default:
				return true
			}
		case float64:
			if typed == 0 {
				continue
			}
			return true
		case float32:
			if typed == 0 {
				continue
			}
			return true
		case int, int8, int16, int32, int64:
			if reflectValueIsZero(typed) {
				continue
			}
			return true
		case uint, uint8, uint16, uint32, uint64:
			if reflectValueIsZero(typed) {
				continue
			}
			return true
		default:
			return true
		}
	}
	return false
}

// manifestValueInSuccessCodes 用文本形式比较成功码，避免上游把 code 写成数字或
// 字符串（10000 与 "10000"）时判定不一致。
func manifestValueInSuccessCodes(value any, successCodes []any) bool {
	if len(successCodes) == 0 {
		return false
	}
	text := manifestCodeText(value)
	if text == "" {
		return false
	}
	for _, code := range successCodes {
		if manifestCodeText(code) == text {
			return true
		}
	}
	return false
}

func manifestCodeText(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(typed), 'f', -1, 32)
	case int, int8, int16, int32, int64:
		return fmt.Sprintf("%d", typed)
	case uint, uint8, uint16, uint32, uint64:
		return fmt.Sprintf("%d", typed)
	default:
		return ""
	}
}

func reflectValueIsZero(value any) bool {
	switch typed := value.(type) {
	case int:
		return typed == 0
	case int8:
		return typed == 0
	case int16:
		return typed == 0
	case int32:
		return typed == 0
	case int64:
		return typed == 0
	case uint:
		return typed == 0
	case uint8:
		return typed == 0
	case uint16:
		return typed == 0
	case uint32:
		return typed == 0
	case uint64:
		return typed == 0
	default:
		return false
	}
}

