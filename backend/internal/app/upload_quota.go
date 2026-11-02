package app

import "qisitv/backend/internal/asset"

func (s *Service) fileQuota() *asset.FileQuota {
	s.fileQuotaOnce.Do(func() {
		s.fileQuotaService = asset.NewFileQuota(s.repo, func() (asset.FileQuotaPolicy, error) {
			policy, err := s.RuntimePolicy()
			return asset.FileQuotaPolicy{ResourceUploadMB: policy.Resource.ResourceUploadMB, GeneratedFileMB: policy.Resource.GeneratedFileMB, DailyUploadMB: policy.Resource.DailyUploadMB, StoredFileGB: policy.Resource.StoredFileGB}, err
		}, &s.storageMu)
	})
	return s.fileQuotaService
}

func formatStorageLimit(value int64) string { return asset.FormatStorageLimit(value) }
