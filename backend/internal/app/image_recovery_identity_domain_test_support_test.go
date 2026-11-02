package app

import (
	"qisitv/backend/internal/model"
)

func (s *Service) imageRecoveryChannelAvailable(attempt *model.RouteAttempt, wire imageWireRequest) (bool, error) {
	return s.mediaAttempts().ImageRecoveryChannelAvailable(attempt, wire)
}
