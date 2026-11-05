package generation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"time"

	"infinite-canvas/backend/internal/pluginhost"
	"infinite-canvas/backend/internal/protocol"

	"github.com/google/uuid"
)

// runModuleProviderTask 运行插件 JS 实现的生成接口，规则与声明式插件相同：
// 恢复的任务只查询、不再提交；提交抛错时无法证明没发出，按"提交结果不明"处理、不重试；
// 每次调用像上游请求一样记入调用日志，任务号由同一条回执规则记下；成功后由宿主下载结果。
func runModuleProviderTask(ctx context.Context, input Input, provider protocol.ModuleProvider, policy VideoPollPolicy) (map[string]interface{}, error) {
	request := ProtocolRequestFromInput(input)
	taskID := ResumedProviderRequestID(ctx)
	if taskID == "" {
		key := SubmissionKeyFromContext(ctx)
		if key == "" {
			key = uuid.NewString()
		}
		request.Extra["idempotencyKey"] = key
		var created protocol.CreateResult
		if err := callModuleProvider(WithRequestKind(ctx, "create"), input, provider, "submit", request, "", &created); err != nil {
			return nil, SubmissionUnknownError{Cause: err}
		}
		taskID = created.TaskID
		switch created.Status {
		case protocol.StatusFailed, protocol.StatusCancelled:
			return nil, ProtocolResultError(created.Message, taskID)
		case protocol.StatusSucceeded:
			return FinishProtocolAdapterResult(ctx, input, provider, request, taskID, created.Result, policy)
		}
		if taskID == "" {
			return nil, SubmissionUnknownError{Cause: errors.New("插件提交后没有返回任务号，请到服务商处核对任务记录")}
		}
	}
	return RunVideoPollLoop(ctx, taskID, policy, func(ctx context.Context) (VideoPollOutcome, error) {
		var state protocol.PollResult
		if err := callModuleProvider(WithRequestKind(ctx, "poll"), input, provider, "query", request, taskID, &state); err != nil {
			return VideoPollOutcome{}, err
		}
		switch state.Status {
		case protocol.StatusSucceeded:
			result, err := FinishProtocolAdapterResult(ctx, input, provider, request, taskID, state.Result, policy)
			return VideoPollOutcome{Done: err == nil, Result: result}, err
		case protocol.StatusFailed, protocol.StatusCancelled:
			return VideoPollOutcome{}, ProtocolResultError(state.Message, taskID)
		}
		return VideoPollOutcome{}, nil
	})
}

// queryModuleProviderOnce 只查询一次已有任务，供人工核对失败任务使用。
func queryModuleProviderOnce(ctx context.Context, input Input, provider protocol.ModuleProvider, taskID string) (map[string]interface{}, string, error) {
	request := ProtocolRequestFromInput(input)
	var state protocol.PollResult
	if err := callModuleProvider(WithRequestKind(ctx, "poll"), input, provider, "query", request, taskID, &state); err != nil {
		return nil, "", err
	}
	status := string(state.Status)
	switch state.Status {
	case protocol.StatusSucceeded:
		result, err := FinishProtocolAdapterResult(ctx, input, provider, request, taskID, state.Result, DefaultVideoPollPolicy())
		return result, status, err
	case protocol.StatusFailed, protocol.StatusCancelled:
		return nil, status, ProtocolResultError(state.Message, taskID)
	case protocol.StatusPending, protocol.StatusProcessing:
		return nil, status, nil
	default:
		return nil, status, fmt.Errorf("插件任务 %s 返回未知状态：%s", taskID, status)
	}
}

func callModuleProvider(ctx context.Context, input Input, provider protocol.ModuleProvider, method string, request protocol.GenerationRequest, taskID string, out any) error {
	if !filepath.IsAbs(provider.Module) {
		return fmt.Errorf("插件 %s 的生成接口没有安装目录", provider.Plugin)
	}
	args := map[string]any{"request": request, "config": map[string]any{"baseUrl": input.Config.BaseURL, "apiKey": input.Config.APIKey}}
	if taskID != "" {
		args["taskId"] = taskID
	}
	var raw json.RawMessage
	startedAt := time.Now()
	err := pluginhost.Do(ctx, pluginhost.Call{Plugin: provider.Plugin, Version: provider.Info.Version, Module: provider.Module, Method: method, Args: args}, &raw)
	observeModuleCall(ctx, provider, method, taskID, startedAt, raw, err)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("插件 %s 返回的结果格式不对：%w", provider.Plugin, err)
	}
	return nil
}

// observeModuleCall 把插件调用记成一次上游调用：提交回复里的 taskId 以 task_id 写入，
// 查询路径带上任务号，回执、诊断和恢复都沿用 HTTP 渠道那一套规则。
func observeModuleCall(ctx context.Context, provider protocol.ModuleProvider, method, taskID string, startedAt time.Time, raw json.RawMessage, callErr error) {
	runtime, ok := RuntimeFromContext(ctx)
	if !ok || runtime.Receipts == nil {
		return
	}
	target := &url.URL{Scheme: "plugin", Host: provider.Plugin, Path: "/tasks"}
	httpMethod := http.MethodPost
	if method != "submit" {
		target.Path = "/tasks/" + url.PathEscape(taskID)
		httpMethod = http.MethodGet
	}
	req, err := http.NewRequestWithContext(ctx, httpMethod, target.String(), nil)
	if err != nil {
		return
	}
	observation := TransportObservation{Request: req, StartedAt: startedAt, Err: callErr, Dispatched: true}
	if callErr == nil {
		observation.StatusCode = http.StatusOK
		var reply map[string]any
		if json.Unmarshal(raw, &reply) == nil && reply != nil {
			if id, _ := reply["taskId"].(string); id != "" {
				reply["task_id"] = id
			}
			observation.Body, _ = json.Marshal(reply)
		}
	}
	runtime.Receipts.Observe(observation)
}
