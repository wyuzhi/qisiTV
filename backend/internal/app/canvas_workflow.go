package app

import (
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) workflowResource(user, id, kind string) (*model.Resource, error) {
	return cw.ReadyResource(s.repo, user, id, kind)
}

func workflowReferenceID(v any) string { return cw.ReferenceID(v) }
