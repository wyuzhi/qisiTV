package generation

// 声明式协议插件宿主与接口类型校验。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/protocol"

	"github.com/google/uuid"
)

// runDeclarativeProtocolTask 是 JSON manifest 插件的宿主运行时。
// manifest 只能描述请求/响应映射；凭证、出站安全策略、轮询和结果下载必须由宿主统一掌握，
// 这样插件不能绕过服务端的鉴权、超时和 SSRF 防护边界。
func RunDeclarativeProtocolTask(ctx context.Context, input Input) (map[string]interface{}, error) {
	adapter, ok := DeclarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType)
	if !ok {
		return nil, fmt.Errorf("接口类型 %s 未安装声明式适配器", input.Config.InterfaceType)
	}
	return RunProtocolAdapterTask(ctx, input, adapter)
}

func RunProtocolAdapterTask(ctx context.Context, input Input, adapter protocol.Adapter) (map[string]interface{}, error) {
	return RunProtocolAdapterTaskWithPolicy(ctx, input, adapter, DeclarativeProtocolPollPolicy(input.Mode))
}

func DeclarativeProtocolPollPolicy(mode string) VideoPollPolicy {
	if mode == "video" {
		return DefaultVideoPollPolicy()
	}
	return VideoPollPolicy{
		Interval:          2500 * time.Millisecond,
		MaxNotFoundMisses: 1,
		MaxDownloadTries:  3,
		Sleep:             SleepContext,
	}
}

func RunProtocolAdapterTaskWithPolicy(ctx context.Context, input Input, adapter protocol.Adapter, policy VideoPollPolicy) (map[string]interface{}, error) {
	if input.Mode == "video" {
		policy = videoPollPolicyForConfig(ctx, input.Config, policy)
	}
	// create、poll、download 是同一个外部任务的三个阶段：任一阶段失败都向上返回真实错误，
	// 不把“已提交但结果未知”伪装成成功，也不把下载失败降级成空结果。
	request := ProtocolRequestFromInput(input)
	taskID := ResumedProviderRequestID(ctx)
	var created protocol.CreateResult
	if taskID == "" {
		// 幂等键只存在于宿主请求元数据中，声明式插件可以把它映射到 Header，
		// 但不能把宿主控制字段泄漏到供应商 JSON body。恢复已有 taskID 时不会进入 create 分支。
		key := SubmissionKeyFromContext(ctx)
		if key == "" {
			key = uuid.NewString()
		}
		request.Extra["idempotencyKey"] = key
		spec, err := adapter.BuildCreate(ctx, protocol.RequestContext{BaseURL: input.Config.BaseURL, Request: request})
		if err != nil {
			return nil, RequestPreparationError{Cause: err}
		}
		if input.Mode == "image" {
			for index, image := range request.Images {
				if image.DataURL == "" {
					continue
				}
				mime, data, err := DecodeProviderDataURL(image.DataURL)
				if err == nil {
					err = ValidateImageArtifact(data, mime)
				}
				if err != nil {
					return nil, RequestPreparationError{Cause: fmt.Errorf("参考图片 %d MIME 类型无效或内容不是图片：%w", index+1, err)}
				}
			}
		}
		if result, handled, streamErr := tryStreamingDeclarativeTextCreate(ctx, input, adapter, request, spec, policy); handled {
			return result, streamErr
		}
		var body []byte
		var responseType string
		if input.Mode == "audio" {
			var mime string
			body, mime, err = ExecuteProtocolBinaryRequest(WithRequestKind(ctx, "create"), input.Config, spec)
			if err == nil && strings.Contains(strings.ToLower(mime), "text/event-stream") {
				body, mime, err = readSpeechAudioEvents(ctx, body)
			}
			if err == nil && input.Config.InterfaceType == string(model.ChannelInterfaceOpenAIAudio) {
				_, err = ValidateGeneratedAudio(mime, body, input.Config.AudioFormat)
			}
		} else {
			body, responseType, err = ExecuteProtocolBinaryRequest(WithRequestKind(ctx, "create"), input.Config, spec)
		}
		if err != nil {
			if input.Mode == "video" || IsLikeAIProtocol(input.Config.InterfaceType) {
				return nil, UncertainVideoSubmission(ctx, err)
			}
			return nil, err
		}
		if parser, ok := adapter.(protocol.CreateResponseParser); ok && input.Mode == "image" {
			created, err = parser.ParseCreateResponse(ctx, body, responseType)
		} else {
			created, err = adapter.ParseCreate(ctx, body)
		}
		if err != nil {
			if input.Mode == "video" || IsLikeAIProtocol(input.Config.InterfaceType) {
				return nil, SubmissionUnknownError{Cause: err}
			}
			return nil, err
		}
		taskID = created.TaskID
		if taskID == "" {
			extracted, extractErr := ExtractProviderTaskID(body)
			if extractErr != nil {
				return nil, extractErr
			}
			taskID = extracted
		}
		if created.Status == protocol.StatusFailed || created.Status == protocol.StatusCancelled {
			return nil, ProtocolResultError(created.Message, taskID, body)
		}
		if created.Status == protocol.StatusSucceeded {
			return FinishProtocolAdapterResult(ctx, input, adapter, request, taskID, created.Result, policy)
		}
		if taskID == "" {
			return nil, SubmissionUnknownError{Cause: errors.New("创建请求未返回可查询的任务 ID，请核对供应商任务记录")}
		}
	}

	return RunVideoPollLoop(ctx, taskID, policy, func(ctx context.Context) (VideoPollOutcome, error) {
		spec, err := adapter.BuildPoll(ctx, protocol.PollContext{BaseURL: input.Config.BaseURL, Model: request.Model, Request: request, TaskID: taskID})
		if err != nil {
			return VideoPollOutcome{}, err
		}
		body, err := ExecuteProtocolRequest(WithRequestKind(ctx, "poll"), input.Config, spec)
		if err != nil {
			return VideoPollOutcome{}, err
		}
		state, err := adapter.ParsePoll(ctx, protocol.PollContext{BaseURL: input.Config.BaseURL, Model: request.Model, Request: request, TaskID: taskID}, body)
		if err != nil {
			return VideoPollOutcome{}, err
		}
		if state.TaskID != "" {
			taskID = state.TaskID
		}
		switch state.Status {
		case protocol.StatusSucceeded:
			result, err := FinishProtocolAdapterResult(ctx, input, adapter, request, taskID, state.Result, policy)
			return VideoPollOutcome{Done: err == nil, Result: result}, err
		case protocol.StatusFailed, protocol.StatusCancelled:
			return VideoPollOutcome{}, ProtocolResultError(state.Message, taskID, body)
		}
		return VideoPollOutcome{}, nil
	})
}

func ExtractProviderTaskID(body []byte) (string, error) {
	var payload map[string]interface{}
	if json.Unmarshal(body, &payload) != nil {
		return "", nil
	}
	id, err := firstJSONString(payload, "id", "task_id", "taskId", "request_id", "name")
	if id != "" {
		return id, nil
	}
	if data, ok := payload["data"].(map[string]interface{}); ok {
		nested, nestedErr := firstJSONString(data, "id", "task_id", "taskId", "request_id")
		if nested != "" {
			return nested, nil
		}
		if nestedErr != nil {
			return "", nestedErr
		}
	}
	return "", err
}

// queryProtocolAdapterVideoTask 只读取一次已有的声明式 Provider 任务。
// 人工恢复走此路径，因此检查本地失败任务时绝不会创建第二个上游任务。
func QueryProtocolAdapterVideoTask(ctx context.Context, input Input, adapter protocol.Adapter, taskID string) (map[string]interface{}, string, error) {
	request := ProtocolRequestFromInput(input)
	pollContext := protocol.PollContext{BaseURL: input.Config.BaseURL, Model: request.Model, Request: request, TaskID: taskID}
	spec, err := adapter.BuildPoll(ctx, pollContext)
	if err != nil {
		return nil, "", err
	}
	body, err := ExecuteProtocolRequest(WithRequestKind(ctx, "poll"), input.Config, spec)
	if err != nil {
		return nil, "", err
	}
	state, err := adapter.ParsePoll(ctx, pollContext, body)
	if err != nil {
		return nil, "", err
	}
	providerStatus := string(state.Status)
	switch state.Status {
	case protocol.StatusSucceeded:
		result, err := FinishProtocolAdapterResult(ctx, input, adapter, request, taskID, state.Result, DefaultVideoPollPolicy())
		return result, providerStatus, err
	case protocol.StatusFailed, protocol.StatusCancelled:
		return nil, providerStatus, ProtocolResultError(state.Message, taskID, body)
	case protocol.StatusPending, protocol.StatusProcessing:
		return nil, providerStatus, nil
	default:
		return nil, providerStatus, fmt.Errorf("声明式协议任务 %s 返回未知状态：%s", taskID, providerStatus)
	}
}

// tryStreamingDeclarativeTextCreate 让已知文本线协议在 Resolve 后的 StreamText 真正到达 OnTextDelta。
// 其它声明式插件仍走 JSON 创建；上游忽略 stream 并返回 JSON 时回退 ParseCreate。
func tryStreamingDeclarativeTextCreate(ctx context.Context, input Input, adapter protocol.Adapter, request protocol.GenerationRequest, spec protocol.RequestSpec, policy VideoPollPolicy) (map[string]interface{}, bool, error) {
	if input.Mode != "text" || !input.StreamText {
		return nil, false, nil
	}
	wire := streamingTextWire(input.Config.InterfaceType)
	if wire == "" {
		return nil, false, nil
	}
	body := ProtocolBodyObject(spec.Body)
	if body == nil {
		return nil, true, errors.New("声明式文本请求体必须是 JSON 对象")
	}
	body["stream"] = true
	if wire == "chat-completion" {
		if err := ensureChatCompletionStreamUsage(body); err != nil {
			return nil, true, err
		}
	}
	spec.Body = body
	parser := NewStreamingAgentParser(wire, input.OnTextDelta)
	parser.emitReasoning = input.OnReasoningDelta
	data, mime, err := ExecuteProtocolBinaryRequestWithConsumer(WithRequestKind(ctx, "create"), input.Config, spec, parser.Consume)
	if err != nil {
		return nil, true, err
	}
	if strings.Contains(strings.ToLower(mime), "event-stream") {
		parser.Flush()
		parsed, err := parser.Result()
		if err != nil {
			return nil, true, err
		}
		if strings.TrimSpace(stringField(parsed, "text")) == "" {
			return nil, true, errors.New("流式文本接口没有返回内容")
		}
		result := map[string]interface{}{"mode": "text", "text": stringField(parsed, "text")}
		if reasoning := strings.TrimSpace(stringField(parsed, "reasoning")); reasoning != "" {
			result["reasoning"] = reasoning
		}
		return result, true, nil
	}
	created, err := adapter.ParseCreate(ctx, data)
	if err != nil {
		return nil, true, err
	}
	taskID := created.TaskID
	if taskID == "" {
		if extracted, extractErr := ExtractProviderTaskID(data); extractErr == nil {
			taskID = extracted
		}
	}
	if created.Status == protocol.StatusFailed || created.Status == protocol.StatusCancelled {
		return nil, true, ProtocolResultError(created.Message, taskID, data)
	}
	if created.Status == protocol.StatusSucceeded {
		result, finishErr := FinishProtocolAdapterResult(ctx, input, adapter, request, taskID, created.Result, policy)
		return result, true, finishErr
	}
	return nil, true, SubmissionUnknownError{Cause: errors.New("流式文本创建未返回最终结果")}
}

func streamingTextWire(interfaceType string) string {
	switch strings.TrimSpace(interfaceType) {
	case "chat-completion":
		return "chat-completion"
	case string(model.ChannelInterfaceOpenAIResponse), "responses":
		return "responses"
	case string(model.ChannelInterfaceClaudeAPI):
		return "claude-api"
	default:
		return ""
	}
}

func ValidateGenerationInterface(mode string, interfaceType string) error {
	// Standalone callers (including legacy tests and migration tools) may not
	// have a Service/plugin runtime. Use the shipped declarative catalog first;
	// fall back to host builtins only when the package catalog is unavailable.
	registry := LoadOfficialFallbackRegistry()
	if registry == nil {
		registry = protocol.Builtins()
	} else if _, ok := registry.Resolve(strings.TrimSpace(interfaceType)); !ok {
		// A deployment may ship only a subset of the optional plugin catalog.
		// Preserve the host-backed builtins for standalone validation instead of
		// reporting a false "not installed" error for those interfaces.
		if _, builtinOK := protocol.Builtins().Resolve(strings.TrimSpace(interfaceType)); builtinOK {
			registry = protocol.Builtins()
		}
	}
	return ValidateGenerationInterfaceWithRegistry(registry, mode, interfaceType)
}

func ValidateGenerationInterfaceWithRegistry(registry *protocol.Registry, mode string, interfaceType string) error {
	interfaceType = strings.TrimSpace(interfaceType)
	if interfaceType == "" {
		return nil
	}
	adapter, ok := registry.Resolve(interfaceType)
	if !ok {
		return fmt.Errorf("接口类型 %s 未安装", interfaceType)
	}
	metadata := adapter.Metadata()
	if !metadata.Enabled || metadata.UnavailableReason != "" {
		return fmt.Errorf("接口类型 %s 当前不可用：%s", interfaceType, metadata.UnavailableReason)
	}
	if mode != "" && !ProtocolCapabilityMatches(metadata, protocol.Capability(mode)) {
		return fmt.Errorf("接口类型 %s 不支持%s生成", interfaceType, mode)
	}
	return nil
}

func ProtocolCapabilityMatches(metadata protocol.Metadata, capability protocol.Capability) bool {
	for _, item := range metadata.Categories {
		if item == capability {
			return true
		}
	}
	return false
}
