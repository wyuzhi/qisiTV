package app

import (
	"context"

	"infinite-canvas/backend/internal/generation"
)

func (s *Service) prepareBeefTVSeedanceReferences(ctx context.Context, userID string, input *canvasGenerationInput) error {
	return generation.PrepareBeefTVSeedanceReferencesForUser(ctx, userID, input, s.OpenResource)
}
