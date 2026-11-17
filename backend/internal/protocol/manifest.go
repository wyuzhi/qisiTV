package protocol

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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
