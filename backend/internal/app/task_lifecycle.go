package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
)

// taskLifecycleCoordinator 负责任务重试与取消这类会改变任务状态的写命令。
// 读模型和 worker 执行细节留在各自边界，避免写命令跨层拼接状态更新。
type taskLifecycleCoordinator struct {
	service *Service
}

func newTaskLifecycleCoordinator(service *Service) *taskLifecycleCoordinator {
	return &taskLifecycleCoordinator{service: service}
}

func (s *Service) taskLifecycle() *taskLifecycleCoordinator {
	if s.taskLifecycleCoordinator != nil {
		return s.taskLifecycleCoordinator
	}
	// 部分单元测试直接构造 Service 字面量；延迟创建保持这些测试和内部工具兼容。
	return newTaskLifecycleCoordinator(s)
}

func (w *taskLifecycleCoordinator) retryTask(userID string, id string) (*model.Task, error) {
	s := w.service
	if s.IsDraining() {
		return nil, &AppError{Status: 503, Code: 503, Message: "服务正在维护，暂不接受任务重试", Retryable: true}
	}
	task, err := s.repo.TaskForUser(userID, id)
	if err != nil {
		return nil, err
	}
	if task.CreationSubmissionID != nil {
		return nil, creationConflict("智能创作重做需要新的报价批准，请回到创作会话继续")
	}
	if strings.HasPrefix(task.Operation, "cloud_agent") || task.Operation == "external_agent_generate" {
		return nil, BadAuthRequest("Agent 重试需要新的幂等键和预算校验，请回到 Agent 对话重新发送")
	}
	if task.Status != model.TaskStatusFailed && task.Status != model.TaskStatusCancelled {
		return nil, errors.New("only failed or cancelled tasks can be retried")
	}
	if task.ProviderCancelStatus == model.ProviderCancelStatusRequested {
		return nil, BadAuthRequest(taskCancellationPendingRetryMessage())
	}
	if isContentModerationFailure(task.Error) {
		return nil, BadAuthRequest(contentModerationRetryMessage)
	}
	if persistedFailureBlocksRetry(task.Error, task.Stage) {
		failure := classifyTaskFailure(errors.New(task.Error))
		if task.Stage == "submission_unknown" || failure.Category == generation.CategorySubmissionUncertain {
			return nil, BadAuthRequest(submissionUncertainRetryMessage)
		}
		if failure.Category == generation.CategoryDownloadFailed {
			return nil, BadAuthRequest(downloadFailureRetryMessage)
		}
		return nil, BadAuthRequest(failure.UserMessage())
	}
	decryptedInput, err := s.decryptTaskInputJSON(task.InputJSON)
	if err != nil {
		return nil, err
	}
	var taskInput map[string]any
	if err := json.Unmarshal([]byte(decryptedInput), &taskInput); err != nil {
		return nil, err
	}
	if err := s.prepareLogicalTaskRetry(task, taskInput); err != nil {
		return nil, err
	}
	if err := s.requireCustomChannelsForTaskInput(taskInput); err != nil {
		return nil, err
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	if err := s.ensureTaskProjectActive(userID, task.ProjectID); err != nil {
		return nil, err
	}
	task, err = s.repo.RetryTask(userID, task, policy.Task.ActiveTaskLimit)
	if errors.Is(err, repository.ErrActiveTaskLimit) {
		return nil, BadAuthRequest(fmt.Sprintf("同时排队或运行的任务最多 %d 个，请等待已有任务完成", policy.Task.ActiveTaskLimit))
	}
	if errors.Is(err, repository.ErrTaskNotRetryable) {
		return nil, BadAuthRequest("任务已被其他请求重新入队，请勿重复重试")
	}
	if err != nil {
		return nil, err
	}
	_ = s.log(userID, task.ID, "info", "任务已重新入队", "")
	return taskForOutput(*task), nil
}

func taskCancellationPendingRetryMessage() string {
	return "上一次取消请求仍在确认中，请稍后重试"
}

func (w *taskLifecycleCoordinator) cancelTask(_ context.Context, userID string, id string) (*model.Task, error) {
	s := w.service
	task, err := s.repo.TaskForUser(userID, id)
	if err != nil {
		return nil, err
	}
	if task.Status != model.TaskStatusQueued && task.Status != model.TaskStatusRunning {
		if task.Status == model.TaskStatusCancelled {
			return taskForOutput(*task), nil
		}
		return nil, fmt.Errorf("任务当前状态为 %s，无法取消", task.Status)
	}

	// 先从账单和请求日志补齐上游 ID，再做条件更新。取消与 worker 完成之间
	// 以数据库终态为准，避免“用户已取消但迟到结果又把任务写成成功”。
	s.hydrateTaskProviderRequestID(task)
	now := time.Now()
	cancelled, err := s.repo.CancelTaskIfStatus(userID, id, task.Status, now)
	if err != nil {
		return nil, err
	}
	if !cancelled {
		latest, latestErr := s.repo.TaskForUser(userID, id)
		if latestErr != nil {
			return nil, latestErr
		}
		if latest.Status == model.TaskStatusCancelled {
			return taskForOutput(*latest), nil
		}
		return nil, errors.New("任务状态已变化，请刷新后重试")
	}

	task.Status = model.TaskStatusCancelled
	task.Stage = "任务已取消"
	task.Error = "任务已取消"
	task.CompletedAt = &now
	s.cancelActiveTask(task.ID)
	s.noteExternalAgentTask(*task)

	// 这些收尾操作必须幂等；任何单项失败都记录日志，但不能让已经落库的
	// cancelled 状态重新对用户表现为“取消失败”。
	if err := s.finalizeTaskTextReplay(task.ID, model.TaskStatusCancelled); err != nil {
		_ = s.log(task.UserID, task.ID, "error", "取消任务后归并文本回放失败", err.Error())
	}
	_ = s.log(task.UserID, task.ID, "warn", "用户主动取消任务", "")

	if task.ProviderRequestID != "" {
		// 上游取消可能需要轮询确认，不能阻塞取消接口；请求上下文也不能因
		// 浏览器关闭而中断。后台对账会继续负责退款或费用核对。
		cancelTask := *task
		started := s.runWorkerTask(func() {
			requestCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := s.requestProviderCancellation(requestCtx, &cancelTask); err != nil {
				_ = s.log(cancelTask.UserID, cancelTask.ID, "error", "发送上游取消请求失败", err.Error())
			}
		})
		if !started {
			// drain 后不能启动未登记 goroutine；当前 HTTP 请求同步完成首次取消，
			// http.Server.Shutdown 会等待该请求，后续确认仍由持久化对账恢复。
			requestCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			if err := s.requestProviderCancellation(requestCtx, &cancelTask); err != nil {
				_ = s.log(cancelTask.UserID, cancelTask.ID, "error", "发送上游取消请求失败", err.Error())
			}
			cancel()
		}
	}

	return taskForOutput(*task), nil
}
