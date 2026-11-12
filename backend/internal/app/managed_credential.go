package app

import (
	"qisitv/backend/internal/beeftv"
	"qisitv/backend/internal/generation"
)

const managedBeefTVRef = beeftv.CredentialRef

func (s *Service) SetBeefTV(connection *beeftv.Service) {
	if s != nil {
		s.beefTV = connection
	}
}

func (s *Service) BeefTV() *beeftv.Service {
	if s == nil {
		return nil
	}
	return s.beefTV
}

func (s *Service) resolveManagedBeefTVSecrets(input map[string]any) (map[string]any, error) {
	return generation.ResolveManagedBeefTVSecrets(input, s.beefTV, s.ReadLocalModelConfig)
}

func (s *Service) lookupBeefTVCredential() (apiKey, baseURL, accountID, tokenID string, err error) {
	return generation.LookupBeefTVCredential(s.beefTV, s.ReadLocalModelConfig)
}

func (s *Service) resolveChannelModelsRequest(input *ChannelModelsRequest) error {
	return generation.ResolveChannelModelsRequest(input, s.beefTV, s.ReadLocalModelConfig)
}

func (s *Service) ResolveCustomRelayAPIKey(targetURL, incoming string) (string, error) {
	return generation.ResolveCustomRelayKey(targetURL, incoming, s.beefTV, s.ReadLocalModelConfig)
}

func (s *Service) resolveCustomRelayKey(targetURL, incoming string) (string, error) {
	return generation.ResolveCustomRelayKey(targetURL, incoming, s.beefTV, s.ReadLocalModelConfig)
}

func (s *Service) noteBeefTVProviderError(message string) {
	if s != nil {
		generation.NoteBeefTVProviderError(s.beefTV, message)
	}
}
