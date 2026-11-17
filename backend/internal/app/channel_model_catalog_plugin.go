package app

import (
	"infinite-canvas/backend/internal/modelcatalog"
)

func extraChannelModelCatalogItems(baseURL, apiFormat string, headers []modelcatalog.ChannelHeader) []modelcatalog.ChannelModelCatalogItem {
	return modelcatalog.ExtraChannelModelCatalogItems(baseURL, apiFormat, headers)
}

func (s *Service) isPluginEnabled() bool { return modelcatalog.IsPluginEnabled() }
