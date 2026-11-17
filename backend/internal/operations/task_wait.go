package operations

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

const (
	taskWaitDefaultTimeout = 25 * time.Second
	taskWaitMaxTimeout     = 25 * time.Second
	taskWaitMaxTasks       = 8
)

// taskWaitPollInterval 是任务状态的轮询间隔。等待必须发生在服务端，调用方只发一次请求；
// 目前没有可复用的任务事件流，所以按间隔读取已持久化的任务投影。
var taskWaitPollInterval = 500 * time.Millisecond

var errTaskWaitCanvasUnreadable = errors.New("画布内容不可读")

func registerTaskWaitOp(r *Registry) {
	r.Register(Op{
		ID:       "task.wait",
		Summary:  "等待生成任务完成；超时返回 pending 和原 taskId，不返回错误",
		ReadOnly: true,
		Scope:    ScopeWorkspaceRead,
		// 外部客户端先用；内置宿主迁移到 task.wait 前，不把等待工具暴露给内置模型。
		ExternalOnly: true,
		Params: json.RawMessage(`{"type":"object","properties":{` +
			`"taskId":{"type":"string","description":"单个任务 ID"},` +
			`"taskIds":{"type":"array","items":{"type":"string"},"maxItems":8,"description":"最多 8 个任务 ID"},` +
			`"canvasId":{"type":"string","description":"可选：和 nodeId 一起检查产物是否已绑定到该节点"},` +
			`"nodeId":{"type":"string","description":"可选：和 canvasId 一起检查产物是否已绑定到该节点"},` +
			`"timeoutMs":{"type":"integer","minimum":0,"maximum":25000,"description":"最多等 25000 毫秒，默认 25000"}}}`),
		Handler: opTaskWait,
	})
}

type taskWaitArgs struct {
	TaskID    string   `json:"taskId"`
	TaskIDs   []string `json:"taskIds"`
	CanvasID  string   `json:"canvasId"`
	NodeID    string   `json:"nodeId"`
	TimeoutMs *int     `json:"timeoutMs"`
}

func opTaskWait(ctx *Context, params json.RawMessage) (any, error) {
	var args taskWaitArgs
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	ids := taskWaitIDs(args)
	if len(ids) == 0 {
		return nil, InvalidArg("invalid_params", "taskId 或 taskIds 必填")
	}
	if len(ids) > taskWaitMaxTasks {
		return nil, InvalidArg("invalid_batch", "一次最多等待 8 个任务")
	}
	timeout := taskWaitDefaultTimeout
	if args.TimeoutMs != nil {
		ms := *args.TimeoutMs
		if ms < 0 {
			return nil, InvalidArg("invalid_timeout", "timeoutMs 不能小于 0")
		}
		if ms > int(taskWaitMaxTimeout/time.Millisecond) {
			ms = int(taskWaitMaxTimeout / time.Millisecond)
		}
		timeout = time.Duration(ms) * time.Millisecond
	}

	observation := awaitTaskIDs(ctx.Context, ctx.Domain, ctx.UserID, ids, timeout)
	if len(observation.missing) > 0 {
		return nil, newError(CodeNotFound, "task_not_found", "任务不存在",
			map[string]any{"taskIds": observation.missing})
	}
	result := taskWaitResult{
		TaskIDs:           ids,
		Pending:           observation.pending,
		TimedOut:          observation.timedOut,
		Cancelled:         observation.cancelled,
		Completed:         observation.completed,
		Failed:            observation.failed,
		FailedTaskIDs:     observation.failedTaskIDs,
		ObservationFailed: observation.observationFailed,
		Tasks:             observation.views,
	}
	if result.Tasks == nil {
		result.Tasks = []taskWaitTaskView{}
	}
	canvasID := strings.TrimSpace(args.CanvasID)
	nodeID := strings.TrimSpace(args.NodeID)
	if canvasID != "" && nodeID != "" {
		bound, err := taskWaitNodeBound(ctx.Domain, ctx.UserID, canvasID, nodeID, ids)
		result.CanvasID = canvasID
		result.NodeID = nodeID
		result.Bound = &bound
		if err != nil {
			result.BindingObservationFailed = true
		}
	}
	return result, nil
}

// taskWaitIDs 只接受一个身份来源的优先顺序：显式 taskId 优先于 taskIds，
// 与模拟后端一致；空串和重复 ID 会被丢掉，顺序保持调用方给出的顺序。
func taskWaitIDs(args taskWaitArgs) []string {
	raw := args.TaskIDs
	if strings.TrimSpace(args.TaskID) != "" {
		raw = []string{args.TaskID}
	}
	seen := map[string]bool{}
	ids := make([]string, 0, len(raw))
	for _, id := range raw {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids
}

type taskWaitObservation struct {
	views             []taskWaitTaskView
	missing           []string
	failedTaskIDs     []string
	pending           bool
	timedOut          bool
	cancelled         bool
	completed         bool
	failed            bool
	observationFailed bool
	deadlineReached   bool
}

type taskWaitTaskView struct {
	TaskID      string             `json:"taskId"`
	Type        string             `json:"type"`
	Status      string             `json:"status"`
	Progress    int                `json:"progress"`
	Outputs     []model.TaskOutput `json:"outputs"`
	ResultState string             `json:"resultState"`
	Error       string             `json:"error,omitempty"`
	State       string             `json:"state"`
	Reason      string             `json:"reason"`
	CreatedAt   time.Time          `json:"createdAt"`
	UpdatedAt   time.Time          `json:"updatedAt"`
}

type taskWaitResult struct {
	Tasks                    []taskWaitTaskView `json:"tasks"`
	TaskIDs                  []string           `json:"taskIds"`
	Pending                  bool               `json:"pending"`
	TimedOut                 bool               `json:"timedOut"`
	Cancelled                bool               `json:"cancelled"`
	Completed                bool               `json:"completed"`
	Failed                   bool               `json:"failed"`
	FailedTaskIDs            []string           `json:"failedTaskIds,omitempty"`
	ObservationFailed        bool               `json:"observationFailed,omitempty"`
	CanvasID                 string             `json:"canvasId,omitempty"`
	NodeID                   string             `json:"nodeId,omitempty"`
	Bound                    *bool              `json:"bound,omitempty"`
	BindingObservationFailed bool               `json:"bindingObservationFailed,omitempty"`
}

// task.wait 的判定集中在这一处；内置宿主迁移后删除 JS 版本，避免两处漂移。
// 排队、下载中、保存中都是未完成；物化失败是失败；成功且需要保存的产物都已入库才算完成。
const (
	taskWaitQueued      = "queued"
	taskWaitRunning     = "running"
	taskWaitDownloading = "downloading"
	taskWaitSaving      = "saving"
	taskWaitCompleted   = "completed"
	taskWaitFailed      = "failed"
)

type taskWaitState struct {
	State  string
	Reason string
}

func taskWaitStateOf(task model.Task) taskWaitState {
	phase := taskWaitPhase(task)
	if task.Status == model.TaskStatusCancelled {
		return taskWaitState{taskWaitFailed, "cancelled"}
	}
	if task.Status == model.TaskStatusFailed {
		if phase == "retrievable" {
			return taskWaitState{taskWaitDownloading, "result_retrievable"}
		}
		if phase == "fetching" || phase == "running" {
			return taskWaitState{taskWaitSaving, "result_pending"}
		}
		return taskWaitState{taskWaitFailed, "task_failed"}
	}
	if task.Status == model.TaskStatusSucceeded {
		if taskWaitMaterializationFailed(task) {
			return taskWaitState{taskWaitFailed, "materialization_failed"}
		}
		if taskWaitSaved(task) {
			if len(task.Outputs) == 0 {
				return taskWaitState{taskWaitCompleted, "no_outputs"}
			}
			return taskWaitState{taskWaitCompleted, "saved"}
		}
		if taskWaitIsDownloading(task) {
			return taskWaitState{taskWaitDownloading, "downloading"}
		}
		return taskWaitState{taskWaitSaving, "saving"}
	}
	if task.Status == model.TaskStatusQueued {
		return taskWaitState{taskWaitQueued, "queued"}
	}
	return taskWaitState{taskWaitRunning, "running"}
}

func taskWaitPhase(task model.Task) string {
	if task.Outcome == nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(task.Outcome.Phase))
}

// taskWaitSaved 要求任务成功，且结果里声明的媒体产物都已入库。
// 文本、转写等结果里没有媒体产物的任务，成功即完成；媒体任务即使成功，
// 只要结果里还有待保存的产物，或结果是不可解析/不可用/零产物的媒体形状，
// 就仍然是未完成。媒体形状的判定由 task 包的 InspectResultJSON 统一给出。
func taskWaitSaved(task model.Task) bool {
	if task.Status != model.TaskStatusSucceeded {
		return false
	}
	if phase := taskWaitPhase(task); phase != "" && phase != "ready" {
		return false
	}
	if state := strings.ToLower(strings.TrimSpace(task.ResultState)); state != "" && state != "ready" && state != "succeeded" {
		return false
	}
	if len(task.Outputs) > 0 {
		for _, output := range task.Outputs {
			if strings.TrimSpace(output.ResourceID) == "" || output.MaterializationErrorCode != "" {
				return false
			}
		}
		return true
	}
	if strings.TrimSpace(task.ResultJSON) == "" {
		return false
	}
	outputs, unusable := localtask.InspectResultJSON(task.ResultJSON, task.Type)
	if unusable != "" {
		return false
	}
	return len(outputs) == 0
}

func taskWaitMaterializationFailed(task model.Task) bool {
	if task.Status != model.TaskStatusSucceeded {
		return false
	}
	phase := taskWaitPhase(task)
	if phase == "failed" {
		return true
	}
	if strings.EqualFold(strings.TrimSpace(task.ResultState), localtask.ResultStateFailedPermanent) {
		return true
	}
	if strings.EqualFold(strings.TrimSpace(task.ResultState), localtask.ResultStateFailedRetryable) {
		return false
	}
	if phase == "fetching" || phase == "retrievable" {
		return false
	}
	if len(task.Outputs) == 0 {
		return false
	}
	settled, hasError := true, false
	for _, output := range task.Outputs {
		if strings.TrimSpace(output.ResourceID) == "" && output.MaterializationErrorCode == "" {
			settled = false
		}
		if output.MaterializationErrorCode != "" {
			hasError = true
		}
	}
	return settled && hasError
}

func taskWaitIsDownloading(task model.Task) bool {
	if task.Status == model.TaskStatusFailed && taskWaitPhase(task) == "retrievable" {
		return true
	}
	if task.Delivery == nil {
		return false
	}
	for _, output := range task.Delivery.Outputs {
		switch output.State {
		case "downloading", "retrying", "waiting":
			return true
		}
	}
	return false
}

func awaitTaskIDs(ctx context.Context, domain Domain, userID string, ids []string, timeout time.Duration) taskWaitObservation {
	if ctx == nil {
		ctx = context.Background()
	}
	deadline := time.Now().Add(timeout)
	firstPass := true
	for {
		observation := readTaskWaitObservation(ctx, domain, userID, ids, deadline, firstPass)
		firstPass = false
		if observation.cancelled {
			observation.pending = true
			return observation
		}
		if len(observation.missing) > 0 {
			return observation
		}
		if observation.settled(len(ids)) {
			observation.completed = observation.allCompleted(len(ids))
			observation.failed = observation.anyFailed()
			return observation
		}
		if observation.deadlineReached || !time.Now().Before(deadline) {
			observation.pending = true
			observation.timedOut = true
			return observation
		}
		wait := taskWaitPollInterval
		if remaining := time.Until(deadline); remaining < wait {
			wait = remaining
		}
		if wait <= 0 {
			observation.pending = true
			observation.timedOut = true
			return observation
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			observation.pending = true
			observation.cancelled = true
			return observation
		case <-timer.C:
		}
	}
}

func readTaskWaitObservation(ctx context.Context, domain Domain, userID string, ids []string, deadline time.Time, firstPass bool) taskWaitObservation {
	observation := taskWaitObservation{views: make([]taskWaitTaskView, 0, len(ids))}
	for index, id := range ids {
		if ctx.Err() != nil {
			observation.cancelled = true
			return observation
		}
		// 第一遍至少拿到一次完整快照；之后过了截止时间，只允许再读批次里的第一个任务，
		// 用来把最近一次快照带回超时响应，其余任务不再发起新的查询。
		if !firstPass && index > 0 && !time.Now().Before(deadline) {
			observation.deadlineReached = true
			return observation
		}
		task, err := domain.Task(userID, id)
		if err != nil {
			if isNotFoundError(err) {
				observation.missing = append(observation.missing, id)
			} else {
				observation.observationFailed = true
			}
			continue
		}
		if task == nil {
			observation.missing = append(observation.missing, id)
			continue
		}
		state := taskWaitStateOf(*task)
		outputs := task.Outputs
		if outputs == nil {
			outputs = []model.TaskOutput{}
		}
		observation.views = append(observation.views, taskWaitTaskView{
			TaskID:      task.ID,
			Type:        task.Type,
			Status:      string(task.Status),
			Progress:    task.Progress,
			Outputs:     outputs,
			ResultState: task.ResultState,
			Error:       task.Error,
			State:       state.State,
			Reason:      state.Reason,
			CreatedAt:   task.CreatedAt,
			UpdatedAt:   task.UpdatedAt,
		})
		if state.State == taskWaitFailed {
			observation.failedTaskIDs = append(observation.failedTaskIDs, task.ID)
		}
	}
	return observation
}

func (o taskWaitObservation) settled(requested int) bool {
	if len(o.views) != requested {
		return false
	}
	for _, view := range o.views {
		if view.State != taskWaitCompleted && view.State != taskWaitFailed {
			return false
		}
	}
	return true
}

func (o taskWaitObservation) allCompleted(requested int) bool {
	if len(o.views) != requested {
		return false
	}
	for _, view := range o.views {
		if view.State != taskWaitCompleted {
			return false
		}
	}
	return true
}

func (o taskWaitObservation) anyFailed() bool {
	return len(o.failedTaskIDs) > 0
}

func taskWaitNodeBound(domain Domain, userID, canvasID, nodeID string, taskIDs []string) (bool, error) {
	raw, err := domain.UserCanvasProject(userID, canvasID)
	if err != nil {
		return false, err
	}
	if len(raw) == 0 {
		return false, errTaskWaitCanvasUnreadable
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return false, err
	}
	wanted := make(map[string]bool, len(taskIDs))
	for _, id := range taskIDs {
		wanted[id] = true
	}
	for _, item := range canvasNodes(doc) {
		node, ok := item.(map[string]any)
		if !ok || nodeStringValue(node["id"]) != nodeID {
			continue
		}
		metadata, _ := node["metadata"].(map[string]any)
		if metadata == nil || !wanted[nodeStringValue(metadata["taskId"])] {
			return false, nil
		}
		if nodeStringValue(metadata["status"]) != "success" {
			return false, nil
		}
		if !strings.HasPrefix(nodeStringValue(metadata["storageKey"]), "resource:") {
			return false, nil
		}
		if value, exists := metadata["resourceReloadAvailable"]; exists && value != nil {
			if flag, ok := value.(bool); ok && flag {
				return false, nil
			}
		}
		if outcome, ok := metadata["taskOutcome"].(map[string]any); ok {
			if phase := nodeStringValue(outcome["phase"]); phase != "" && phase != "ready" {
				return false, nil
			}
		}
		return true, nil
	}
	return false, nil
}

func nodeStringValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}
