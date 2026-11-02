package app

import "qisitv/backend/internal/resource"

type StorageMigrationSummary = resource.StorageMigrationSummary

func (s *Service) MigrateLegacyStorage() (StorageMigrationSummary, error) {
	return resource.MigrateLegacyStorage(s.repo, s.dataDir, s.persistLegacyGeneratedMediaResult, s.protectTaskSecrets, publicTaskInputJSON)
}
