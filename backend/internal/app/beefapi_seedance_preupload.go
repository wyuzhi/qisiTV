package app

import (
	"context"

	"qisitv/backend/internal/generation"
)

func (s *Service) prepareBeefAPISeedanceReferences(ctx context.Context, userID string, input *canvasGenerationInput) error {
	return generation.PrepareBeefAPISeedanceReferencesForUser(ctx, userID, input, s.OpenResource)
}
