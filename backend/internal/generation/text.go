package generation

// 文本生成、Agent 工具循环和文本流解析。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
	"infinite-canvas/backend/internal/providerpreset"
)

func RunAgentToolTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	// 浏览器持久化的是协议中立请求；资源水合和模型路由完成后才展开上游协议，
	// 防止供应商请求体反向污染任务记录，也避免切换模型时复用错误协议。
	if input.AgentRequests != nil && input.AgentRequests.Canonical != nil {
		_, declarative := AgentProtocolAdapterForContext(ctx, input.Config.InterfaceType)
		requests, err := ExpandCanonicalAgentRequest(input.AgentRequests.Canonical, input.Config, declarative)
		if err != nil {
			return nil, err
		}
		input.AgentRequests = requests
	}
	if adapter, ok := AgentProtocolAdapterForContext(ctx, input.Config.InterfaceType); ok {
		return RunDeclarativeAgentTask(ctx, input, adapter)
	}
	if input.AgentRequests == nil {
		return nil, errors.New("画布 Agent 工具请求缺少协议参数")
	}
	request := input.AgentRequests.ChatCompletion
	path := ChatCompletionsPath
	protocol := "chat-completion"
	if input.Config.InterfaceType == string(model.ChannelInterfaceOpenAIResponse) {
		request = input.AgentRequests.Responses
		path = ResponsesPath
		protocol = "responses"
	} else if input.Config.InterfaceType == string(model.ChannelInterfaceClaudeAPI) {
		if input.AgentRequests.Claude != nil {
			request = input.AgentRequests.Claude
		}
		path = MessagesPath
		protocol = "claude-api"
	}
	if request == nil {
		return nil, errors.New("画布 Agent 工具请求缺少协议参数")
	}
	body := CloneStringAnyMap(request)
	if protocol == "claude-api" && input.AgentRequests.Claude == nil {
		body = ClaudeAgentBody(body)
	}
	body["model"] = input.Config.Model
	ApplyTextThinking(body, input, protocol)
	NormalizeAgentToolChoice(body, input, protocol)
	result, err := PostAgentRequest(ctx, input, path, body, protocol)
	if protocol == "chat-completion" && IsAgentToolChoiceCompatibilityError(err) {
		if !IsAutoAgentToolChoice(body["tool_choice"]) {
			autoBody := CloneStringAnyMap(body)
			autoBody["tool_choice"] = "auto"
			result, err = PostAgentRequest(ctx, input, path, autoBody, protocol)
		}
		if IsAgentToolChoiceCompatibilityError(err) {
			withoutToolChoice := CloneStringAnyMap(body)
			delete(withoutToolChoice, "tool_choice")
			result, err = PostAgentRequest(ctx, input, path, withoutToolChoice, protocol)
		}
	}
	if err != nil {
		return nil, err
	}
	return result, nil
}

func PostAgentRequest(ctx context.Context, input Input, path string, body map[string]interface{}, protocol string) (map[string]interface{}, error) {
	if input.StreamText {
		return PostStreamingAgent(ctx, input.Config, path, body, protocol, input.OnTextDelta, input.OnReasoningDelta)
	}
	delete(body, "stream")
	var payload map[string]interface{}
	if err := PostJSON(ctx, input.Config, path, body, &payload); err != nil {
		return nil, err
	}
	return ParseAgentToolPayload(payload, protocol)
}

func IsAgentToolChoiceCompatibilityError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	var payloadErr PayloadError
	if errors.As(err, &payloadErr) {
		message += " " + strings.ToLower(payloadErr.Raw())
	}
	var httpErr HTTPError
	if errors.As(err, &httpErr) {
		message += " " + strings.ToLower(httpErr.Body)
	}
	return strings.Contains(message, "tool_choice") || strings.Contains(message, "tool choice") || strings.Contains(message, "tool-choice") || strings.Contains(message, "thinking mode")
}

func IsAutoAgentToolChoice(value interface{}) bool {
	choice, ok := value.(string)
	return ok && strings.EqualFold(strings.TrimSpace(choice), "auto")
}

func ParseAgentToolPayload(payload map[string]interface{}, protocol string) (map[string]interface{}, error) {
	if err := ValidateTextPayload(payload); err != nil {
		return nil, err
	}
	result := map[string]interface{}{"mode": "text", "text": "", "toolCalls": []interface{}{}}
	if protocol == "responses" {
		result["text"] = firstNonEmpty(stringField(payload, "output_text"), ExtractResponseText(payload))
		if reasoning := ExtractResponseReasoning(payload); reasoning != "" {
			result["reasoning"] = reasoning
		}
		calls := make([]interface{}, 0)
		for _, value := range InterfaceSlice(payload["output"]) {
			item, _ := value.(map[string]interface{})
			if stringField(item, "type") != "function_call" {
				continue
			}
			calls = append(calls, map[string]interface{}{"id": firstNonEmpty(stringField(item, "call_id"), stringField(item, "id")), "type": "function", "function": map[string]interface{}{"name": stringField(item, "name"), "arguments": stringField(item, "arguments")}})
		}
		result["toolCalls"] = calls
		return result, nil
	}
	if protocol == "claude-api" {
		content := InterfaceSlice(payload["content"])
		calls := make([]interface{}, 0)
		for _, value := range content {
			item, _ := value.(map[string]interface{})
			switch stringField(item, "type") {
			case "text":
				result["text"] = result["text"].(string) + stringField(item, "text")
			case "thinking":
				result["reasoning"] = ResultString(result, "reasoning") + firstNonEmpty(stringField(item, "thinking"), stringField(item, "text"))
			case "tool_use":
				arguments, err := json.Marshal(item["input"])
				if err != nil {
					return nil, err
				}
				calls = append(calls, map[string]interface{}{"id": stringField(item, "id"), "type": "function", "function": map[string]interface{}{"name": stringField(item, "name"), "arguments": string(arguments)}})
			}
		}
		result["toolCalls"] = calls
		if result["text"] == "" && len(calls) == 0 {
			return nil, errors.New("Claude Agent 接口没有返回内容")
		}
		return result, nil
	}
	choices := InterfaceSlice(payload["choices"])
	if len(choices) == 0 {
		return nil, errors.New("画布 Agent 接口没有返回 choices")
	}
	choice, _ := choices[0].(map[string]interface{})
	message, _ := choice["message"].(map[string]interface{})
	result["text"] = stringField(message, "content")
	if reasoning := firstNonEmpty(stringField(message, "reasoning_content"), stringField(message, "reasoning")); reasoning != "" {
		result["reasoning"] = reasoning
	}
	calls := make([]interface{}, 0)
	for _, value := range InterfaceSlice(message["tool_calls"]) {
		item, _ := value.(map[string]interface{})
		function, _ := item["function"].(map[string]interface{})
		calls = append(calls, map[string]interface{}{"id": stringField(item, "id"), "type": "function", "function": map[string]interface{}{"name": stringField(function, "name"), "arguments": stringField(function, "arguments")}})
	}
	result["toolCalls"] = calls
	return result, nil
}

func ExtractResponseReasoning(payload map[string]interface{}) string {
	var chunks []string
	for _, value := range InterfaceSlice(payload["output"]) {
		item, _ := value.(map[string]interface{})
		if stringField(item, "type") != "reasoning" {
			continue
		}
		for _, key := range []string{"summary", "content"} {
			for _, part := range InterfaceSlice(item[key]) {
				record, _ := part.(map[string]interface{})
				if text := strings.TrimSpace(stringField(record, "text")); text != "" {
					chunks = append(chunks, text)
				}
			}
		}
	}
	return strings.Join(chunks, "\n")
}

func InterfaceSlice(value interface{}) []interface{} {
	items, _ := value.([]interface{})
	return items
}

func CloneStringAnyMap(value map[string]interface{}) map[string]interface{} {
	cloned := make(map[string]interface{}, len(value)+1)
	for key, item := range value {
		cloned[key] = item
	}
	return cloned
}

func RunTextTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	if _, ok := DeclarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType); ok {
		return RunDeclarativeProtocolTask(ctx, input)
	}
	interfaceType, err := hostTextInterface(input.Config)
	if err != nil {
		return nil, err
	}
	switch interfaceType {
	case string(model.ChannelInterfaceOpenAIResponse):
		return RunResponsesTextTask(ctx, input)
	case string(model.ChannelInterfaceClaudeAPI):
		return RunClaudeTextTask(ctx, input)
	default:
		return RunChatCompletionsTextTask(ctx, input)
	}
}

// hostTextInterface 把文本请求落到宿主自带的三种格式之一。别名（如 anthropic-messages）
// 按它指向的接口走；没写接口的旧配置按渠道格式取默认值；认不出的接口直接报错，
// 不再拿 Responses 和 Chat Completions 轮流试，免得用户看到的是一条无关的上游报错。
func hostTextInterface(config Config) (string, error) {
	requested := strings.TrimSpace(config.InterfaceType)
	if requested == "" {
		if strings.TrimSpace(config.APIFormat) == "claude" {
			return string(model.ChannelInterfaceClaudeAPI), nil
		}
		return providerpreset.LegacyDefaultProtocol("text"), nil
	}
	adapter, ok := protocol.Builtins().Resolve(requested)
	if !ok || !ProtocolCapabilityMatches(adapter.Metadata(), protocol.Capability("text")) {
		return "", fmt.Errorf("接口类型 %s 未安装", requested)
	}
	return adapter.Metadata().ID, nil
}

// TextRequestURLFor 是文本任务对这个接口格式实际请求的地址：别名和留空的接口格式按文本任务同一套规则
// 落到宿主自带的格式上；插件或认不出的接口格式返回空串。
func TextRequestURLFor(baseURL, apiFormat, interfaceType string) string {
	resolved, err := hostTextInterface(Config{BaseURL: baseURL, APIFormat: apiFormat, InterfaceType: interfaceType})
	if err != nil {
		return ""
	}
	return TextRequestURL(baseURL, model.ChannelInterfaceType(resolved))
}

func RunResponsesTextTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	responseInput, err := TextResponseInput(input)
	if err != nil {
		return nil, err
	}
	body := map[string]interface{}{"model": input.Config.Model, "input": responseInput}
	ApplyTextThinking(body, input, "responses")
	ApplyTextOutputLimit(body, input.MaxOutputTokens, "max_output_tokens")
	result, err := RequestTextProvider(ctx, input.Config, ResponsesPath, body, "responses", input.StreamText, input.OnTextDelta)
	if err != nil {
		return nil, err
	}
	return ProviderTextTaskResult(result), nil
}

func RunChatCompletionsTextTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	messages := []map[string]interface{}{}
	if systemPrompt := strings.TrimSpace(input.Config.SystemPrompt); systemPrompt != "" {
		messages = append(messages, map[string]interface{}{"role": "system", "content": systemPrompt})
	}
	messages = append(messages, ValidatedTextHistory(input.TextHistory)...)
	userContent, err := TextChatContent(input)
	if err != nil {
		return nil, err
	}
	messages = append(messages, map[string]interface{}{"role": "user", "content": userContent})
	body := map[string]interface{}{"model": input.Config.Model, "messages": messages}
	ApplyTextThinking(body, input, "chat-completion")
	ApplyTextOutputLimit(body, input.MaxOutputTokens, "max_tokens")
	result, err := RequestTextProvider(ctx, input.Config, ChatCompletionsPath, body, "chat-completion", input.StreamText, input.OnTextDelta)
	if err != nil {
		return nil, err
	}
	return ProviderTextTaskResult(result), nil
}

func ApplyTextThinking(body map[string]interface{}, input Input, protocol string) {
	if !input.TextOptions.Thinking {
		return
	}
	switch protocol {
	case "responses":
		body["reasoning"] = map[string]interface{}{"effort": "medium", "summary": "auto"}
	case "chat-completion":
		body["reasoning_effort"] = "medium"
	case "claude-api":
		body["thinking"] = map[string]interface{}{"type": "enabled", "budget_tokens": 1024}
	}
}

// Chat Completion defaults to automatic tool selection when tools are present,
// so an explicit "auto" only reduces compatibility. Reasoning endpoints also
// disagree on forced choices. Normalize before the first network request while
// preserving required/named choices for non-reasoning structured tasks.
func NormalizeAgentToolChoice(body map[string]interface{}, input Input, protocol string) {
	if protocol == "chat-completion" && (input.TextOptions.Thinking || IsAutoAgentToolChoice(body["tool_choice"])) {
		delete(body, "tool_choice")
	}
}

type ProviderTextResult struct {
	Text      string
	Reasoning string
}

func ProviderTextTaskResult(result ProviderTextResult) map[string]interface{} {
	payload := map[string]interface{}{"mode": "text", "text": result.Text}
	if strings.TrimSpace(result.Reasoning) != "" {
		payload["reasoning"] = result.Reasoning
	}
	return payload
}

func ApplyTextOutputLimit(body map[string]interface{}, limit int, field string) {
	if limit > 0 {
		body[field] = limit
	}
}

func TextResponseInput(input Input) (interface{}, error) {
	systemPrompt := strings.TrimSpace(input.Config.SystemPrompt)
	if len(input.TextHistory) == 0 && len(input.ReferenceImages) == 0 && len(input.ReferenceVideos) == 0 {
		return WithSystemPrompt(input.Config, input.Prompt), nil
	}
	messages := make([]map[string]interface{}, 0, len(input.TextHistory)+2)
	if systemPrompt != "" {
		messages = append(messages, map[string]interface{}{"role": "system", "content": systemPrompt})
	}
	messages = append(messages, ValidatedTextHistory(input.TextHistory)...)
	content, err := TextResponseContent(input)
	if err != nil {
		return nil, err
	}
	messages = append(messages, map[string]interface{}{"role": "user", "content": content})
	return messages, nil
}

func ValidatedTextHistory(history []TextMessage) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(history))
	for _, message := range history {
		role := strings.ToLower(strings.TrimSpace(message.Role))
		content := strings.TrimSpace(message.Content)
		if (role != "user" && role != "assistant") || content == "" {
			continue
		}
		result = append(result, map[string]interface{}{"role": role, "content": content})
	}
	return result
}

func TextResponseContent(input Input) ([]map[string]interface{}, error) {
	content := []map[string]interface{}{{"type": "input_text", "text": input.Prompt}}
	for _, image := range input.ReferenceImages {
		url, err := openAIImageInputURL(image)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]interface{}{"type": "input_image", "image_url": url})
	}
	for _, video := range input.ReferenceVideos {
		url, err := openAIVideoInputURL(video)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]interface{}{"type": "input_video", "video_url": url})
	}
	return content, nil
}

func TextChatContent(input Input) (interface{}, error) {
	if len(input.ReferenceImages) == 0 && len(input.ReferenceVideos) == 0 {
		return input.Prompt, nil
	}
	content := []map[string]interface{}{{"type": "text", "text": input.Prompt}}
	for _, image := range input.ReferenceImages {
		url, err := openAIImageInputURL(image)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": url}})
	}
	for _, video := range input.ReferenceVideos {
		url, err := openAIVideoInputURL(video)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]interface{}{"type": "video_url", "video_url": map[string]interface{}{"url": url}})
	}
	return content, nil
}

func RequestTextProvider(ctx context.Context, config Config, path string, body map[string]interface{}, protocol string, stream bool, onDelta func(string)) (ProviderTextResult, error) {
	if stream {
		return PostStreamingTextResult(ctx, config, path, body, protocol, onDelta)
	}
	var payload map[string]interface{}
	if err := PostJSON(ctx, config, path, body, &payload); err != nil {
		return ProviderTextResult{}, err
	}
	parsed, err := ParseAgentToolPayload(payload, protocol)
	if err != nil {
		return ProviderTextResult{}, err
	}
	result := ProviderTextResult{Text: stringField(parsed, "text"), Reasoning: stringField(parsed, "reasoning")}
	if result.Text == "" {
		return ProviderTextResult{}, errors.New("文本接口没有返回内容")
	}
	return result, nil
}

func ValidateTextPayload(payload map[string]interface{}) error {
	if _, _, failed := PayloadBusinessFailure(payload); failed {
		encoded, _ := json.Marshal(payload)
		raw := string(encoded)
		return NewRawPayloadError(raw)
	}
	return nil
}

func ExtractResponseText(payload map[string]interface{}) string {
	output, ok := payload["output"].([]interface{})
	if !ok {
		return ""
	}
	var chunks []string
	for _, item := range output {
		record, ok := item.(map[string]interface{})
		if !ok || record["type"] != "message" {
			continue
		}
		content, _ := record["content"].([]interface{})
		for _, part := range content {
			partRecord, ok := part.(map[string]interface{})
			if ok && stringField(partRecord, "text") != "" {
				chunks = append(chunks, stringField(partRecord, "text"))
			}
		}
	}
	return strings.Join(chunks, "")
}

func ExtractChatCompletionText(payload map[string]interface{}) string {
	if data, ok := payload["data"].(map[string]interface{}); ok {
		payload = data
	}
	choices, ok := payload["choices"].([]interface{})
	if !ok {
		return ""
	}
	var chunks []string
	for _, choice := range choices {
		record, ok := choice.(map[string]interface{})
		if !ok {
			continue
		}
		if message, ok := record["message"].(map[string]interface{}); ok {
			if text := stringField(message, "content"); text != "" {
				chunks = append(chunks, text)
			}
		}
		if text := stringField(record, "text"); text != "" {
			chunks = append(chunks, text)
		}
	}
	return strings.Join(chunks, "")
}
