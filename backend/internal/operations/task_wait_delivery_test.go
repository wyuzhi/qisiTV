package operations

import (
	"testing"

	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
	"qisitv/backend/internal/taskdelivery"
)

// taskWaitDeliveryStore 只实现交付和读取需要的部分：产物结果行为内存表，
// 其余资源查询都返回未找到，足以覆盖不可用结果的交付终态。
type taskWaitDeliveryStore struct {
	results []model.Result
}

func (s *taskWaitDeliveryStore) WithTx(fn func(taskdelivery.Store) error) error {
	return fn(s)
}

func (s *taskWaitDeliveryStore) GenerationOutputResults(taskID string) ([]model.Result, error) {
	out := make([]model.Result, 0, len(s.results))
	for _, result := range s.results {
		if result.TaskID == taskID {
			out = append(out, result)
		}
	}
	return out, nil
}

func (s *taskWaitDeliveryStore) GenerationOutputResultsForTasks(taskIDs []string) ([]model.Result, error) {
	wanted := make(map[string]bool, len(taskIDs))
	for _, id := range taskIDs {
		wanted[id] = true
	}
	out := make([]model.Result, 0, len(s.results))
	for _, result := range s.results {
		if wanted[result.TaskID] {
			out = append(out, result)
		}
	}
	return out, nil
}

func (s *taskWaitDeliveryStore) AssetRepresentationsForTask(string) ([]model.AssetRepresentation, error) {
	return nil, nil
}

func (s *taskWaitDeliveryStore) ResourceForUser(string, string) (*model.Resource, error) {
	return nil, taskdelivery.ErrNotFound
}

func (s *taskWaitDeliveryStore) Resource(string) (*model.Resource, error) {
	return nil, taskdelivery.ErrNotFound
}

func (s *taskWaitDeliveryStore) Asset(string) (*model.Asset, error) {
	return nil, taskdelivery.ErrNotFound
}

func (s *taskWaitDeliveryStore) AssetVersion(string) (*model.AssetVersion, error) {
	return nil, taskdelivery.ErrNotFound
}

func (s *taskWaitDeliveryStore) CommitOwned(item taskdelivery.OwnedDelivery) error {
	for index := range s.results {
		if s.results[index].ID == item.Result.ID {
			s.results[index] = item.Result
			return nil
		}
	}
	s.results = append(s.results, item.Result)
	return nil
}

func (s *taskWaitDeliveryStore) SucceededTasksForDelivery(string, int) ([]model.Task, error) {
	return nil, nil
}

// 交付层把不可用媒体结果落成 unsupported_result_shape 后，读投影和 task.wait
// 必须给出同一个失败结论，不能一边 failed 一边永远 pending。
func TestTaskWaitAndDeliveryShareUnusableResultConclusion(t *testing.T) {
	for name, resultJSON := range map[string]string{
		"空媒体列表":  `{"images":[]}`,
		"不可用输出":  `{"images":[1]}`,
		"结果无法解析": `{`,
		"零产物对象":  `{}`,
		"空结果":    `null`,
		"只有模式":   `{"mode":"image"}`,
	} {
		t.Run(name, func(t *testing.T) {
			store := &taskWaitDeliveryStore{}
			deliverer := taskdelivery.New(store, nil)
			task := model.Task{
				ID:         "task-1",
				UserID:     "user-1",
				Type:       "canvas_image",
				Status:     model.TaskStatusSucceeded,
				ResultJSON: resultJSON,
			}
			if err := deliverer.Deliver(task); err != nil {
				t.Fatalf("交付失败: %v", err)
			}
			stored, err := taskdelivery.DecodeStoredOutputs(mustResults(t, store, task.ID))
			if err != nil {
				t.Fatalf("读取交付结果失败: %v", err)
			}
			if len(stored) != 1 || stored[0].MaterializationErrorCode != localtask.MaterializeErrorUnsupportedShape {
				t.Fatalf("不可用结果应落库终态失败行: %#v", stored)
			}
			projection := taskdelivery.Project(task, stored, nil, false)
			if projection.ResultState != localtask.ResultStateFailedPermanent {
				t.Fatalf("投影状态 = %q，应为 FAILED_PERMANENT", projection.ResultState)
			}
			if projection.Outcome.Phase != "failed" {
				t.Fatalf("投影阶段 = %q，应为 failed", projection.Outcome.Phase)
			}
			projected := task
			projected.ResultState = projection.ResultState
			projected.Outputs = taskdelivery.ModelTaskOutputs(projection.Outputs)
			projected.Outcome = &projection.Outcome
			domain := &taskWaitDomain{sequences: map[string]*taskWaitSequence{
				task.ID: {tasks: []model.Task{projected}},
			}}
			result, err := runTaskWaitOp(t, domain, `{"taskId":"task-1","timeoutMs":0}`)
			if err != nil {
				t.Fatal(err)
			}
			if !result.Failed || result.Completed || result.Pending || result.TimedOut {
				t.Fatalf("task.wait 应与交付层给出同一个失败结论: %+v", result)
			}
			if len(result.FailedTaskIDs) != 1 || result.FailedTaskIDs[0] != "task-1" {
				t.Fatalf("failedTaskIds = %v，应为 [task-1]", result.FailedTaskIDs)
			}
			if result.Tasks[0].State != taskWaitFailed || result.Tasks[0].Reason != "materialization_failed" {
				t.Fatalf("任务视图不正确: %+v", result.Tasks[0])
			}
		})
	}
}

func mustResults(t *testing.T, store *taskWaitDeliveryStore, taskID string) []model.Result {
	t.Helper()
	results, err := store.GenerationOutputResults(taskID)
	if err != nil {
		t.Fatalf("读取结果行失败: %v", err)
	}
	return results
}
