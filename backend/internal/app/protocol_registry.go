package app

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

func (s *Service) protocolRegistry() *protocol.Registry {
	if registry := s.pluginDomain().Registry(); registry != nil {
		return registry
	}
	return loadOfficialFallbackRegistry()
}

func (s *Service) InstallPluginForAdmin(actor *model.User, data []byte, fileName string) (PluginView, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return PluginView{}, err
	}
	plugin, err := s.pluginDomain().InstallUploaded(actor.ID, data, fileName)
	if err != nil {
		return PluginView{}, mapPluginAccessError(err)
	}
	return plugin, nil
}

func (s *Service) UninstallPluginForAdmin(actor *model.User, id string) error {
	if err := s.RequireAdmin(actor); err != nil {
		return err
	}
	return mapPluginAccessError(s.pluginDomain().UninstallUploaded(id))
}
