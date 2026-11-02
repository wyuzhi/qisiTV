package app

import (
	"context"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/taskdelivery"
)

func (s *Service) persistTaskGeneratedMediaResult(task model.Task, result map[string]interface{}) (map[string]interface{}, error) {
	return taskdelivery.PersistTaskGeneratedMediaResult(s.generatedMediaIngestor(), task, result, func(t model.Task) func(string) {
		_, finish := s.SupportTrace().Start(taskSupportContext(context.Background(), t), "generation.persist", taskSupportFields(t))
		return finish
	}, supportFailureReason)
}

func (s *Service) persistGeneratedMediaResult(userID string, result map[string]interface{}) (map[string]interface{}, error) {
	return s.persistGeneratedMediaResultMode(userID, result, false, true)
}

func (s *Service) persistLegacyGeneratedMediaResult(userID string, result map[string]interface{}) (map[string]interface{}, error) {
	return s.persistGeneratedMediaResultMode(userID, result, true, false)
}

func (s *Service) persistGeneratedMediaResultMode(userID string, result map[string]interface{}, skipInvalidDataURL bool, enforceQuota bool) (map[string]interface{}, error) {
	return s.generatedMediaIngestor().IngestResult(userID, result, taskdelivery.IngestOptions{SkipInvalidDataURL: skipInvalidDataURL, EnforceQuota: enforceQuota})
}

func (s *Service) persistGeneratedMediaValue(userID string, value interface{}) (interface{}, error) {
	return s.generatedMediaIngestor().Ingest(userID, value, taskdelivery.IngestOptions{EnforceQuota: true})
}

func (s *Service) generatedMediaIngestor() *taskdelivery.Ingestor {
	return taskdelivery.NewServiceIngestor(s.resourceDomain(), s.generatedMediaMaxBytes)
}

func (s *Service) generatedMediaMaxBytes() (int64, error) {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return 0, err
	}
	return megabytes(policy.Resource.GeneratedFileMB), nil
}

func (s *Service) decodeDataURL(value string) (string, []byte, error) {
	return taskdelivery.DecodeDataURLWithLimit(value, s.generatedMediaMaxBytes)
}
