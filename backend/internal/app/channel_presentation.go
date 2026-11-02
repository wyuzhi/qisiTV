package app

import (
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
)

type ChannelModelSortRequest = modelcatalog.ChannelModelSortRequest

func (s *Service) updateChannelPresentation(id string, req ChannelRequest) (*PublicModelChannel, error) {
	return modelcatalog.UpdateChannelPresentation(s.repo, id, req, s.invalidateRouteCatalog)
}

func (s *Service) UpdateAdminChannelModelSort(actor *model.User, channelID, modelID string, req ChannelModelSortRequest) error {
	return modelcatalog.UpdateAdminChannelModelSort(s.repo, s.RequireAdmin, actor, channelID, modelID, req, s.invalidateRouteCatalog)
}
