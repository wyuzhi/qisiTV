package app

import (
	"qisitv/backend/internal/channelurl"
	"qisitv/backend/internal/generation"
)

// Kept for older composition roots. qisiTV supports independent assistant and
// media channels; selecting a preferred service must not disable other tools.
func (s *Service) UseLikeAIOnly() {}

func (s *Service) requireActiveProvider(protocol, baseURL string) error {
	if !isLikeAIProtocol(protocol) {
		return nil
	}
	if _, err := generation.LikeAIAuth(baseURL); err != nil {
		return BadAuthRequest(err.Error())
	}
	return nil
}

func (s *Service) requireActiveCatalogProvider(input *ChannelModelsRequest) error {
	if input.APIFormat != "likeai" {
		return nil
	}
	if input.BaseURL != "" {
		return s.requireActiveProvider("likeai-image", input.BaseURL)
	}
	input.BaseURL = channelurl.LegacyLikeAIBaseURL
	return nil
}
