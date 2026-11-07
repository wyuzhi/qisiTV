package app

import "infinite-canvas/backend/internal/generation"

func (s *Service) validatePortraitTaskQuote(input map[string]any) error {
	return generation.ValidatePortraitTaskQuote(s.dataDir, input, s.lookupBeefTVCredential)
}
