package app

import "qisitv/backend/internal/generation"

func (s *Service) newReferenceStoragePort() generation.ReferenceStoragePort {
	if s == nil {
		return generation.NewReferenceStoragePort(nil, "", nil)
	}
	return generation.NewReferenceStoragePort(s.IsLocalMode, s.dataDir, s.OpenResource)
}
