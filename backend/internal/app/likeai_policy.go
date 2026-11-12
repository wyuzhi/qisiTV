package app

import (
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/workspace"
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
	input.BaseURL = workspace.LikeAIBaseURL
	return nil
}
