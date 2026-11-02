package app

import (
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
)

func captureTaskFailureDiagnostics(task *model.Task, err error, source string) {
	generation.CaptureTaskFailureDiagnostics(task, err, source)
}
