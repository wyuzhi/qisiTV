package taskruntime

import (
	"context"
	"errors"
	"fmt"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
	"time"
)

const StageRequestNotSent = "请求尚未提交"

// Terminal owns lease-fenced terminal writes and the common completion order.
// Replay, delivery and route logs remain on their domain ports.
type Terminal struct {
	repo              TerminalRepository
	replay            TerminalReplay
	logger            TerminalLogger
	outputs           TerminalOutputs
	userFacingMessage func(error) string
	captureFailure    func(*model.Task, error, string)
	logFailedAttempt  func(model.Task, error)
}

type TerminalRepository interface {
	Task(string) (*model.Task, error)
	UpdateTaskTerminalState(string, string, model.TaskStatus, model.TaskStatus, string, string, time.Time, ...*model.TaskFailureDiagnostics) (bool, error)
}
type TerminalReplay interface {
	FinalizeTaskTextReplay(string, model.TaskStatus) error
}
type TerminalLogger interface {
	Log(string, string, string, string, string) error
}
type TerminalOutputs interface {
	DeliverSucceededTask(model.Task) error
	RegisterTaskOutputFromTask(model.Task) error
}
type TerminalDependencies struct {
	Repository        TerminalRepository
	Replay            TerminalReplay
	Logger            TerminalLogger
	Outputs           TerminalOutputs
	UserFacingMessage func(error) string
	CaptureFailure    func(*model.Task, error, string)
	LogFailedAttempt  func(model.Task, error)
}

func NewTerminal(d TerminalDependencies) *Terminal {
	return &Terminal{repo: d.Repository, replay: d.Replay, logger: d.Logger, outputs: d.Outputs, userFacingMessage: d.UserFacingMessage, captureFailure: d.CaptureFailure, logFailedAttempt: d.LogFailedAttempt}
}

func (c *Terminal) MarkPreparationFailure(task *model.Task, stage string, err error, _ bool, _ string) error {
	c.captureFailure(task, err, "unknown")
	c.ensureFailedAttemptLogged(task, err)
	task.Status = model.TaskStatusFailed
	task.Stage = stage
	task.Error = c.userFacingMessage(err)
	if terminalErr := c.markTerminalState(task); terminalErr != nil {
		return errors.Join(err, terminalErr)
	}
	return err
}

// Refuse 把一条按产品边界不再支持的任务直接收尾为失败，并记录失败日志。
// 与 MarkPreparationFailure 的差别：用户可见原因原样落库，不经过失败分类改写——
// “按产品边界拒绝执行”本身就是正确的终态结果，不是 worker 执行失败。
func (c *Terminal) Refuse(task *model.Task, stage string, message string) error {
	c.ensureFailedAttemptLogged(task, errors.New(message))
	task.Status = model.TaskStatusFailed
	task.Stage = stage
	task.Error = message
	return c.markTerminalState(task)
}

// HandleExecutionFailure 返回 nil 仅表示取消已被正常收尾；普通失败仍返回原始错误，
// 让 worker 保留重试/监控所需的失败语义。
func (c *Terminal) HandleExecutionFailure(task *model.Task, err error, providerSucceeded bool, channelSlotFailedBeforeRequest bool) error {
	if errors.Is(err, context.Canceled) {
		// 用户取消会先把数据库任务置为 cancelled，再停止 worker context。
		// 此时不再重复退款/核对，只补齐 worker 侧的回放和日志收尾。
		if latest, latestErr := c.repo.Task(task.ID); latestErr == nil && latest.Status == model.TaskStatusCancelled {
			return c.HandleAlreadyCancelled(*latest)
		}
		task.Status = model.TaskStatusCancelled
		task.Stage = "任务已取消"
		task.Error = "任务已取消"
		if terminalErr := c.markTerminalState(task); terminalErr != nil {
			return terminalErr
		}
		c.finalizeReplay(task, model.TaskStatusCancelled, "文本回放草稿归并失败")
		_ = c.logger.Log(task.UserID, task.ID, "warn", "任务已取消", "")
		return nil
	}

	source := "unknown"
	if providerSucceeded {
		source = "local_result"
	}
	c.captureFailure(task, err, source)
	task.Status = model.TaskStatusFailed
	c.ensureFailedAttemptLogged(task, err)
	task.Stage = "任务失败"
	var imageRecovery generation.ImageRecoveryError
	var unknown generation.SubmissionUnknownError
	if errors.As(err, &imageRecovery) || errors.As(err, &unknown) {
		task.Stage = "submission_unknown"
	} else {
		var preparation generation.ProtocolPreparationError
		if task.ProviderRequestID == "" && errors.As(err, &preparation) {
			task.Stage = StageRequestNotSent
		}
	}
	task.Error = c.userFacingMessage(err)
	if terminalErr := c.markTerminalState(task); terminalErr != nil {
		return errors.Join(err, terminalErr)
	}
	c.finalizeReplay(task, model.TaskStatusFailed, "文本回放草稿归并失败")
	_ = c.logger.Log(task.UserID, task.ID, "error", "任务处理失败", task.Error)
	return err
}

func (c *Terminal) HandleAlreadyCancelled(task model.Task) error {
	c.finalizeReplay(&task, model.TaskStatusCancelled, "文本回放草稿归并失败")
	_ = c.logger.Log(task.UserID, task.ID, "warn", "任务已取消，worker 已停止执行", "")
	return nil
}

func (c *Terminal) HandleCancelledResult(task model.Task) error {
	c.finalizeReplay(&task, model.TaskStatusCancelled, "文本回放草稿归并失败")
	_ = c.logger.Log(task.UserID, task.ID, "warn", "任务已取消，丢弃生成结果", "")
	return nil
}

// HandleResultPersistenceFailure 处理“上游成功但本地结果保存失败”的收尾。
// 返回 handled=true 表示并发取消已被识别并正常收尾，调用方不应再返回保存错误。
func (c *Terminal) HandleResultPersistenceFailure(task *model.Task, saveErr error) (handled bool, err error) {
	if errors.Is(saveErr, repository.ErrTaskStateConflict) {
		latest, latestErr := c.repo.Task(task.ID)
		if latestErr == nil && latest.Status == model.TaskStatusCancelled {
			if cancelErr := c.HandleCancelledResult(*latest); cancelErr != nil {
				return true, cancelErr
			}
			return true, nil
		}
	}

	task.Status = model.TaskStatusFailed
	c.captureFailure(task, saveErr, "local_result")
	task.Stage = "任务结果保存失败"
	task.Error = c.userFacingMessage(saveErr)
	if terminalErr := c.markTerminalState(task); terminalErr != nil {
		return false, errors.Join(saveErr, terminalErr)
	}
	c.finalizeReplay(task, model.TaskStatusFailed, "文本回放草稿归并失败")
	_ = c.logger.Log(task.UserID, task.ID, "error", "任务结果保存失败", task.Error)
	return false, saveErr
}

func (c *Terminal) ensureFailedAttemptLogged(task *model.Task, err error) {
	if c.logFailedAttempt == nil || task == nil || err == nil {
		return
	}
	c.logFailedAttempt(*task, err)
}

func (c *Terminal) HandleSuccess(task *model.Task) error {
	c.finalizeReplay(task, model.TaskStatusSucceeded, "文本回放窗口更新失败")
	var completionErr error
	completedTask, fetchErr := c.repo.Task(task.ID)
	if fetchErr != nil {
		completionErr = fmt.Errorf("任务成功后读取任务产物失败：%w", fetchErr)
		_ = c.logger.Log(task.UserID, task.ID, "error", "任务成功但读取任务产物失败", fetchErr.Error())
	} else {
		if deliverErr := c.outputs.DeliverSucceededTask(*completedTask); deliverErr != nil {
			_ = c.logger.Log(task.UserID, task.ID, "error", "任务成功但结果交付失败", deliverErr.Error())
			completionErr = fmt.Errorf("任务成功后的结果交付失败：%w", deliverErr)
		}
		if registerErr := c.outputs.RegisterTaskOutputFromTask(*completedTask); registerErr != nil {
			// 任务成功与产物登记分开记账；登记失败保持步骤异常，允许项目页幂等补登记。
			_ = c.logger.Log(task.UserID, task.ID, "error", "任务成功但项目产物登记失败", registerErr.Error())
			completionErr = errors.Join(completionErr, fmt.Errorf("任务成功后的项目产物登记失败：%w", registerErr))
		}
		if deliverErr := c.outputs.DeliverSucceededTask(*completedTask); deliverErr != nil {
			_ = c.logger.Log(task.UserID, task.ID, "error", "任务成功但结果交付失败", deliverErr.Error())
			completionErr = errors.Join(completionErr, fmt.Errorf("任务成功后的结果交付失败：%w", deliverErr))
		}
	}
	_ = c.logger.Log(task.UserID, task.ID, "info", "任务完成，结果已持久化", "")
	return completionErr
}

func (c *Terminal) markTerminalState(task *model.Task) error {
	completedAt := time.Now()
	task.CompletedAt = &completedAt
	updated, err := c.repo.UpdateTaskTerminalState(task.ID, task.LeaseOwner, model.TaskStatusRunning, task.Status, task.Stage, task.Error, completedAt, task.FailureDiagnostics)
	if err != nil {
		return fmt.Errorf("写入任务终态失败：%w", err)
	}
	if !updated {
		return repository.ErrTaskStateConflict
	}
	return nil
}

func (c *Terminal) finalizeReplay(task *model.Task, status model.TaskStatus, message string) {
	if err := c.replay.FinalizeTaskTextReplay(task.ID, status); err != nil {
		_ = c.logger.Log(task.UserID, task.ID, "error", message, err.Error())
	}
}
