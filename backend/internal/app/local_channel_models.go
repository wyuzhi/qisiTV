package app

import (
	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/modelcatalog"
)

type localChannelModel = modelcatalog.LocalChannelModel

func (s *Service) localChannelModels() []localChannelModel {
	if s == nil || !s.IsLocalMode() {
		return nil
	}
	body, err := s.ReadLocalModelConfig()
	if err != nil || len(body) == 0 {
		return nil
	}
	return modelcatalog.ParseLocalChannelModels(body)
}

func (s *Service) localChannelModel(channelID, modelKey string) (localChannelModel, bool) {
	for _, item := range s.localChannelModels() {
		if item.ChannelID == channelID && item.Model == modelKey {
			return item, true
		}
	}
	return localChannelModel{}, false
}

func (s *Service) localChannelModelListItems(intent *ModelRequestIntent) []map[string]any {
	return modelcatalog.LocalChannelModelListItems(s.localChannelModels(), intent, beeftv.ChannelID, managedBeefTVRef)
}

func catalogModelName(raw any) string                 { return modelcatalog.CatalogModelName(raw) }
func coerceCatalogModels(value any) []map[string]any  { return modelcatalog.CoerceCatalogModels(value) }
