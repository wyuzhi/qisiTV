package app

func (s *Service) reserveUserUploadQuota(userID string, size int64) (string, error) {
	return s.reserveUserUploadQuotaFor(userID, size, "")
}

func (s *Service) reserveChunkedUploadQuota(userID string, size int64) (string, error) {
	return s.reserveChunkedUploadQuotaFor(userID, size, "")
}

func (s *Service) reserveGeneratedResourceQuota(userID string, size int64) (string, error) {
	return s.reserveGeneratedResourceQuotaFor(userID, size, "")
}

func (s *Service) reserveRetryUploadQuota(userID string, size int64) (string, error) {
	return s.reserveRetryUploadQuotaFor(userID, size, "")
}

func (s *Service) reserveRetryGeneratedQuota(userID string, size int64) (string, error) {
	return s.reserveRetryGeneratedQuotaFor(userID, size, "")
}

func (s *Service) releaseUserUploadQuota(userID string, day string, size int64) {
	s.releaseUserUploadQuotaFor(userID, day, size, "")
}

func (s *Service) releaseRetryUploadQuota(userID string, day string, size int64) {
	s.releaseRetryUploadQuotaFor(userID, day, size, "")
}

func (s *Service) commitUserUploadQuota(userID string, size int64) {
	s.commitUserUploadQuotaFor(userID, size, "")
}

func (s *Service) reserveUserUploadQuotaFor(userID string, size int64, identity string) (string, error) {
	return s.fileQuota().ReserveUpload(userID, size, identity)
}

func (s *Service) reserveChunkedUploadQuotaFor(userID string, size int64, identity string) (string, error) {
	return s.fileQuota().ReserveChunked(userID, size, identity)
}

func (s *Service) reserveGeneratedResourceQuotaFor(userID string, size int64, identity string) (string, error) {
	return s.fileQuota().ReserveGenerated(userID, size, identity)
}

func (s *Service) reserveRetryUploadQuotaFor(userID string, size int64, identity string) (string, error) {
	return s.fileQuota().ReserveRetry(userID, size, identity)
}

func (s *Service) reserveRetryGeneratedQuotaFor(userID string, size int64, identity string) (string, error) {
	return s.fileQuota().ReserveGeneratedRetry(userID, size, identity)
}

func (s *Service) releaseUserUploadQuotaFor(userID string, day string, size int64, identity string) {
	s.fileQuota().Release(userID, day, size, identity)
}

func (s *Service) releaseRetryUploadQuotaFor(userID string, day string, size int64, identity string) {
	s.fileQuota().ReleaseRetry(userID, day, size, identity)
}

func (s *Service) commitUserUploadQuotaFor(userID string, size int64, identity string) {
	s.fileQuota().Commit(userID, size, identity)
}

func pendingStorageValue(s *Service, userID, identity string) int64 {
	value, _ := s.fileQuota().PendingBytes(userID, identity)
	return value
}
