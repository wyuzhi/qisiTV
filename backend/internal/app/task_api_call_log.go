package app

import (
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
)

func (s *Service) ensureFailedProviderAttemptLogged(task model.Task, taskErr error) {
	if s == nil {
		return
	}
	generation.EnsureFailedProviderAttemptLogged(s.repo, task, taskErr, s.decryptTaskInputJSON, s.UserFacingErrorMessage, s.LogAPICall)
}
