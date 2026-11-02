package generation

// 文本生成、Agent 工具循环和文本流解析。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"qisitv/backend/internal/model"
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
	path := "/chat/completions"
	protocol := "chat-completion"
	if input.Config.InterfaceType == string(model.ChannelInterfaceOpenAIResponse) {
		request = input.AgentRequests.Responses
		path = "/responses"
		protocol = "responses"
	} else if input.Config.InterfaceType == string(model.ChannelInterfaceClaudeAPI) {
		if input.AgentRequests.Claude != nil {
			request = input.AgentRequests.Claude
		}
		path = "/messages"
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
	switch input.Config.InterfaceType {
	case "chat-completion":
		return RunChatCompletionsTextTask(ctx, input)
	case "openai-response":
		return RunResponsesTextTask(ctx, input)
	case string(model.ChannelInterfaceClaudeAPI):
		return RunClaudeTextTask(ctx, input)
	}
	return RunLegacyTextTask(ctx, input)
}

func RunLegacyTextTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	responseInput, err := TextResponseInput(input)
	if err != nil {
		return nil, err
	}
	body := map[string]interface{}{"model": input.Config.Model, "input": responseInput}
	ApplyTextThinking(body, input, "responses")
	ApplyTextOutputLimit(body, input.MaxOutputTokens, "max_output_tokens")
	result, err := RequestTextProvider(ctx, input.Config, "/responses", body, "responses", input.StreamText, input.OnTextDelta)
	if err != nil {
		if !ShouldFallbackTextToChat(err) {
			return nil, err
		}
		result, chatErr := RunChatCompletionsTextTask(ctx, input)
		if chatErr == nil {
			return result, nil
		}
		return nil, fmt.Errorf("文本接口请求失败：Responses API %v；Chat Completions %v", err, chatErr)
	}
	return ProviderTextTaskResult(result), nil
}

func RunResponsesTextTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	responseInput, err := TextResponseInput(input)
	if err != nil {
		return nil, err
	}
	body := map[string]interface{}{"model": input.Config.Model, "input": responseInput}
	ApplyTextThinking(body, input, "responses")
	ApplyTextOutputLimit(body, input.MaxOutputTokens, "max_output_tokens")
	result, err := RequestTextProvider(ctx, input.Config, "/responses", body, "responses", input.StreamText, input.OnTextDelta)
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
	result, err := RequestTextProvider(ctx, input.Config, "/chat/completions", body, "chat-completion", input.StreamText, input.OnTextDelta)
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

func ShouldFallbackTextToChat(err error) bool {
	var httpErr HTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	// 只在上游明确说这个路径不存在/不允许时，才把 Responses 换成 Chat Completions。
	// 502/503/504 是瞬时故障，换协议不会修好，还会把真正的上游故障伪装成“能力缺失后的第二次失败”。
	switch httpErr.StatusCode {
	case http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusNotImplemented:
		return true
	default:
		return false
	}
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
