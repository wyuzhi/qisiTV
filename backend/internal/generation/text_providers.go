package generation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/protocol"
)

func RunDeclarativeAgentTask(ctx context.Context, input Input, adapter protocol.AgentAdapter) (map[string]interface{}, error) {
	wire := input.Config.InterfaceType
	if wire == string(model.ChannelInterfaceOpenAIResponse) {
		wire = "responses"
	}
	knownWire := wire == "chat-completion" || wire == "responses" || wire == "claude-api"
	if input.TextOptions.Thinking && !knownWire {
		return nil, errors.New("当前声明式 Agent 渠道尚不支持思考模式，请关闭思考模式或切换内置协议渠道")
	}
	if input.AgentRequests == nil {
		return nil, errors.New("画布 Agent 工具请求缺少协议参数")
	}
	request := map[string]any{
		"chatCompletion": input.AgentRequests.ChatCompletion,
		"responses":      input.AgentRequests.Responses,
		"claude":         input.AgentRequests.Claude,
		"gemini":         input.AgentRequests.Gemini,
	}
	spec, err := adapter.BuildAgent(ctx, protocol.AgentRequestContext{BaseURL: input.Config.BaseURL, Model: input.Config.Model, Request: request})
	if err != nil {
		return nil, err
	}
	if knownWire {
		body := ProtocolBodyObject(spec.Body)
		if body == nil {
			return nil, errors.New("声明式 Agent 请求体必须是 JSON 对象")
		}
		ApplyTextThinking(body, input, wire)
		NormalizeAgentToolChoice(body, input, wire)
		spec.Body = body
		if input.StreamText {
			body["stream"] = true
			if wire == "chat-completion" {
				if err := ensureChatCompletionStreamUsage(body); err != nil {
					return nil, err
				}
			}
			parser := NewStreamingAgentParser(wire, input.OnTextDelta)
			parser.emitReasoning = input.OnReasoningDelta
			data, mime, err := ExecuteProtocolBinaryRequestWithConsumer(ctx, input.Config, spec, parser.Consume)
			if err != nil {
				return nil, err
			}
			if strings.Contains(strings.ToLower(mime), "event-stream") {
				parser.Flush()
				return parser.Result()
			}
			var payload map[string]interface{}
			if err := json.Unmarshal(data, &payload); err != nil {
				return nil, fmt.Errorf("Agent 接口返回格式无效：%w", err)
			}
			return ParseAgentToolPayload(payload, wire)
		}
	}
	body, err := ExecuteProtocolRequest(ctx, input.Config, spec)
	if err != nil {
		return nil, err
	}
	parsed, err := adapter.ParseAgent(ctx, body)
	if err != nil {
		return nil, err
	}
	result := map[string]interface{}{"mode": "text", "text": parsed.Text, "toolCalls": []interface{}{}}
	if parsed.Reasoning != "" {
		result["reasoning"] = parsed.Reasoning
	}
	calls := make([]interface{}, 0, len(parsed.ToolCalls))
	for _, call := range parsed.ToolCalls {
		mapped := map[string]interface{}{
			"id":       call.ID,
			"type":     "function",
			"function": map[string]interface{}{"name": call.Name, "arguments": call.Arguments},
		}
		if call.ThoughtSignature != "" {
			mapped["thoughtSignature"] = call.ThoughtSignature
		}
		calls = append(calls, mapped)
	}
	result["toolCalls"] = calls
	if strings.TrimSpace(parsed.Text) == "" && len(calls) == 0 {
		return nil, errors.New("声明式 Agent 接口没有返回内容")
	}
	return result, nil
}

func ClaudeAgentBody(request map[string]interface{}) map[string]interface{} {
	body := map[string]interface{}{"max_tokens": 4096}
	if messages, ok := request["messages"].([]interface{}); ok {
		claudeMessages := make([]interface{}, 0, len(messages))
		var system []string
		for _, value := range messages {
			message, _ := value.(map[string]interface{})
			role := strings.ToLower(strings.TrimSpace(stringField(message, "role")))
			if role == "system" {
				if content := strings.TrimSpace(fmt.Sprint(message["content"])); content != "" {
					system = append(system, content)
				}
				continue
			}
			if role == "tool" {
				claudeMessages = append(claudeMessages, map[string]interface{}{"role": "user", "content": []interface{}{map[string]interface{}{
					"type": "tool_result", "tool_use_id": stringField(message, "tool_call_id"), "content": fmt.Sprint(message["content"]),
				}}})
				continue
			}
			role = MapClaudeMessageRole(role)
			content := message["content"]
			if content == nil {
				content = ""
			}
			if toolCalls, ok := message["tool_calls"].([]interface{}); ok && len(toolCalls) > 0 {
				blocks := make([]interface{}, 0, len(toolCalls))
				for _, value := range toolCalls {
					toolCall, _ := value.(map[string]interface{})
					function, _ := toolCall["function"].(map[string]interface{})
					blocks = append(blocks, map[string]interface{}{
						"type": "tool_use", "id": stringField(toolCall, "id"), "name": stringField(function, "name"), "input": ClaudeToolInput(function["arguments"]),
					})
				}
				content = blocks
			}
			claudeMessages = append(claudeMessages, map[string]interface{}{"role": role, "content": content})
		}
		body["messages"] = claudeMessages
		if len(system) > 0 {
			body["system"] = []interface{}{map[string]interface{}{
				"type": "text", "text": strings.Join(system, "\n\n"),
				"cache_control": map[string]interface{}{"type": "ephemeral"},
			}}
		}
	}
	if tools, ok := request["tools"].([]interface{}); ok && len(tools) > 0 {
		claudeTools := make([]interface{}, 0, len(tools))
		for _, value := range tools {
			tool, _ := value.(map[string]interface{})
			function, _ := tool["function"].(map[string]interface{})
			if len(function) == 0 {
				continue
			}
			claudeTools = append(claudeTools, map[string]interface{}{
				"name": stringField(function, "name"), "description": stringField(function, "description"), "input_schema": function["parameters"],
			})
		}
		if len(claudeTools) > 0 {
			if last, ok := claudeTools[len(claudeTools)-1].(map[string]interface{}); ok {
				last["cache_control"] = map[string]interface{}{"type": "ephemeral"}
			}
			body["tools"] = claudeTools
		}
	}
	if choice, ok := request["tool_choice"]; ok {
		body["tool_choice"] = ClaudeToolChoice(choice)
	}
	return body
}

func MapClaudeMessageRole(role string) string {
	if role == "assistant" {
		return "assistant"
	}
	return "user"
}

func ClaudeToolInput(value interface{}) interface{} {
	if raw, ok := value.(string); ok {
		var parsed interface{}
		if json.Unmarshal([]byte(raw), &parsed) == nil && parsed != nil {
			return parsed
		}
	}
	if value != nil {
		return value
	}
	return map[string]interface{}{}
}

func ClaudeToolChoice(value interface{}) interface{} {
	switch choice := value.(type) {
	case string:
		switch strings.ToLower(strings.TrimSpace(choice)) {
		case "required":
			return map[string]interface{}{"type": "any"}
		case "none":
			return map[string]interface{}{"type": "auto"}
		default:
			return map[string]interface{}{"type": "auto"}
		}
	case map[string]interface{}:
		if function, ok := choice["function"].(map[string]interface{}); ok && stringField(function, "name") != "" {
			return map[string]interface{}{"type": "tool", "name": stringField(function, "name")}
		}
		if name := stringField(choice, "name"); name != "" {
			return map[string]interface{}{"type": "tool", "name": name}
		}
	}
	return map[string]interface{}{"type": "auto"}
}

func RunClaudeTextTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	if len(input.ReferenceVideos) > 0 {
		return nil, errors.New("Claude API 当前不支持视频参考输入")
	}
	messages := make([]map[string]interface{}, 0, len(input.TextHistory)+1)
	for _, message := range ValidatedTextHistory(input.TextHistory) {
		messages = append(messages, message)
	}
	content, err := ClaudeTextContent(input)
	if err != nil {
		return nil, err
	}
	messages = append(messages, map[string]interface{}{"role": "user", "content": content})
	maxTokens := 4096
	if input.MaxOutputTokens > 0 {
		maxTokens = input.MaxOutputTokens
	}
	body := map[string]interface{}{"model": input.Config.Model, "max_tokens": maxTokens, "messages": messages}
	ApplyTextThinking(body, input, "claude-api")
	if systemPrompt := strings.TrimSpace(input.Config.SystemPrompt); systemPrompt != "" {
		body["system"] = systemPrompt
	}
	result, err := RequestTextProvider(ctx, input.Config, "/messages", body, "claude-api", input.StreamText, input.OnTextDelta)
	if err != nil {
		return nil, err
	}
	return ProviderTextTaskResult(result), nil
}

func ClaudeTextContent(input Input) (interface{}, error) {
	if len(input.ReferenceImages) == 0 {
		return input.Prompt, nil
	}
	content := []map[string]interface{}{{"type": "text", "text": input.Prompt}}
	for _, image := range input.ReferenceImages {
		value, err := openAIImageInputURL(image)
		if err != nil {
			return nil, err
		}
		if strings.HasPrefix(value, "data:") {
			mimeType, data, ok := SplitDataURL(value)
			if !ok {
				return nil, errors.New("Claude 参考图片 data URL 无效")
			}
			content = append(content, map[string]interface{}{"type": "image", "source": map[string]interface{}{"type": "base64", "media_type": mimeType, "data": data}})
		} else {
			content = append(content, map[string]interface{}{"type": "image", "source": map[string]interface{}{"type": "url", "url": value}})
		}
	}
	return content, nil
}

func SplitDataURL(value string) (string, string, bool) {
	if !strings.HasPrefix(value, "data:") {
		return "", "", false
	}
	separator := strings.Index(value, ",")
	if separator <= len("data:") {
		return "", "", false
	}
	header := strings.TrimPrefix(value[:separator], "data:")
	if !strings.HasSuffix(header, ";base64") {
		return "", "", false
	}
	return strings.TrimSuffix(header, ";base64"), value[separator+1:], value[separator+1:] != ""
}

func ExtractTextPayload(payload map[string]interface{}, protocol string) string {
	if protocol == "claude-api" {
		content, _ := payload["content"].([]interface{})
		var result strings.Builder
		for _, item := range content {
			record, _ := item.(map[string]interface{})
			if stringField(record, "type") == "text" {
				result.WriteString(stringField(record, "text"))
			}
		}
		return result.String()
	}
	if protocol == "responses" {
		text := stringField(payload, "output_text")
		if text == "" {
			text = ExtractResponseText(payload)
		}
		return text
	}
	return ExtractChatCompletionText(payload)
}
