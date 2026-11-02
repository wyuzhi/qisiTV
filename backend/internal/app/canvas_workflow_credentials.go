package app

import (
	cw "qisitv/backend/internal/canvasworkflow"
	"qisitv/backend/internal/model"
)

func (s *Service) canvasWorkflowProviderConfig() (map[string]any, error) {
	return s.compileHost().ProviderConfig()
}

func (s *Service) prepareCanvasWorkflowRetryCredentials(run model.CanvasWorkflowRun, nodeID string, task *model.Task) (string, error) {
	return cw.PrepareRetryCredentials(s.compileHost(), run, nodeID, task)
}

func canvasWorkflowCredentialFingerprint(input map[string]any) string {
	return cw.CredentialFingerprint(input)
}

func (s *Service) canvasWorkflowChannelID(input map[string]any, logical string) (string, error) {
	return cw.ChannelID(s.compileHost(), input, logical)
}

func (s *Service) refreshCanvasWorkflowCredentials(input map[string]any, channelID string) error {
	return cw.RefreshCredentials(s.compileHost(), input, channelID)
}
