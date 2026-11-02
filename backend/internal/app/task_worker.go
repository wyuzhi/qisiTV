package app

import (
	"context"
	"time"

	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
	"qisitv/backend/internal/taskruntime"
)

const newAPIChannel2TaskSyncMaxAge = localtask.NewAPIChannel2TaskSyncMaxAge
const workerSlotLeaseDuration = localtask.WorkerSlotLeaseDuration

type taskWorkerCoordinator struct {
	service *Service
	runtime *taskruntime.Runtime
}

func newTaskWorkerCoordinator(service *Service) *taskWorkerCoordinator {
	w := &taskWorkerCoordinator{service: service}
	w.runtime = newAppTaskRuntime(w)
	return w
}

func (s *Service) taskWorker() *taskWorkerCoordinator {
	if s.taskWorkerCoordinator != nil {
		return s.taskWorkerCoordinator
	}
	return newTaskWorkerCoordinator(s)
}

func (w *taskWorkerCoordinator) start(ctx context.Context) {
	s := w.service
	s.startTextReplayCleanup(ctx)
	s.startProviderCancellationReconciliation(ctx)
	s.startGenerationDeliveryRecovery(ctx)
	s.startCanvasWorkflowScheduler(ctx)
	if w.runtime == nil {
		w.runtime = newAppTaskRuntime(w)
	}
	w.runtime.StartLoop()
}

func (w *taskWorkerCoordinator) processNextTask() error {
	if w.runtime == nil {
		w.runtime = newAppTaskRuntime(w)
	}
	return w.runtime.ProcessOne(context.Background()).Err
}

func (w *taskWorkerCoordinator) executeClaimed(session taskruntime.Session) taskruntime.Outcome {
	s := w.service
	return localtask.ExecuteClaimedTask(localtask.WorkerExecuteDeps{
		Repo:              s.repo,
		Terminal:          s.terminalCoordinator(),
		Log:               s.log,
		RunTimeline:       w.processTimelineTranscription,
		RunRender:         w.processTimelineRender,
		RunDepth:          w.processDepthCapture,
		RunCanvasMedia:    w.processCanvasMedia,
		BeginRouteAttempt: s.beginTaskRouteAttempt,
		ExecuteRoute: func(ctx context.Context, task *model.Task, attempt *model.RouteAttempt) (localtask.RouteExecutionResult, error) {
			res, err := s.routeExecutor().execute(ctx, task, attempt)
			return localtask.RouteExecutionResult{Result: res.result, CanvasOps: res.canvasOps, Err: res.err, ProviderSucceeded: res.providerSucceeded}, err
		},
		PersistGeneratedMedia: s.persistTaskGeneratedMediaResult,
		FinalizeTurnaround:    s.finalizeCharacterTurnaroundTask,
		DecryptTaskInput:      s.decryptTaskInputJSON,
		ShouldDeferImage:      s.shouldDeferImageRecovery,
		DeferImage:            s.deferImageRecovery,
		ResolveProviderConfig: s.resolveProviderConfig,
		ImageTaskEnded:        imageTaskEnded,
		SaveTaskCompletion:    s.saveTaskCompletionWithinStorageQuota,
	}, session)
}

func (w *taskWorkerCoordinator) specialTaskOutcome(session taskruntime.Session, run func(*model.Task, context.Context) error) taskruntime.Outcome {
	return localtask.SpecialTaskOutcome(session, run)
}

func leaseLostOutcome(session taskruntime.Session, providerAccepted bool) taskruntime.Outcome {
	return localtask.LeaseLostOutcome(session, providerAccepted)
}

func executionFailureOutcome(terminal *taskTerminalCoordinator, task *model.Task, err error, providerSucceeded, providerAccepted, channelSlotFailedBeforeRequest bool) taskruntime.Outcome {
	return localtask.ExecutionFailureOutcome(terminal, task, err, providerSucceeded, providerAccepted, channelSlotFailedBeforeRequest, imageTaskEnded)
}

func persistenceFailureOutcome(terminal *taskTerminalCoordinator, task *model.Task, err error, providerAccepted bool) taskruntime.Outcome {
	return localtask.PersistenceFailureOutcome(terminal, task, err, providerAccepted)
}

func terminalWriteApplied(termErr, cause error) bool {
	return localtask.TerminalWriteApplied(termErr, cause)
}

func taskUsesUpstreamReportedProgress(taskType string) bool {
	return localtask.TaskUsesUpstreamReportedProgress(taskType)
}

func taskFailureMessage(err error) string {
	return localtask.TaskFailureMessage(err)
}

func taskExecutionTimeoutWithPolicy(taskType string, policy RuntimeTaskPolicy) time.Duration {
	return localtask.TaskExecutionTimeoutWithMinutes(taskType, policy.VideoTimeoutMinutes, policy.ImageTimeoutMinutes, policy.AudioTimeoutMinutes, policy.TextTimeoutMinutes, policy.DefaultTimeoutMinutes)
}

func (s *Service) shouldDeferVideoProviderTask(task model.Task, decryptedInput string, err error) bool {
	return localtask.ShouldDeferVideoProviderTask(task, decryptedInput, err, s.resolveProviderConfig)
}

func newAPIChannel2TaskSyncExpired(task model.Task, err error, now time.Time) bool {
	return localtask.NewAPIChannel2TaskSyncExpired(task, err, now)
}

func taskTimeoutMessage(taskType string) string {
	return localtask.TaskTimeoutMessage(taskType)
}
