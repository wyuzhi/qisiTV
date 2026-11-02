package app

import (
	"qisitv/backend/internal/modelcatalog"
	"qisitv/backend/internal/provider"
)

func initModelCatalogPlugins() { modelcatalog.InitModelCatalogPlugins() }

func extraChannelModelCatalogItems(baseURL, apiFormat string, headers []modelcatalog.ChannelHeader) []modelcatalog.ChannelModelCatalogItem {
	return modelcatalog.ExtraChannelModelCatalogItems(baseURL, apiFormat, headers)
}

func providerCatalogItem(item provider.Model) modelcatalog.ChannelModelCatalogItem {
	return modelcatalog.ProviderCatalogItem(item)
}

func outboundHeadersMap(headers []OutboundHeader) map[string]string {
	return modelcatalog.OutboundHeadersMap(headers)
}

func modelCatalogRegion(baseURL string) string { return modelcatalog.ModelCatalogRegion(baseURL) }
func (s *Service) isPluginEnabled() bool       { return modelcatalog.IsPluginEnabled() }
