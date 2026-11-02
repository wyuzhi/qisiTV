package generation

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
)

var sseFrameBoundaryPattern = regexp.MustCompile(`\r?\n\r?\n`)

func PostStreamingAgent(ctx context.Context, config Config, path string, body map[string]interface{}, protocol string, onDelta func(string), onReasoning ...func(string)) (map[string]interface{}, error) {
	body["stream"] = true
	if protocol == "chat-completion" {
		if err := ensureChatCompletionStreamUsage(body); err != nil {
			return nil, err
		}
	}
	parser := NewStreamingAgentParser(protocol, onDelta)
	if len(onReasoning) > 0 {
		parser.emitReasoning = onReasoning[0]
	}
	data, mimeType, err := PostStreamingBinary(ctx, config, path, body, parser.Consume)
	if err != nil {
		return nil, err
	}
	if !strings.Contains(strings.ToLower(mimeType), "event-stream") {
		var payload map[string]interface{}
		if err := json.Unmarshal(data, &payload); err != nil {
			return nil, fmt.Errorf("Agent 接口返回格式无效：%w", err)
		}
		return ParseAgentToolPayload(payload, protocol)
	}
	parser.Flush()
	return parser.Result()
}

type StreamingAgentToolCall struct {
	id        string
	name      string
	arguments string
}

type StreamingAgentParser struct {
	protocol      string
	buffer        string
	text          strings.Builder
	reasoning     strings.Builder
	toolCalls     map[int]*StreamingAgentToolCall
	toolCallByID  map[string]int
	completed     map[string]interface{}
	err           error
	emit          func(string)
	emitReasoning func(string)
}

func NewStreamingAgentParser(protocol string, emit func(string)) *StreamingAgentParser {
	return &StreamingAgentParser{protocol: protocol, toolCalls: map[int]*StreamingAgentToolCall{}, toolCallByID: map[string]int{}, emit: emit}
}

func (p *StreamingAgentParser) Consume(mimeType string, chunk []byte) {
	if p == nil || p.err != nil || !strings.Contains(strings.ToLower(mimeType), "event-stream") || len(chunk) == 0 {
		return
	}
	p.buffer += string(chunk)
	p.consumeFrames(false)
}

func (p *StreamingAgentParser) Flush() {
	if p == nil || p.err != nil {
		return
	}
	p.consumeFrames(true)
}

func (p *StreamingAgentParser) consumeFrames(flush bool) {
	for p.err == nil {
		match := sseFrameBoundaryPattern.FindStringIndex(p.buffer)
		if match == nil {
			break
		}
		p.consumeFrame(p.buffer[:match[0]])
		p.buffer = p.buffer[match[1]:]
	}
	if flush && p.err == nil && strings.TrimSpace(p.buffer) != "" {
		p.consumeFrame(p.buffer)
		p.buffer = ""
	}
}

func (p *StreamingAgentParser) consumeFrame(frame string) {
	var eventName string
	var dataLines []string
	for _, line := range strings.Split(strings.ReplaceAll(frame, "\r\n", "\n"), "\n") {
		switch {
		case strings.HasPrefix(line, "event:"):
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			dataLines = append(dataLines, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	raw := strings.TrimSpace(strings.Join(dataLines, "\n"))
	if raw == "" || raw == "[DONE]" {
		return
	}
	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		p.err = fmt.Errorf("Agent 流式事件解析失败：%w", err)
		return
	}
	if err := ValidateTextPayload(payload); err != nil {
		p.err = err
		return
	}
	switch p.protocol {
	case "responses":
		p.consumeResponsesEvent(eventName, payload)
	case "claude-api":
		p.consumeClaudeEvent(payload)
	default:
		p.consumeChatCompletionEvent(payload)
	}
}

func (p *StreamingAgentParser) consumeResponsesEvent(eventName string, payload map[string]interface{}) {
	eventType := firstNonEmpty(strings.TrimSpace(eventName), stringField(payload, "type"))
	switch eventType {
	case "response.output_text.delta", "output_text.delta":
		p.appendText(stringField(payload, "delta"))
	case "response.reasoning.delta", "response.reasoning_text.delta", "response.reasoning_summary_text.delta":
		p.appendReasoning(stringField(payload, "delta"))
	case "response.completed":
		p.completed, _ = payload["response"].(map[string]interface{})
	case "response.output_item.added":
		item, _ := payload["item"].(map[string]interface{})
		if stringField(item, "type") == "function_call" {
			index := IntField(payload, "output_index", len(p.toolCalls))
			p.setToolCall(index, firstNonEmpty(stringField(item, "call_id"), stringField(item, "id")), stringField(item, "name"), stringField(item, "arguments"))
		}
	case "response.function_call_arguments.delta":
		index := p.responseToolCallIndex(payload)
		p.toolCall(index).arguments += stringField(payload, "delta")
	case "response.function_call_arguments.done":
		index := p.responseToolCallIndex(payload)
		if arguments := stringField(payload, "arguments"); arguments != "" {
			p.toolCall(index).arguments = arguments
		}
	}
}

func (p *StreamingAgentParser) responseToolCallIndex(payload map[string]interface{}) int {
	itemID := firstNonEmpty(stringField(payload, "item_id"), stringField(payload, "call_id"))
	if index, ok := p.toolCallByID[itemID]; ok {
		return index
	}
	return IntField(payload, "output_index", len(p.toolCalls))
}

func (p *StreamingAgentParser) consumeChatCompletionEvent(payload map[string]interface{}) {
	choices, _ := payload["choices"].([]interface{})
	for _, value := range choices {
		choice, _ := value.(map[string]interface{})
		delta, _ := choice["delta"].(map[string]interface{})
		p.appendText(StreamContentText(delta["content"]))
		p.appendReasoning(firstNonEmpty(stringField(delta, "reasoning_content"), stringField(delta, "reasoning"), stringField(delta, "reasoning_text")))
		for fallbackIndex, toolValue := range InterfaceSlice(delta["tool_calls"]) {
			tool, _ := toolValue.(map[string]interface{})
			index := IntField(tool, "index", fallbackIndex)
			function, _ := tool["function"].(map[string]interface{})
			current := p.toolCall(index)
			if id := stringField(tool, "id"); id != "" {
				current.id = id
				p.toolCallByID[id] = index
			}
			if name := stringField(function, "name"); name != "" {
				current.name += name
			}
			current.arguments += stringField(function, "arguments")
		}
	}
}

func (p *StreamingAgentParser) consumeClaudeEvent(payload map[string]interface{}) {
	switch stringField(payload, "type") {
	case "content_block_start":
		block, _ := payload["content_block"].(map[string]interface{})
		index := IntField(payload, "index", len(p.toolCalls))
		switch stringField(block, "type") {
		case "text":
			p.appendText(stringField(block, "text"))
		case "thinking":
			p.appendReasoning(firstNonEmpty(stringField(block, "thinking"), stringField(block, "text")))
		case "tool_use":
			arguments := ""
			if input := block["input"]; input != nil {
				if encoded, err := json.Marshal(input); err == nil && string(encoded) != "{}" {
					arguments = string(encoded)
				}
			}
			p.setToolCall(index, stringField(block, "id"), stringField(block, "name"), arguments)
		}
	case "content_block_delta":
		delta, _ := payload["delta"].(map[string]interface{})
		index := IntField(payload, "index", len(p.toolCalls)-1)
		if stringField(delta, "type") == "text_delta" {
			p.appendText(stringField(delta, "text"))
		}
		if stringField(delta, "type") == "thinking_delta" {
			p.appendReasoning(firstNonEmpty(stringField(delta, "thinking"), stringField(delta, "text")))
		}
		if stringField(delta, "type") == "input_json_delta" {
			p.toolCall(index).arguments += stringField(delta, "partial_json")
		}
	case "error":
		errValue, _ := payload["error"].(map[string]interface{})
		p.err = errors.New(defaultString(stringField(errValue, "message"), "Claude 上游返回失败"))
	}
}

func ResultString(value map[string]interface{}, key string) string {
	return stringField(value, key)
}

func (p *StreamingAgentParser) appendText(delta string) {
	if delta == "" {
		return
	}
	p.text.WriteString(delta)
	if p.emit != nil {
		p.emit(delta)
	}
}

func (p *StreamingAgentParser) appendReasoning(delta string) {
	if delta == "" {
		return
	}
	p.reasoning.WriteString(delta)
	if p.emitReasoning != nil {
		p.emitReasoning(delta)
	}
}

func (p *StreamingAgentParser) toolCall(index int) *StreamingAgentToolCall {
	if index < 0 {
		index = 0
	}
	if p.toolCalls[index] == nil {
		p.toolCalls[index] = &StreamingAgentToolCall{}
	}
	return p.toolCalls[index]
}

func (p *StreamingAgentParser) setToolCall(index int, id string, name string, arguments string) {
	call := p.toolCall(index)
	call.id, call.name, call.arguments = id, name, arguments
	if id != "" {
		p.toolCallByID[id] = index
	}
}

func (p *StreamingAgentParser) Result() (map[string]interface{}, error) {
	if p.err != nil {
		return nil, p.err
	}
	if p.completed != nil {
		result, err := ParseAgentToolPayload(p.completed, p.protocol)
		if err != nil {
			return nil, err
		}
		if p.text.Len() > 0 {
			result["text"] = p.text.String()
		}
		if p.reasoning.Len() > 0 {
			result["reasoning"] = p.reasoning.String()
		}
		return result, nil
	}
	result := map[string]interface{}{"mode": "text", "text": p.text.String(), "toolCalls": []interface{}{}}
	if p.reasoning.Len() > 0 {
		result["reasoning"] = p.reasoning.String()
	}
	indices := make([]int, 0, len(p.toolCalls))
	for index := range p.toolCalls {
		indices = append(indices, index)
	}
	sort.Ints(indices)
	calls := make([]interface{}, 0, len(indices))
	for _, index := range indices {
		call := p.toolCalls[index]
		if call == nil || strings.TrimSpace(call.id) == "" || strings.TrimSpace(call.name) == "" {
			continue
		}
		arguments := call.arguments
		if strings.TrimSpace(arguments) == "" {
			arguments = "{}"
		}
		var parsed interface{}
		if err := json.Unmarshal([]byte(arguments), &parsed); err != nil {
			return nil, fmt.Errorf("Agent 工具参数不是完整 JSON：%w", err)
		}
		calls = append(calls, map[string]interface{}{"id": call.id, "type": "function", "function": map[string]interface{}{"name": call.name, "arguments": arguments}})
	}
	result["toolCalls"] = calls
	if p.text.Len() == 0 && len(calls) == 0 {
		return nil, errors.New("画布 Agent 接口没有返回内容")
	}
	return result, nil
}

func IntField(value map[string]interface{}, key string, fallback int) int {
	number, ok := value[key].(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return fallback
	}
	return int(number)
}

func PostStreamingText(ctx context.Context, config Config, path string, body map[string]interface{}, protocol string, onDelta func(string)) (string, error) {
	result, err := PostStreamingTextResult(ctx, config, path, body, protocol, onDelta)
	return result.Text, err
}

func PostStreamingTextResult(ctx context.Context, config Config, path string, body map[string]interface{}, protocol string, onDelta func(string)) (ProviderTextResult, error) {
	// 文本创作与 Agent 共用同一套 SSE 解析，确保正文、推理摘要和供应商错误语义一致。
	parsed, err := PostStreamingAgent(ctx, config, path, body, protocol, onDelta)
	if err != nil {
		return ProviderTextResult{}, err
	}
	result := ProviderTextResult{Text: stringField(parsed, "text"), Reasoning: stringField(parsed, "reasoning")}
	if result.Text == "" {
		return ProviderTextResult{}, errors.New("流式文本接口没有返回内容")
	}
	return result, nil
}

func ParseTextEventStream(data []byte, protocol string) (string, error) {
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 64<<10), len(data)+1)
	var text strings.Builder
	var eventName string
	var dataLines []string

	flush := func() error {
		if len(dataLines) == 0 {
			eventName = ""
			return nil
		}
		raw := strings.TrimSpace(strings.Join(dataLines, "\n"))
		dataLines = nil
		if raw == "" || raw == "[DONE]" {
			eventName = ""
			return nil
		}
		var payload map[string]interface{}
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return fmt.Errorf("流式文本事件解析失败：%w", err)
		}
		if eventName == "error" {
			if err := ValidateTextPayload(payload); err != nil {
				return err
			}
			return errors.New("上游流式文本请求失败")
		}
		if err := ValidateTextPayload(payload); err != nil {
			return err
		}
		if protocol == "responses" {
			text.WriteString(stringField(payload, "delta"))
		} else if protocol == "claude-api" {
			delta, _ := payload["delta"].(map[string]interface{})
			if stringField(delta, "type") == "text_delta" {
				text.WriteString(stringField(delta, "text"))
			}
		} else {
			choices, _ := payload["choices"].([]interface{})
			for _, choice := range choices {
				record, _ := choice.(map[string]interface{})
				delta, _ := record["delta"].(map[string]interface{})
				text.WriteString(StreamContentText(delta["content"]))
			}
		}
		eventName = ""
		return nil
	}

	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if err := flush(); err != nil {
				return "", err
			}
			continue
		}
		switch {
		case strings.HasPrefix(line, "event:"):
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			value := strings.TrimPrefix(line, "data:")
			dataLines = append(dataLines, strings.TrimPrefix(value, " "))
		}
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("读取流式文本响应失败：%w", err)
	}
	if err := flush(); err != nil {
		return "", err
	}
	if text.Len() == 0 {
		return "", errors.New("流式文本接口没有返回内容")
	}
	return text.String(), nil
}

func StreamContentText(value interface{}) string {
	if text, ok := value.(string); ok {
		return text
	}
	parts, ok := value.([]interface{})
	if !ok {
		return ""
	}
	var result strings.Builder
	for _, part := range parts {
		record, _ := part.(map[string]interface{})
		result.WriteString(stringField(record, "text"))
	}
	return result.String()
}

type StreamingTextDeltaParser struct {
	protocol string
	buffer   string
	emit     func(string)
}

func NewStreamingTextDeltaParser(protocol string, emit func(string)) *StreamingTextDeltaParser {
	return &StreamingTextDeltaParser{protocol: protocol, emit: emit}
}

func (p *StreamingTextDeltaParser) Consume(mimeType string, chunk []byte) {
	if p == nil || p.emit == nil || !strings.Contains(strings.ToLower(mimeType), "event-stream") || len(chunk) == 0 {
		return
	}
	p.buffer += string(chunk)
	p.consumeFrames(false)
}

func (p *StreamingTextDeltaParser) Flush() {
	if p == nil || p.emit == nil {
		return
	}
	p.consumeFrames(true)
}

func (p *StreamingTextDeltaParser) consumeFrames(flush bool) {
	for {
		match := sseFrameBoundaryPattern.FindStringIndex(p.buffer)
		if match == nil {
			break
		}
		p.consumeFrame(p.buffer[:match[0]])
		p.buffer = p.buffer[match[1]:]
	}
	if flush && strings.TrimSpace(p.buffer) != "" {
		p.consumeFrame(p.buffer)
		p.buffer = ""
	}
}

func (p *StreamingTextDeltaParser) consumeFrame(frame string) {
	var eventName string
	var dataLines []string
	for _, line := range strings.Split(strings.ReplaceAll(frame, "\r\n", "\n"), "\n") {
		switch {
		case strings.HasPrefix(line, "event:"):
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	raw := strings.TrimSpace(strings.Join(dataLines, "\n"))
	if raw == "" || raw == "[DONE]" {
		return
	}
	var payload map[string]interface{}
	if json.Unmarshal([]byte(raw), &payload) != nil {
		return
	}
	if delta := StreamingTextDelta(p.protocol, eventName, payload); delta != "" {
		p.emit(delta)
	}
}

func StreamingTextDelta(protocol string, eventName string, payload map[string]interface{}) string {
	if protocol == "responses" {
		eventType := firstNonEmpty(strings.TrimSpace(eventName), stringField(payload, "type"))
		if eventType == "response.output_text.delta" || eventType == "output_text.delta" || eventType == "" || eventType == "message" {
			return stringField(payload, "delta")
		}
		return ""
	}
	if protocol == "claude-api" {
		delta, _ := payload["delta"].(map[string]interface{})
		if stringField(delta, "type") == "text_delta" {
			return stringField(delta, "text")
		}
		return ""
	}
	choices, _ := payload["choices"].([]interface{})
	var text strings.Builder
	for _, choice := range choices {
		record, _ := choice.(map[string]interface{})
		delta, _ := record["delta"].(map[string]interface{})
		text.WriteString(StreamContentText(delta["content"]))
	}
	return text.String()
}
