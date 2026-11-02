package app

import (
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
)

type ModelCatalogSource = modelcatalog.CatalogSource
type ModelCatalogResponse = modelcatalog.CatalogResponse

const (
	ModelCatalogSourceFrontend = modelcatalog.CatalogSourceFrontend
	ModelCatalogSourceSystem   = modelcatalog.CatalogSourceSystem
)

func (s *Service) ModelCatalog(intent *ModelRequestIntent) (*ModelCatalogResponse, error) {
	frontendEnabled, err := s.FeatureEnabled(FeatureFrontendModels)
	if err != nil {
		return nil, err
	}
	return modelcatalog.BuildModelCatalogResponse(frontendEnabled, s.PublicLogicalModels, s.publicSystemChannelCatalog, intent)
}

func (s *Service) publicSystemChannelCatalog(intent *ModelRequestIntent) ([]PublicChannelCatalog, error) {
	return modelcatalog.PublicSystemChannelCatalogFromRepo(s.repo, intent)
}

func (s *Service) sanitizeChannelModel(cm *model.ChannelModel) (PublicChannelModel, error) {
	return modelcatalog.SanitizeChannelModel(cm)
}

func (s *Service) channelModelMatchesIntent(cm *model.ChannelModel, intent *ModelRequestIntent) (bool, error) {
	return modelcatalog.ChannelModelMatchesIntent(cm, intent)
}
