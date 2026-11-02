package app

import (
	"context"
	"strings"
	"time"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
)

type AdminChannelModelImportRequest = modelcatalog.AdminChannelModelImportRequest
type AdminChannelModelTestResult = modelcatalog.AdminChannelModelTestResult

func (s *Service) EnsureSystemChannelModels() error {
	return modelcatalog.EnsureSystemChannelModelsInRepo(s.repo)
}

func (s *Service) AdminChannelModels(actor *model.User, channelID string) ([]model.ChannelModel, error) {
	return modelcatalog.AdminChannelModelsFromRepo(s.repo, s.RequireAdmin, s.adminSystemChannel, actor, channelID)
}

func (s *Service) SystemChannelModel(channelID string, modelKey string) (*model.ChannelModel, error) {
	return s.repo.ChannelModelByKey(channelID, strings.TrimPrefix(strings.TrimSpace(modelKey), "models/"))
}

func (s *Service) SystemChannelHasProtocol(channelID string, protocol model.ChannelInterfaceType) (bool, error) {
	return modelcatalog.SystemChannelHasProtocolInRepo(s.repo, channelID, protocol)
}

func (s *Service) FetchAdminChannelModels(ctx context.Context, actor *model.User, channelID string) (*AdminChannelModelFetchResult, error) {
	return modelcatalog.FetchAdminChannelModelsInRepo(ctx, s.repo, s.RequireAdmin, s.adminSystemChannel, func(ctx context.Context, actor *model.User, channel *model.ModelChannel) ([]string, error) {
		headers, err := ParseOutboundHeadersJSON(channel.HeadersJSON)
		if err != nil {
			return nil, err
		}
		return s.FetchChannelModels(ctx, actor, ChannelModelsRequest{BaseURL: channel.BaseURL, APIKey: channel.APIKey, APIFormat: channel.APIFormat, Headers: headers})
	}, s.invalidateRouteCatalog, actor, channelID)
}

func (s *Service) PreviewAdminChannelModels(ctx context.Context, actor *model.User, channelID string) ([]string, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	return s.fetchAdminChannelModelCatalog(ctx, actor, channelID)
}

func (s *Service) ImportAdminChannelModels(ctx context.Context, actor *model.User, channelID string, selected []string) (*AdminChannelModelFetchResult, error) {
	return modelcatalog.ImportAdminChannelModelsInRepo(ctx, s.repo, s.RequireAdmin, s.adminSystemChannel, s.fetchAdminChannelModelCatalog, s.invalidateRouteCatalog, actor, channelID, selected)
}

func (s *Service) fetchAdminChannelModelCatalog(ctx context.Context, actor *model.User, channelID string) ([]string, error) {
	channel, err := s.adminSystemChannel(channelID)
	if err != nil {
		return nil, err
	}
	headers, err := ParseOutboundHeadersJSON(channel.HeadersJSON)
	if err != nil {
		return nil, err
	}
	models, err := s.FetchChannelModels(ctx, actor, ChannelModelsRequest{BaseURL: channel.BaseURL, APIKey: channel.APIKey, APIFormat: channel.APIFormat, Headers: headers})
	if err != nil {
		return nil, err
	}
	return uniqueNonEmpty(models), nil
}

func (s *Service) SaveAdminChannelModel(actor *model.User, channelID string, id string, req ChannelModelRequest) (*model.ChannelModel, error) {
	return modelcatalog.SaveAdminChannelModelInRepo(s.repo, s.RequireAdmin, actor, channelID, id, req, s.normalizeChannelModelContract, s.invalidateRouteCatalog)
}

func (s *Service) syncLogicalModelsFromChannelModel(_ *model.User, _ *model.ChannelModel) error {
	s.invalidateRouteCatalog()
	return nil
}

func (s *Service) TestAdminChannelModel(ctx context.Context, actor *model.User, channelID string, req ChannelModelRequest) (*AdminChannelModelTestResult, error) {
	return generation.TestAdminChannelModel(ctx, s.RequireAdmin, s.adminSystemChannel, s.normalizeChannelModelContract, s.bindGenerationRuntime, s.protocolRegistry(), actor, channelID, req)
}

func (s *Service) DeleteAdminChannelModel(actor *model.User, channelID string, id string) error {
	_, err := s.DeleteAdminChannelModels(actor, channelID, []string{id})
	return err
}

func (s *Service) DeleteAdminChannelModels(actor *model.User, channelID string, ids []string) (int64, error) {
	return modelcatalog.DeleteAdminChannelModelsInRepo(s.repo, s.RequireAdmin, actor, channelID, ids, s.invalidateRouteCatalog)
}

func (s *Service) syncInitialChannelModels(channel *model.ModelChannel, names []string) error {
	return modelcatalog.SyncInitialChannelModelsInRepo(s.repo, channel, names)
}

func (s *Service) ensureChannelModels(channelID string, includeDisabled bool) ([]model.ChannelModel, error) {
	return modelcatalog.EnsureChannelModelsInRepo(s.repo, channelID, includeDisabled)
}

func (s *Service) syncChannelModelNames(channel *model.ModelChannel) error {
	return s.repo.SyncChannelModelNames(channel.ID, time.Now())
}

func (s *Service) capabilityForProtocol(protocol model.ChannelInterfaceType) string {
	metadata, ok := s.channelProtocolMetadata(string(protocol))
	if !ok {
		return ""
	}
	return protocolCapabilityFromMetadata(metadata)
}
