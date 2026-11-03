package app

import (
	"errors"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
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

func logicalModelNotFound(err error) bool { return errors.Is(err, gorm.ErrRecordNotFound) }
