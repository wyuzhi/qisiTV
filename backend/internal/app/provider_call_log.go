package app

import (
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
)

func (s *Service) EnrichAPICallLog(log *model.ApiCallLog, responseBody []byte) {
	generation.EnrichAPICallLog(log, responseBody)
}
