package app

import (
	"errors"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"

	"gorm.io/gorm"
)

func (s *Service) PublicLogicalModels(intent *ModelRequestIntent) ([]PublicLogicalModel, error) {
	return s.ensureRouter().PublicLogicalModels(intent)
}

func (s *Service) AdminLogicalModels(actor *model.User) ([]AdminLogicalModel, error) {
	return modelcatalog.AdminLogicalModelsFromRepo(s.repo, s.RequireAdmin, actor)
}

func (s *Service) SaveAdminLogicalModel(actor *model.User, id string, req LogicalModelRequest) (*AdminLogicalModel, error) {
	return modelcatalog.SaveAdminLogicalModelInRepo(s.repo, s.RequireAdmin, actor, id, req, s.invalidateRouteCatalog, s.appendAdminAudit)
}

func (s *Service) DeleteAdminLogicalModel(actor *model.User, id string) error {
	return modelcatalog.DeleteAdminLogicalModelInRepo(s.repo, s.RequireAdmin, actor, id, newAdminAuditEvent, s.invalidateRouteCatalog)
}

func (s *Service) logicalModelBundle(actor *model.User, id string, req LogicalModelRequest) (*model.LogicalModel, *model.LogicalModelRevision, []model.LogicalModelRoute, bool, error) {
	return modelcatalog.LogicalModelBundleFromRepo(s.repo, actor, id, req)
}

func (s *Service) SimulateLogicalModelRoute(actor *model.User, id string, intent ModelRequestIntent) (*RouteSimulationResult, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	return s.ensureRouter().SimulateLogicalModelRoute(id, intent)
}

func logicalModelNotFound(err error) bool { return errors.Is(err, gorm.ErrRecordNotFound) }
