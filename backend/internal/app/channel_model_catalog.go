package app

import (
	"context"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
)

type ChannelModelsRequest = generation.ChannelModelsRequest

func (s *Service) FetchChannelModels(ctx context.Context, actor *model.User, input ChannelModelsRequest) ([]string, error) {
	items, err := s.FetchChannelModelCatalog(ctx, actor, input)
	if err != nil {
		return nil, err
	}
	return modelcatalog.CatalogModelIDs(items), nil
}

func (s *Service) FetchChannelModelCatalog(ctx context.Context, actor *model.User, input ChannelModelsRequest) ([]ChannelModelCatalogItem, error) {
	return generation.FetchChannelModelCatalog(ctx, actor, input, func(input *ChannelModelsRequest) error {
		if err := s.resolveChannelModelsRequest(input); err != nil {
			return err
		}
		return s.requireActiveCatalogProvider(input)
	}, s.fetchChannelModelCatalogBytes, s.catalogExtraSource(), s.protocolRegistry().Resolve)
}

func (s *Service) fetchChannelModelCatalogBytes(ctx context.Context, baseURL, apiFormat, apiKey string, headers []modelcatalog.ChannelHeader) ([]byte, error) {
	return generation.FetchChannelModelCatalogBytes(ctx, baseURL, apiFormat, apiKey, headers)
}

func (s *Service) catalogExtraSource() modelcatalog.CatalogExtraSource {
	if s == nil || !s.isPluginEnabled() {
		return nil
	}
	return extraChannelModelCatalogItems
}

func mapChannelModelCatalogError(err error) error { return generation.MapChannelModelCatalogError(err) }
func channelModelsUpstreamError(err error) error  { return generation.ChannelModelsUpstreamError(err) }
func catalogError(status int, reason kernel.ErrorReason, message string, cause error) *AppError {
	return generation.CatalogError(status, reason, message, cause)
}
