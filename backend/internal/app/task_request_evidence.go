package app

import (
	"context"
	"net/http"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
)

type taskRequestEvidenceRecorder struct {
	*generation.RequestEvidenceRecorder
}

func (r *taskRequestEvidenceRecorder) snapshot(completed bool) *model.TaskFailureDiagnostics {
	return r.Snapshot(completed)
}

func withTaskRequestEvidence(ctx context.Context, previous ...*model.TaskFailureDiagnostics) (context.Context, *taskRequestEvidenceRecorder) {
	ctx, rec := generation.WithTaskRequestEvidence(ctx, previous...)
	return bindRequestReceipts(ctx), &taskRequestEvidenceRecorder{rec}
}

func recordTaskDiagnosticInput(ctx context.Context, input canvasGenerationInput) {
	generation.RecordTaskDiagnosticInput(ctx, input)
}

func recordTaskRequestEvidence(req *http.Request, evidence model.TaskRequestEvidence, body []byte, err error) {
	generation.RecordTaskRequestEvidence(req, evidence, body, err)
}
