package app

import "qisitv/backend/internal/operations"

// Every read resolves current DB membership, including after host recovery.
// A search result or model-provided ID is never itself an authorization receipt.
func (s *Service) ValidateAgentProjectReference(userID, canvasID, kind, id string) error {
	return operations.ValidateProjectReference(s.repo, s.activeProjectForUser, userID, canvasID, kind, id)
}

func (s *operationSession) SearchAgentProject(userID, canvasID, target, query, kind string, page, size int) (any, error) {
	return operations.SearchProject(s.service.repo, s.canvas, s.service.activeProjectForUser, s.OwnedReadyResource, userID, canvasID, target, query, kind, page, size)
}
