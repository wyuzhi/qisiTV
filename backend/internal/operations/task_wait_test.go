package operations

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"gorm.io/gorm"

	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

type taskWaitSequence struct {
	tasks []model.Task
	reads int
}

type taskWaitDomain struct {
	unusedDomain
	mu        sync.Mutex
	sequences map[string]*taskWaitSequence
	errors    map[string]error
	canvas    json.RawMessage
	canvasErr error
}

func (d *taskWaitDomain) Task(_ string, id string) (*model.Task, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.errors[id]; err != nil {
		return nil, err
	}
	sequence := d.sequences[id]
	if sequence == nil || len(sequence.tasks) == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	index := sequence.reads
	if index >= len(sequence.tasks) {
		index = len(sequence.tasks) - 1
	}
	sequence.reads++
	task := sequence.tasks[index]
	return &task, nil
}

func (d *taskWaitDomain) UserCanvasProject(_ string, _ string) (json.RawMessage, error) {
	if d.canvasErr != nil {
		return nil, d.canvasErr
	}
	if d.canvas == nil {
		return nil, gorm.ErrRecordNotFound
	}
	return d.canvas, nil
}

func (d *taskWaitDomain) reads(id string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	if sequence := d.sequences[id]; sequence != nil {
		return sequence.reads
	}
	return 0
}

func taskWaitTask(id string, mutate func(*model.Task)) model.Task {
	task := model.Task{ID: id, Type: "canvas_image", Status: model.TaskStatusRunning}
	if mutate != nil {
		mutate(&task)
	}
	return task
}

func savedTask(id string) model.Task {
	return taskWaitTask(id, func(task *model.Task) {
		task.Status = model.TaskStatusSucceeded
		task.ResultState = localtask.ResultStateReady
		task.ResultJSON = `{"images":[{"resourceId":"res-1"}]}`
		task.Outcome = &model.TaskOutcome{Phase: "ready", Regenerate: "allowed", Reason: "result_ready"}
		task.Outputs = []model.TaskOutput{{OutputIndex: 0, MediaType: "image", ResourceID: "res-1"}}
	})
}

func savingTask(id string) model.Task {
	return taskWaitTask(id, func(task *model.Task) {
		task.Status = model.TaskStatusSucceeded
		task.ResultState = localtask.ResultStatePendingMaterialization
		task.ResultJSON = `{"images":[{"resourceId":"res-1"}]}`
		task.Outcome = &model.TaskOutcome{Phase: "fetching", Regenerate: "blocked", Reason: "result_fetching"}
		task.Outputs = []model.TaskOutput{{OutputIndex: 0, MediaType: "image", ProviderArtifactRef: "https://upstream.example/a.png"}}
	})
}

func runTaskWaitOp(t *testing.T, domain Domain, params string) (taskWaitResult, error) {
	t.Helper()
	return runTaskWaitOpContext(t, context.Background(), domain, params)
}

func runTaskWaitOpContext(t *testing.T, ctx context.Context, domain Domain, params string) (taskWaitResult, error) {
	t.Helper()
	value, err := opTaskWait(&Context{Context: ctx, Domain: domain, UserID: "user-1"}, json.RawMessage(params))
	if err != nil {
		return taskWaitResult{}, err
	}
	result, ok := value.(taskWaitResult)
	if !ok {
		t.Fatalf("结果类型 = %T", value)
	}
	return result, nil
}

func useFastTaskWaitPoll(t *testing.T) {
	t.Helper()
	restore := taskWaitPollInterval
	taskWaitPollInterval = 5 * time.Millisecond
	t.Cleanup(func() { taskWaitPollInterval = restore })
}

func TestTaskWaitReturnsImmediatelyWhenSaved(t *testing.T) {
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{savedTask("task-1")}},
	}}
	result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","timeoutMs":2000}`)
	if err != nil {
		t.Fatal(err)
	}
	if result.Pending || result.TimedOut || result.Cancelled || result.Failed || !result.Completed {
		t.Fatalf("已完成任务应直接返回成功: %+v", result)
	}
	if len(result.Tasks) != 1 || result.Tasks[0].TaskID != "task-1" || result.Tasks[0].State != taskWaitCompleted {
		t.Fatalf("任务视图不正确: %+v", result.Tasks)
	}
	if reads := domain.reads("task-1"); reads != 1 {
		t.Fatalf("已完成任务应只读一次，读取 %d 次", reads)
	}
}

func TestTaskWaitWaitsForCompletion(t *testing.T) {
	useFastTaskWaitPoll(t)
	running := taskWaitTask("task-1", nil)
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{running, running, savedTask("task-1")}},
	}}
	result, err := runTaskWaitOp(t, domain, `{"taskIds":["task-1"],"timeoutMs":2000}`)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Completed || result.Pending || result.TimedOut {
		t.Fatalf("等待中完成应返回完成: %+v", result)
	}
	if reads := domain.reads("task-1"); reads < 3 {
		t.Fatalf("应至少读取 3 次直到完成，实际 %d 次", reads)
	}
}

func TestTaskWaitTimeoutReturnsPendingAndOriginalTaskID(t *testing.T) {
	useFastTaskWaitPoll(t)
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{taskWaitTask("task-1", nil)}},
	}}
	result, err := runTaskWaitOp(t, domain, `{"taskIds":["task-1"],"timeoutMs":30}`)
	if err != nil {
		t.Fatalf("超时不能返回错误: %v", err)
	}
	if !result.Pending || !result.TimedOut || result.Cancelled || result.Completed || result.Failed {
		t.Fatalf("超时应返回 pending/timedOut: %+v", result)
	}
	if len(result.TaskIDs) != 1 || result.TaskIDs[0] != "task-1" {
		t.Fatalf("超时应保留原 taskId: %+v", result.TaskIDs)
	}
	if len(result.Tasks) != 1 || result.Tasks[0].TaskID != "task-1" || result.Tasks[0].State != taskWaitRunning {
		t.Fatalf("超时任务视图不正确: %+v", result.Tasks)
	}
}

func TestTaskWaitTreatsSavingAsIncomplete(t *testing.T) {
	useFastTaskWaitPoll(t)
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{savingTask("task-1")}},
	}}
	result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","timeoutMs":15}`)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Pending || !result.TimedOut || result.Completed || result.Failed {
		t.Fatalf("保存中不能算完成: %+v", result)
	}
	if result.Tasks[0].State != taskWaitSaving || result.Tasks[0].Reason != "saving" {
		t.Fatalf("保存中应给出原因: %+v", result.Tasks[0])
	}
}

func TestTaskWaitReportsMaterializationFailure(t *testing.T) {
	failed := taskWaitTask("task-1", func(task *model.Task) {
		task.Status = model.TaskStatusSucceeded
		task.ResultState = localtask.ResultStateFailedPermanent
		task.ResultJSON = `{"images":[{"resourceId":"res-1"}]}`
		task.Outcome = &model.TaskOutcome{Phase: "failed", Regenerate: "confirm", Reason: "result_unrecoverable"}
		task.Outputs = []model.TaskOutput{{OutputIndex: 0, MediaType: "image", MaterializationErrorCode: localtask.MaterializeErrorResourceMissing}}
	})
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{failed}},
	}}
	result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","timeoutMs":2000}`)
	if err != nil {
		t.Fatal(err)
	}
	if result.Pending || result.TimedOut || result.Completed || !result.Failed {
		t.Fatalf("物化失败应算失败: %+v", result)
	}
	if result.Tasks[0].State != taskWaitFailed || result.Tasks[0].Reason != "materialization_failed" {
		t.Fatalf("物化失败原因不正确: %+v", result.Tasks[0])
	}
}

func TestTaskWaitDoesNotReportFailedWhileOtherTasksRun(t *testing.T) {
	useFastTaskWaitPoll(t)
	failed := taskWaitTask("task-1", func(task *model.Task) { task.Status = model.TaskStatusFailed })
	running := taskWaitTask("task-2", nil)
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{failed}},
		"task-2": {tasks: []model.Task{running}},
	}}
	result, err := runTaskWaitOp(t, domain, `{"taskIds":["task-1","task-2"],"timeoutMs":20}`)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Pending || !result.TimedOut || result.Completed || result.Failed {
		t.Fatalf("混合批次仍在等待时不应报失败终态: %+v", result)
	}
	if len(result.FailedTaskIDs) != 1 || result.FailedTaskIDs[0] != "task-1" {
		t.Fatalf("应列出已失败的任务: %+v", result.FailedTaskIDs)
	}
}

func TestTaskWaitCompletedWithUnreadableTask(t *testing.T) {
	domain := &taskWaitDomain{
		sequences: map[string]*taskWaitSequence{
			"task-1": {tasks: []model.Task{savedTask("task-1")}},
		},
		errors: map[string]error{"task-2": errors.New("database is busy")},
	}
	result, err := runTaskWaitOp(t, domain, `{"taskIds":["task-1","task-2"],"timeoutMs":0}`)
	if err != nil {
		t.Fatal(err)
	}
	if result.Completed || !result.ObservationFailed || !result.Pending || !result.TimedOut {
		t.Fatalf("有任务读不到时不能报告完成: %+v", result)
	}
}

func TestTaskWaitCompletesTasksWithoutMediaOutputs(t *testing.T) {
	cases := map[string]model.Task{
		"文本": {
			ID: "task-1", Type: "canvas_text", Status: model.TaskStatusSucceeded,
			ResultState: localtask.ResultStateReady, ResultJSON: `{"text":"hello"}`,
			Outcome: &model.TaskOutcome{Phase: "ready", Regenerate: "allowed", Reason: "result_ready"},
		},
		"转写": {
			ID: "task-1", Type: model.TaskTypeTimelineTranscription, Status: model.TaskStatusSucceeded,
			ResultState: localtask.ResultStateReady, ResultJSON: `{"segments":[]}`,
			Outcome: &model.TaskOutcome{Phase: "ready", Regenerate: "allowed", Reason: "result_ready"},
		},
	}
	for name, task := range cases {
		t.Run(name, func(t *testing.T) {
			domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{"task-1": {tasks: []model.Task{task}}}}
			result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","timeoutMs":2000}`)
			if err != nil {
				t.Fatal(err)
			}
			if !result.Completed || result.Pending || result.Failed {
				t.Fatalf("没有媒体产物的成功任务应完成: %+v", result)
			}
			if result.Tasks[0].Reason != "no_outputs" {
				t.Fatalf("原因应为 no_outputs: %+v", result.Tasks[0])
			}
		})
	}
}

func TestTaskWaitMediaTaskWithPendingOutputsStaysIncomplete(t *testing.T) {
	useFastTaskWaitPoll(t)
	task := taskWaitTask("task-1", func(task *model.Task) {
		task.Status = model.TaskStatusSucceeded
		task.ResultState = localtask.ResultStateReady
		task.ResultJSON = `{"images":[{"resourceId":"res-1"}]}`
		task.Outcome = &model.TaskOutcome{Phase: "ready", Regenerate: "allowed", Reason: "result_ready"}
	})
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{"task-1": {tasks: []model.Task{task}}}}
	result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","timeoutMs":10}`)
	if err != nil {
		t.Fatal(err)
	}
	if result.Completed || !result.Pending {
		t.Fatalf("结果里还有待保存的媒体产物时不能完成: %+v", result)
	}
	if result.Tasks[0].State != taskWaitSaving {
		t.Fatalf("媒体任务缺产物应为 saving: %+v", result.Tasks[0])
	}
}

func TestTaskWaitChecksNodeBinding(t *testing.T) {
	boundCanvas := func(taskID, storageKey, phase string) json.RawMessage {
		return json.RawMessage(`{"nodes":[{"id":"node-1","metadata":{"taskId":"` + taskID +
			`","status":"success","storageKey":"` + storageKey + `","taskOutcome":{"phase":"` + phase + `"}}}]}`)
	}
	cases := []struct {
		name   string
		canvas json.RawMessage
		want   bool
	}{
		{"绑定到等待的任务", boundCanvas("task-1", "resource:res-1", "ready"), true},
		{"绑定到别的任务", boundCanvas("task-2", "resource:res-1", "ready"), false},
		{"还没写资源", boundCanvas("task-1", "blob:local", "ready"), false},
		{"产物阶段未就绪", boundCanvas("task-1", "resource:res-1", "fetching"), false},
		{"资源需要重新加载", json.RawMessage(`{"nodes":[{"id":"node-1","metadata":{"taskId":"task-1","status":"success","storageKey":"resource:res-1","resourceReloadAvailable":true,"taskOutcome":{"phase":"ready"}}}]}`), false},
		{"节点不存在", json.RawMessage(`{"nodes":[]}`), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			domain := &taskWaitDomain{
				sequences: map[string]*taskWaitSequence{"task-1": {tasks: []model.Task{savedTask("task-1")}}},
				canvas:    tc.canvas,
			}
			result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","canvasId":"canvas-1","nodeId":"node-1","timeoutMs":2000}`)
			if err != nil {
				t.Fatal(err)
			}
			if result.Bound == nil || *result.Bound != tc.want {
				t.Fatalf("bound = %v，应为 %v", result.Bound, tc.want)
			}
			if result.BindingObservationFailed {
				t.Fatal("正常读到画布时不应标记绑定检查失败")
			}
		})
	}
}

func TestTaskWaitReportsBindingObservationFailure(t *testing.T) {
	domain := &taskWaitDomain{
		sequences: map[string]*taskWaitSequence{"task-1": {tasks: []model.Task{savedTask("task-1")}}},
		canvasErr: errors.New("database is busy"),
	}
	result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","canvasId":"canvas-1","nodeId":"node-1","timeoutMs":2000}`)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Completed {
		t.Fatalf("任务本身仍应完成: %+v", result)
	}
	if result.Bound == nil || *result.Bound {
		t.Fatalf("读不到画布时 bound 应为 false: %+v", result.Bound)
	}
	if !result.BindingObservationFailed {
		t.Fatal("读不到画布时必须标记绑定检查失败")
	}
}

func TestTaskWaitIgnoresPartialBindingParams(t *testing.T) {
	for _, params := range []string{
		`{"taskId":"task-1","canvasId":"canvas-1","timeoutMs":2000}`,
		`{"taskId":"task-1","nodeId":"node-1","timeoutMs":2000}`,
	} {
		domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{"task-1": {tasks: []model.Task{savedTask("task-1")}}}}
		result, err := runTaskWaitOp(t, domain, params)
		if err != nil {
			t.Fatal(err)
		}
		if result.Bound != nil || result.CanvasID != "" || result.NodeID != "" || result.BindingObservationFailed {
			t.Fatalf("只传一边时不应检查绑定: %+v", result)
		}
	}
}

func TestTaskWaitCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{taskWaitTask("task-1", nil)}},
	}}
	result, err := runTaskWaitOpContext(t, ctx, domain, `{"taskId":"task-1","timeoutMs":2000}`)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Cancelled || !result.Pending || result.TimedOut || result.Completed || result.Failed {
		t.Fatalf("取消应返回 cancelled/pending 而不是超时: %+v", result)
	}
}

func TestTaskWaitValidatesParams(t *testing.T) {
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{savedTask("task-1")}},
	}}
	cases := []struct {
		name   string
		params string
		reason string
	}{
		{"缺少任务", `{}`, "invalid_params"},
		{"空任务数组", `{"taskIds":[]}`, "invalid_params"},
		{"超过 8 个", `{"taskIds":["1","2","3","4","5","6","7","8","9"]}`, "invalid_batch"},
		{"负超时", `{"taskId":"task-1","timeoutMs":-1}`, "invalid_timeout"},
		{"未知字段", `{"taskId":"task-1","unknown":true}`, "unknown_field"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := runTaskWaitOp(t, domain, tc.params)
			if err == nil {
				t.Fatal("应拒绝参数")
			}
			if opErr := AsError(err); opErr.Reason != tc.reason {
				t.Fatalf("reason = %s，应为 %s", opErr.Reason, tc.reason)
			}
		})
	}

	result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","taskIds":["task-2"],"timeoutMs":2000}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.TaskIDs) != 1 || result.TaskIDs[0] != "task-1" {
		t.Fatalf("taskId 应优先于 taskIds: %+v", result.TaskIDs)
	}
	result, err = runTaskWaitOp(t, domain, `{"taskIds":["task-1","task-1"],"timeoutMs":2000}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.TaskIDs) != 1 {
		t.Fatalf("重复任务应去重: %+v", result.TaskIDs)
	}
}

func TestTaskWaitMissingTaskReturnsNotFound(t *testing.T) {
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{}}
	started := time.Now()
	_, err := runTaskWaitOp(t, domain, `{"taskIds":["task-missing"],"timeoutMs":25000}`)
	if err == nil {
		t.Fatal("不存在的任务应返回错误")
	}
	if time.Since(started) > time.Second {
		t.Fatal("不存在的任务不应等满超时")
	}
	opErr := AsError(err)
	if opErr.Code != CodeNotFound || opErr.Reason != "task_not_found" {
		t.Fatalf("应返回 not_found/task_not_found: %v", opErr)
	}
	ids, _ := opErr.Details["taskIds"].([]string)
	if len(ids) != 1 || ids[0] != "task-missing" {
		t.Fatalf("错误详情应列出不存在的任务: %+v", opErr.Details)
	}
}

func TestTaskWaitResponseCarriesStableFields(t *testing.T) {
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{savedTask("task-1")}},
	}}
	result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","timeoutMs":2000}`)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"tasks", "taskIds", "pending", "timedOut", "cancelled", "completed", "failed"} {
		if _, exists := payload[key]; !exists {
			t.Fatalf("响应缺少 %s: %s", key, encoded)
		}
	}
	tasks, _ := payload["tasks"].([]any)
	if len(tasks) != 1 {
		t.Fatalf("tasks = %v", payload["tasks"])
	}
	task, _ := tasks[0].(map[string]any)
	for _, key := range []string{"taskId", "type", "status", "outputs", "resultState", "state", "reason"} {
		if _, exists := task[key]; !exists {
			t.Fatalf("任务视图缺少 %s: %v", key, task)
		}
	}
}

func TestTaskWaitDoesNotCompleteUnusableMediaResults(t *testing.T) {
	useFastTaskWaitPoll(t)
	for name, resultJSON := range map[string]string{
		"空媒体列表":  `{"images":[]}`,
		"不可用输出":  `{"images":[1]}`,
		"结果无法解析": `{`,
		"零产物对象":  `{}`,
		"空结果":    `null`,
		"只有模式":   `{"mode":"image"}`,
	} {
		t.Run(name, func(t *testing.T) {
			task := taskWaitTask("task-1", func(task *model.Task) {
				task.Status = model.TaskStatusSucceeded
				task.ResultState = localtask.ResultStateReady
				task.ResultJSON = resultJSON
				task.Outcome = &model.TaskOutcome{Phase: "ready", Regenerate: "allowed", Reason: "result_ready"}
			})
			domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{"task-1": {tasks: []model.Task{task}}}}
			result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","timeoutMs":10}`)
			if err != nil {
				t.Fatal(err)
			}
			if result.Completed || !result.Pending || result.Failed {
				t.Fatalf("不可用的媒体结果不能算完成: %+v", result)
			}
			if result.Tasks[0].State != taskWaitSaving {
				t.Fatalf("不可用的媒体结果应保持 saving: %+v", result.Tasks[0])
			}
		})
	}
}

func TestTaskWaitAggregatesSettledBatches(t *testing.T) {
	failedTask := func(id string) model.Task {
		return taskWaitTask(id, func(task *model.Task) { task.Status = model.TaskStatusFailed })
	}
	cases := []struct {
		name          string
		tasks         map[string]model.Task
		completed     bool
		failed        bool
		failedTaskIDs []string
	}{
		{
			name:      "全部完成",
			tasks:     map[string]model.Task{"task-1": savedTask("task-1"), "task-2": savedTask("task-2")},
			completed: true,
		},
		{
			name:          "完成加失败",
			tasks:         map[string]model.Task{"task-1": savedTask("task-1"), "task-2": failedTask("task-2")},
			failed:        true,
			failedTaskIDs: []string{"task-2"},
		},
		{
			name:          "全部失败",
			tasks:         map[string]model.Task{"task-1": failedTask("task-1"), "task-2": failedTask("task-2")},
			failed:        true,
			failedTaskIDs: []string{"task-1", "task-2"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sequences := map[string]*taskWaitSequence{}
			for id, task := range tc.tasks {
				sequences[id] = &taskWaitSequence{tasks: []model.Task{task}}
			}
			domain := &taskWaitDomain{sequences: sequences}
			result, err := runTaskWaitOp(t, domain, `{"taskIds":["task-1","task-2"],"timeoutMs":2000}`)
			if err != nil {
				t.Fatal(err)
			}
			if result.Pending || result.TimedOut || result.Cancelled {
				t.Fatalf("已结束的批次不应是 pending: %+v", result)
			}
			if result.Completed != tc.completed || result.Failed != tc.failed {
				t.Fatalf("completed=%v failed=%v，应为 %v/%v", result.Completed, result.Failed, tc.completed, tc.failed)
			}
			if len(result.FailedTaskIDs) != len(tc.failedTaskIDs) {
				t.Fatalf("failedTaskIds=%v，应为 %v", result.FailedTaskIDs, tc.failedTaskIDs)
			}
			for index, id := range tc.failedTaskIDs {
				if result.FailedTaskIDs[index] != id {
					t.Fatalf("failedTaskIds=%v，应为 %v", result.FailedTaskIDs, tc.failedTaskIDs)
				}
			}
		})
	}
}

func TestTaskWaitCancelDuringWait(t *testing.T) {
	useFastTaskWaitPoll(t)
	ctx, cancel := context.WithCancel(context.Background())
	timer := time.AfterFunc(20*time.Millisecond, cancel)
	defer timer.Stop()
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{taskWaitTask("task-1", nil)}},
	}}
	observation := awaitTaskIDs(ctx, domain, "user-1", []string{"task-1"}, 2*time.Second)
	if !observation.cancelled || !observation.pending || observation.timedOut {
		t.Fatalf("等待中取消应返回 cancelled/pending: %+v", observation)
	}
}

// 过了截止时间仍允许再读一次批次里的第一个任务，用来把最近快照带回超时响应；
// 后面的任务不再读取。名称与这条行为保持一致。
func TestTaskWaitReadsOnlyFirstTaskAfterDeadline(t *testing.T) {
	domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
		"task-1": {tasks: []model.Task{taskWaitTask("task-1", nil)}},
		"task-2": {tasks: []model.Task{taskWaitTask("task-2", nil)}},
	}}
	observation := readTaskWaitObservation(context.Background(), domain, "user-1",
		[]string{"task-1", "task-2"}, time.Now().Add(-time.Second), false)
	if !observation.deadlineReached {
		t.Fatal("过了截止时间应停止继续读取")
	}
	if len(observation.views) != 1 || observation.views[0].TaskID != "task-1" {
		t.Fatalf("截止后只应再读第一个任务: %+v", observation.views)
	}
	if reads := domain.reads("task-1"); reads != 1 {
		t.Fatalf("第一个任务恰好读一次，实际读 %d 次", reads)
	}
	if reads := domain.reads("task-2"); reads != 0 {
		t.Fatalf("截止后不应再读第二个任务，实际读 %d 次", reads)
	}
}
