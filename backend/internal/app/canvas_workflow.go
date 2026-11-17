package app

import (
	cw "qisitv/backend/internal/canvasworkflow"
	"qisitv/backend/internal/model"
)

func (s *Service) workflowResource(user, id, kind string) (*model.Resource, error) {
	return cw.ReadyResource(s.repo, user, id, kind, s.EnsureResourceMediaMetadata)
}

func workflowReferenceID(v any) string { return cw.ReferenceID(v) }
