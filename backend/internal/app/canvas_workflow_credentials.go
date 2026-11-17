package app

import (
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) prepareCanvasWorkflowRetryCredentials(run model.CanvasWorkflowRun, nodeID string, task *model.Task) (string, error) {
	return cw.PrepareRetryCredentials(s.compileHost(), run, nodeID, task)
}

func (s *Service) canvasWorkflowChannelID(input map[string]any, logical string) (string, error) {
	return cw.ChannelID(s.compileHost(), input, logical)
}

func (s *Service) refreshCanvasWorkflowCredentials(input map[string]any, channelID string) error {
	return cw.RefreshCredentials(s.compileHost(), input, channelID)
}
