package app

import (
	"context"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
	localtask "qisitv/backend/internal/task"
)

func (s *Service) processTask(ctx context.Context, task model.Task) (map[string]interface{}, []map[string]interface{}, error) {
	return localtask.ProcessGenerationTask(
		ctx, task,
		func(parent context.Context, t model.Task) (context.Context, func(string)) {
			return s.SupportTrace().Start(taskSupportContext(parent, t), "generation.execute", taskSupportFields(t))
		},
		supportFailureReason,
		s.decryptTaskInputJSON,
		func(parent context.Context, t model.Task) (context.Context, func()) {
			execCtx := withTaskExecutionID(parent, t.ID)
			execCtx = withProviderAnalytics(execCtx, s, t)
			runtime, _ := generation.RuntimeFromContext(execCtx)
			runtime.Stages = appTaskStagePort{service: s, task: t}
			runtime.Delivery = appTaskDeliveryPort{service: s, taskID: t.ID}
			refPort := s.newReferenceProgressPort(t.ID)
			runtime.ReferenceProgress = refPort
			execCtx = generation.WithRuntime(execCtx, runtime)
			execCtx = context.WithValue(execCtx, imageTaskContext{}, t)
			return execCtx, refPort.ClearReference
		},
		s.recoverImageSubmission,
		s.processCanvasGenerationTask,
	)
}

func canRunProviderTask(task model.Task) bool {
	return localtask.CanRunProviderTask(task)
}

func hasExecutableProviderVideoConfig(input map[string]any) bool {
	return modelcatalog.HasExecutableVideoConfig(input)
}
