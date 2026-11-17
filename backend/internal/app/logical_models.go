package app

import (
	"infinite-canvas/backend/internal/model"
)

func (s *Service) PublicLogicalModels(intent *ModelRequestIntent) ([]PublicLogicalModel, error) {
	return s.ensureRouter().PublicLogicalModels(intent)
}

func (s *Service) SimulateLogicalModelRoute(actor *model.User, id string, intent ModelRequestIntent) (*RouteSimulationResult, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	return s.ensureRouter().SimulateLogicalModelRoute(id, intent)
}
