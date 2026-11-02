package app

import "qisitv/backend/internal/generation"

func (s *Service) syncProviderTaskProgress(taskID string, responseBody []byte) {
	if s == nil {
		return
	}
	generation.SyncProviderTaskProgress(s.repo, taskID, responseBody)
}

func providerProgressFromResponse(responseBody []byte) (int, bool) {
	return generation.ProviderProgressFromResponse(responseBody)
}
