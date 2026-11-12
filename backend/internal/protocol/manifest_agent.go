package protocol

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"
)

// Agent tool-calling requests and responses for declarative text interfaces.

func (a manifestAdapter) BuildAgent(_ context.Context, c AgentRequestContext) (RequestSpec, error) {
	if a.manifest.Agent == nil {
		return RequestSpec{}, fmt.Errorf("protocol %s has no agent operation", a.manifest.Metadata.ID)
	}
	request := GenerationRequest{Model: c.Model, Extra: map[string]any{"agent": c.Request}}
	return a.buildOperation(*a.manifest.Agent, request, "")
}
func (a manifestAdapter) ParseAgent(_ context.Context, body []byte) (AgentResult, error) {
	if a.manifest.AgentResponse == nil {
		return AgentResult{}, fmt.Errorf("protocol %s has no agent response mapping", a.manifest.Metadata.ID)
	}
	payload, err := decodeObject(body)
	if err != nil {
		return AgentResult{}, err
	}
	response := a.manifest.AgentResponse
	result := AgentResult{Text: firstPathValue(payload, response.TextPaths...), Reasoning: firstPathValue(payload, response.ReasoningPaths...)}
	if response.ToolCallsPath == "" {
		return result, nil
	}
	for index, item := range arrayValue(pathValue(payload, response.ToolCallsPath)) {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		call := AgentToolCall{
			ID:               firstPathValue(object, response.ToolCallIDPaths...),
			Name:             firstPathValue(object, response.ToolCallNamePaths...),
			Arguments:        firstPathJSONValue(object, response.ToolCallArgsPaths...),
			ThoughtSignature: firstPathValue(object, response.ToolCallSignaturePaths...),
		}
		if strings.TrimSpace(call.Name) != "" {
			if strings.TrimSpace(call.ID) == "" {
				call.ID = syntheticAgentToolCallID(body, index)
			}
			result.ToolCalls = append(result.ToolCalls, call)
		}
	}
	return result, nil
}

func syntheticAgentToolCallID(body []byte, index int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s#%d", body, index)))
	return fmt.Sprintf("call_%x", sum[:8])
}
