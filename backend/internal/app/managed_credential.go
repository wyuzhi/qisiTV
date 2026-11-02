package app

import (
	"qisitv/backend/internal/beefapi"
	"qisitv/backend/internal/generation"
)

const managedBeefAPIRef = beefapi.CredentialRef

func (s *Service) SetBeefAPI(connection *beefapi.Service) {
	if s != nil {
		s.beefAPI = connection
	}
}

func (s *Service) BeefAPI() *beefapi.Service {
	if s == nil {
		return nil
	}
	return s.beefAPI
}

func (s *Service) resolveManagedBeefAPISecrets(input map[string]any) (map[string]any, error) {
	return generation.ResolveManagedBeefAPISecrets(input, s.beefAPI, s.ReadLocalModelConfig)
}

func (s *Service) lookupBeefAPICredential() (apiKey, baseURL, accountID, tokenID string, err error) {
	return generation.LookupBeefAPICredential(s.beefAPI, s.ReadLocalModelConfig)
}

func (s *Service) resolveChannelModelsRequest(input *ChannelModelsRequest) error {
	return generation.ResolveChannelModelsRequest(input, s.beefAPI, s.ReadLocalModelConfig)
}

func (s *Service) ResolveCustomRelayAPIKey(targetURL, incoming string) (string, error) {
	return generation.ResolveCustomRelayKey(targetURL, incoming, s.beefAPI, s.ReadLocalModelConfig)
}

func (s *Service) resolveCustomRelayKey(targetURL, incoming string) (string, error) {
	return generation.ResolveCustomRelayKey(targetURL, incoming, s.beefAPI, s.ReadLocalModelConfig)
}

func (s *Service) noteBeefAPIProviderError(message string) {
	if s != nil {
		generation.NoteBeefAPIProviderError(s.beefAPI, message)
	}
}
