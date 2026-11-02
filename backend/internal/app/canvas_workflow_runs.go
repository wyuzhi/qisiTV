package app

import (
	"context"

	cw "qisitv/backend/internal/canvasworkflow"
	"qisitv/backend/internal/editing"
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

func (s *Service) CanvasWorkflowRunService() *cw.Runs               { return s.workflowRuns() }
func (s *Service) startCanvasWorkflowScheduler(ctx context.Context) { s.workflowRuns().StartScheduler(ctx) }
func (s *Service) workflowRuns() *cw.Runs {
	host := cw.NewRunHost(cw.RunHostConfig{
		Compile:        s.compileHost(),
		CreateTask:     func(u string, req cw.RecipeRequest) (*model.Task, error) { return s.CreateTask(u, createTaskRequestFromRecipe(req)) },
		Upscale:        s.executeWorkflowUpscale,
		CanvasMedia:    func(u, op string, n cw.Node, res string) (*model.Task, error) { return s.taskDomain().CreateCanvasMediaTask(u, n, res, op) },
		DepthCapture:   func(u, op, res string) (*model.Task, error) { return s.CreateDepthCaptureTask(u, DepthCaptureCreateRequest{ResourceID: res, ClientOperationID: op}) },
		TimelineRender: func(u, op string, p editing.Project, opts editing.Options) (*model.Task, error) { return s.CreateTimelineRenderTask(u, TimelineRenderCreateRequest{Timeline: p, Options: opts, ClientOperationID: op}) },
		RecoverUpscale: s.RecoverMediaUpscale, RetryRefresh: s.taskDomain().RetryWithCredentialRefresh, RetryTask: s.RetryTask,
		CancelTask:     func(ctx context.Context, u, id string) error { _, err := s.CancelTask(ctx, u, id); return err },
		Outputs:        s.workflowTaskOutputs, FailureMessage: safePersistedFailureMessage, Draining: s.IsDraining, RunLoop: s.runWorkerLoop,
	})
	return cw.NewRuns(s.repo, s.workflowTemplates(), host, &s.canvasWorkflowMu, &s.canvasWorkflowLoop)
}
func (s *Service) workflowTaskOutputs(task *model.Task) ([]cw.TaskOutput, []cw.TaskOutput) {
	convert := func(values []localtask.CanonicalOutput) []cw.TaskOutput {
		out := make([]cw.TaskOutput, 0, len(values))
		for _, v := range values {
			out = append(out, cw.TaskOutput{OutputIndex: v.OutputIndex, MediaType: v.MediaType, ResourceID: v.ResourceID})
		}
		return out
	}
	stored, _ := s.generationDeliverer().LoadedOutputs(task.ID)
	return convert(localtask.CanonicalOutputs(task.ResultJSON, task.Type)), convert(stored)
}

type workflowRunHost struct{ s *Service }

func (h workflowRunHost) TimelineRender(u, op string, p editing.Project, opts editing.Options) (*model.Task, error) {
	return h.s.CreateTimelineRenderTask(u, TimelineRenderCreateRequest{Timeline: p, Options: opts, ClientOperationID: op})
}
