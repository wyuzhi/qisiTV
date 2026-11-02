package app

import (
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
)

type ChannelOrderItem = modelcatalog.ChannelOrderItem
type ChannelOrderRequest = modelcatalog.ChannelOrderRequest

func (s *Service) AdminChannelOrder(actor *model.User, channelID string) ([]ChannelOrderItem, error) {
	return modelcatalog.AdminChannelOrder(s.repo, s.RequireAdmin, actor, channelID)
}

func (s *Service) SaveAdminChannelOrder(actor *model.User, channelID string, req ChannelOrderRequest) error {
	return modelcatalog.SaveAdminChannelOrder(s.repo, s.RequireAdmin, actor, channelID, req, s.invalidateRouteCatalog)
}
