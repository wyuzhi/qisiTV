package protocol

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

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
	workflow := manifestWorkflowValues(a.manifest, c.Request)
	variables, err := manifestRequestVariables(a.manifest.Variables, c.Request, workflow)
	if err != nil {
		return RequestSpec{}, err
	}
	if err := validateManifestRequest(a.manifest.Validations, c.Request, variables, workflow); err != nil {
		return RequestSpec{}, err
	}
	spec, err := buildManifestOperation(a.manifest.Create, a.manifest.Auth, c.Request, "", variables, workflow)
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
	workflow := manifestWorkflowValues(a.manifest, request)
	variables, err := manifestRequestVariables(a.manifest.Variables, request, workflow)
	if err != nil {
		return RequestSpec{}, err
	}
	return buildManifestOperation(operation, a.manifest.Auth, request, taskID, variables, workflow)
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

func buildManifestOperation(operation ManifestOperation, auth ManifestAuth, request GenerationRequest, taskID string, extras ...map[string]any) (RequestSpec, error) {
	requestValues := manifestRequestValues(request)
	env := map[string]any{"request": requestValues, "taskId": taskID}
	if len(extras) > 0 {
		env["vars"] = extras[0]
	}
	if len(extras) > 1 && extras[1] != nil {
		env["workflow"] = extras[1]
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
	path = strings.ReplaceAll(path, "{{model}}", url.PathEscape(manifestRawModelID(request)))
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
		"model":           manifestRawModelID(request),
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
