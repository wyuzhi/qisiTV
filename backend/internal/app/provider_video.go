package app

import (
	"context"

	"qisitv/backend/internal/generation"
)

func (s *Service) validateResolvedVideoCapability(input *canvasGenerationInput) error {
	return s.validateResolvedVideoCapabilityContext(context.Background(), input)
}

func (s *Service) validateResolvedVideoCapabilityContext(ctx context.Context, input *canvasGenerationInput) error {
	return generation.ValidateResolvedVideoCapabilityContext(ctx, s.repo, s.ReadLocalModelConfig, input)
}

func (s *Service) resolveVideoCapability(ctx context.Context, input *canvasGenerationInput) error {
	return generation.ResolveVideoCapability(ctx, s.repo, s.ReadLocalModelConfig, input)
}
