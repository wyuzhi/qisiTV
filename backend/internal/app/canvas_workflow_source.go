package app

import (
	cw "qisitv/backend/internal/canvasworkflow"
	"qisitv/backend/internal/model"
)

func (s *Service) captureCanvasWorkflowSource(task model.Task) (string, error) {
	return cw.CaptureSource(s.compileHost(), task)
}
