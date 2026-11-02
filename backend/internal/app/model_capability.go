package app

import (
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
)

func (s *Service) ValidateTaskCapability(input map[string]any) error {
	return generation.ValidateTaskCapability(input, s.resolveVideoCapability, func(mode string, config providerConfig) (bool, error) {
		if isWorkflowProviderInterface(config.InterfaceType) {
			return true, validateWorkflowProviderConfig(mode, config)
		}
		return false, nil
	}, s.channelModelLookup())
}

func (s *Service) channelModelLookup() modelcatalog.ChannelModelLookup {
	return func(channelID, modelKey string) (*model.ChannelModel, error) {
		return s.repo.ChannelModelByKey(channelID, modelKey)
	}
}
