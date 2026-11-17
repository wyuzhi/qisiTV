package operations

import (
	"context"
	"encoding/json"
	"strings"

	"qisitv/backend/internal/model"
)

// TaskController 是任务取消这类命令能力的窄端口，由组合根实现。
// 操作核只做身份、幂等与回执，不重新实现任务状态机。
type TaskController interface {
	CancelTask(ctx context.Context, userID string, id string) (*model.Task, error)
}

func registerTaskCancelOp(r *Registry) {
	r.Register(Op{ExternalOnly: true, ReplaySafe: true, ID: "task.cancel", Summary: "取消排队中或进行中的任务；生成已完成但产物还在取回的会停止继续取回，已经取回的不能取消。上游已经受理的任务可能已经计费，这里不承诺退款", Scope: ScopeWorkspaceRead,
		Params:  json.RawMessage(`{"type":"object","properties":{"taskId":{"type":"string","description":"要取消的任务 ID"}},"required":["taskId"]}`),
		Handler: opTaskCancel})
}

func opTaskCancel(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		TaskID string `json:"taskId"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	taskID := strings.TrimSpace(args.TaskID)
	if taskID == "" {
		return nil, InvalidArg("invalid_params", "taskId 必填")
	}
	if ctx.TaskControl == nil {
		return nil, Unsupported("task_control_unavailable", "当前工作区不支持取消任务")
	}
	// 先读一次任务，既能确认归属，也能如实说明取消前的状态。
	before, err := ctx.Domain.Task(ctx.UserID, taskID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if before == nil {
		return nil, NotFound("task_not_found", "任务不存在")
	}
	// 只有这几种状态有取消语义；其余状态直接说明，不把内部错误伪装成业务冲突。
	switch before.Status {
	case model.TaskStatusQueued, model.TaskStatusRunning, model.TaskStatusCancelled, model.TaskStatusSucceeded:
	default:
		return nil, Conflict("task_not_cancellable", "任务当前状态为 "+string(before.Status)+"，无法取消", map[string]any{
			"taskId": taskID,
			"status": before.Status,
		})
	}
	cancelled, err := ctx.TaskControl.CancelTask(ctx.Context, ctx.UserID, taskID)
	if err != nil {
		// 取消期间状态可能被其他 worker 改掉；重读一次再决定是业务冲突还是真实故障。
		latest, readErr := ctx.Domain.Task(ctx.UserID, taskID)
		if readErr == nil && latest != nil && latest.Status != before.Status {
			switch latest.Status {
			case model.TaskStatusCancelled:
				return map[string]any{
					"taskId":         latest.ID,
					"status":         latest.Status,
					"previousStatus": before.Status,
					"note":           "任务此前已经取消，没有再次提交取消请求。",
				}, nil
			case model.TaskStatusQueued, model.TaskStatusRunning, model.TaskStatusSucceeded:
				// 任务仍可取消或可停止取回，只是状态刚变化；保留重试语义。
				return nil, Conflict("task_cancel_race", "任务状态在取消时发生变化，请重新查询任务状态后重试", map[string]any{
					"taskId": taskID,
					"status": latest.Status,
				})
			default:
				return nil, Conflict("task_not_cancellable", "任务当前状态为 "+string(latest.Status)+"，无法取消", map[string]any{
					"taskId": taskID,
					"status": latest.Status,
				})
			}
		}
		mapped := mapDomainError(err)
		if opErr, ok := mapped.(*Error); ok && opErr.Code == CodeInvalidArgument {
			// 例如生成结果已经取回：这是明确的业务失败，不是内部故障。
			return nil, Conflict("task_not_cancellable", err.Error(), map[string]any{
				"taskId": taskID,
				"status": before.Status,
			})
		}
		return nil, mapped
	}
	if cancelled == nil {
		return nil, newError(CodeInternal, "task_cancel_empty_result", "取消任务没有返回任务状态", nil)
	}
	return map[string]any{
		"taskId":         cancelled.ID,
		"status":         cancelled.Status,
		"previousStatus": before.Status,
		"note":           taskCancelNote(before.Status, cancelled.Status),
	}, nil
}

// taskCancelNote 只写使用者需要知道的后果：取消不一定退费，已完成任务只是停止继续取回。
func taskCancelNote(previous model.TaskStatus, current model.TaskStatus) string {
	switch {
	case previous == model.TaskStatusCancelled:
		return "任务此前已经取消，没有再次提交取消请求。"
	case current == model.TaskStatusCancelled:
		return "已请求取消。上游已经受理的任务可能已经计费，这里不承诺退款。"
	case current == model.TaskStatusSucceeded:
		return "任务已经完成，已停止继续取回产物。上游可能已经计费，这里不承诺退款。"
	default:
		return "已请求取消。上游已经受理的任务可能已经计费，这里不承诺退款。"
	}
}
