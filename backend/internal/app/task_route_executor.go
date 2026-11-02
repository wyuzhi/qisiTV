package app

import (
	"context"

	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

type taskRouteExecutor struct {
	port taskRouteExecutionPort
}

type taskRouteExecutionPort interface {
	markRouteAttemptDispatching(attempt *model.RouteAttempt) error
	processTask(ctx context.Context, task model.Task) (map[string]interface{}, []map[string]interface{}, error)
	refreshTaskProviderState(task *model.Task) error
	finishTaskRouteAttempt(attempt *model.RouteAttempt, task *model.Task, taskErr error)
	nextRouteAttemptAfterFailure(task *model.Task, attempt *model.RouteAttempt, taskErr error) (*model.RouteAttempt, error)
	log(userID string, taskID string, level string, message string, payload string) error
}

type taskRouteExecutionResult struct {
	result            map[string]interface{}
	canvasOps         []map[string]interface{}
	err               error
	providerSucceeded bool
}

type taskRouteServiceAdapter struct {
	markDispatching  func(*model.RouteAttempt) error
	process          func(context.Context, model.Task) (map[string]interface{}, []map[string]interface{}, error)
	refreshState     func(*model.Task) error
	finishAttempt    func(*model.RouteAttempt, *model.Task, error)
	nextAfterFailure func(*model.Task, *model.RouteAttempt, error) (*model.RouteAttempt, error)
	writeLog         func(string, string, string, string, string) error
}

func (a taskRouteServiceAdapter) markRouteAttemptDispatching(attempt *model.RouteAttempt) error {
	return a.markDispatching(attempt)
}
func (a taskRouteServiceAdapter) processTask(ctx context.Context, task model.Task) (map[string]interface{}, []map[string]interface{}, error) {
	return a.process(ctx, task)
}
func (a taskRouteServiceAdapter) refreshTaskProviderState(task *model.Task) error {
	return a.refreshState(task)
}
func (a taskRouteServiceAdapter) finishTaskRouteAttempt(attempt *model.RouteAttempt, task *model.Task, taskErr error) {
	a.finishAttempt(attempt, task, taskErr)
}
func (a taskRouteServiceAdapter) nextRouteAttemptAfterFailure(task *model.Task, attempt *model.RouteAttempt, taskErr error) (*model.RouteAttempt, error) {
	return a.nextAfterFailure(task, attempt, taskErr)
}
func (a taskRouteServiceAdapter) log(userID, taskID, level, message, payload string) error {
	return a.writeLog(userID, taskID, level, message, payload)
}

func newTaskRouteExecutor(s *Service) *taskRouteExecutor {
	return &taskRouteExecutor{port: taskRouteServiceAdapter{
		markDispatching: s.markRouteAttemptDispatching, process: s.processTask,
		refreshState: s.refreshTaskProviderState, finishAttempt: s.finishTaskRouteAttempt,
		nextAfterFailure: s.nextRouteAttemptAfterFailure, writeLog: s.log,
	}}
}

func (s *Service) routeExecutor() *taskRouteExecutor {
	if s.taskRouteExecutor != nil {
		return s.taskRouteExecutor
	}
	return newTaskRouteExecutor(s)
}

func (e *taskRouteExecutor) execute(ctx context.Context, task *model.Task, attempt *model.RouteAttempt) (taskRouteExecutionResult, error) {
	res, err := localtask.ExecuteRouteAttemptLoop(ctx, localtask.RouteExecuteDeps{
		MarkDispatching:  e.port.markRouteAttemptDispatching,
		Process:          e.port.processTask,
		RefreshState:     e.port.refreshTaskProviderState,
		FinishAttempt:    e.port.finishTaskRouteAttempt,
		NextAfterFailure: e.port.nextRouteAttemptAfterFailure,
		WriteLog:         e.port.log,
		WithSubKey:       withProviderSubmissionKey,
		IsRecoveryErr:    isImageRecoveryError,
		IsVODParamErr:    definiteVODImageParameterFailure,
		IsImageThrottle:  definiteImageThrottle,
	}, task, attempt)
	return taskRouteExecutionResult{result: res.Result, canvasOps: res.CanvasOps, err: res.Err, providerSucceeded: res.ProviderSucceeded}, err
}
