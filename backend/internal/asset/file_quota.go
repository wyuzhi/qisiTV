package asset

import (
	"errors"
	"fmt"
	"qisitv/backend/internal/kernel"
	"log"
	"strings"
	"sync"
	"time"

	"qisitv/backend/internal/repository"
)

// FileQuota owns file reservations and pending bytes. The lock also guards
// resource promotion and other storage writes assembled by the application.
type FileQuota struct {
	repo           FileQuotaStore
	policy         func() (FileQuotaPolicy, error)
	mu             sync.Locker
	pendingStorage map[string]int64
}

type FileQuotaStore interface {
	UserStoredFileBytes(string) (int64, error)
	ReserveIdentifiedDailyUpload(string, string, string, int64, int64) error
	ReleaseIdentifiedDailyUpload(string, string, string, int64) error
	ClearUploadReservation(string, string) error
}

type FileQuotaPolicy struct{ ResourceUploadMB, GeneratedFileMB, DailyUploadMB, StoredFileGB int64 }

func NewFileQuota(repo FileQuotaStore, policy func() (FileQuotaPolicy, error), lock sync.Locker) *FileQuota {
	if lock == nil {
		lock = &sync.Mutex{}
	}
	return &FileQuota{repo: repo, policy: policy, mu: lock}
}

func (s *FileQuota) PendingBytes(userID, identity string) (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.pendingStorage[pendingStorageKey(userID, identity)]
	return value, ok
}

func pendingStorageKey(userID, identity string) string {
	return strings.TrimSpace(userID) + "\x00" + strings.TrimSpace(identity)
}

func (s *FileQuota) pendingStorageTotal(userID string) int64 {
	prefix := strings.TrimSpace(userID) + "\x00"
	var total int64
	for key, size := range s.pendingStorage {
		if strings.HasPrefix(key, prefix) {
			total += size
		}
	}
	return total
}

// 上传额度在写文件或 OSS 前原子预留，避免并发请求同时通过日限额检查。
func (s *FileQuota) ReserveUpload(userID string, size int64, identity string) (string, error) {
	policy, err := s.policy()
	if err != nil {
		return "", err
	}
	return s.reserveUserStoredFileQuota(userID, size, kernel.Megabytes(policy.ResourceUploadMB), kernel.Megabytes(policy.DailyUploadMB), kernel.Gigabytes(policy.StoredFileGB), fmt.Sprintf("单个上传文件必须小于 %dMB", policy.ResourceUploadMB), identity)
}

// reserveChunkedUploadQuota 用于分片上传完成时预留额度：单文件上限对分片会话不适用（每片已独立校验），
// 仅受“今日上传”与“账号存储总量”约束；singleFileLimit 传 size+1 使单文件上限永不命中。
func (s *FileQuota) ReserveChunked(userID string, size int64, identity string) (string, error) {
	policy, err := s.policy()
	if err != nil {
		return "", err
	}
	return s.reserveUserStoredFileQuota(userID, size, size+1, kernel.Megabytes(policy.DailyUploadMB), kernel.Gigabytes(policy.StoredFileGB), "", identity)
}

func (s *FileQuota) ReserveGenerated(userID string, size int64, identity string) (string, error) {
	policy, err := s.policy()
	if err != nil {
		return "", err
	}
	return s.reserveUserStoredFileQuota(userID, size, kernel.Megabytes(policy.GeneratedFileMB)+1, kernel.Megabytes(policy.DailyUploadMB), kernel.Gigabytes(policy.StoredFileGB), fmt.Sprintf("单个生成文件不能超过 %dMB", policy.GeneratedFileMB), identity)
}

// 失败资源的记录已经计入账号存储用量；重试只重新预留当日上传额度，避免重复计算存储容量。
func (s *FileQuota) ReserveRetry(userID string, size int64, identity string) (string, error) {
	policy, err := s.policy()
	if err != nil {
		return "", err
	}
	if size <= 0 {
		return "", kernel.BadAuthRequest("上传文件不能为空")
	}
	if size >= kernel.Megabytes(policy.ResourceUploadMB) {
		return "", kernel.BadAuthRequest(fmt.Sprintf("单个上传文件必须小于 %dMB", policy.ResourceUploadMB))
	}
	day := time.Now().UTC().Format("2006-01-02")
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.repo.ReserveIdentifiedDailyUpload(userID, day, identity, size, kernel.Megabytes(policy.DailyUploadMB)); err != nil {
		if errors.Is(err, repository.ErrDailyUploadLimitExceeded) {
			return "", kernel.QuotaExceeded(fmt.Sprintf("每个账号 UTC 自然日上传总量必须小于 %s", FormatStorageLimit(kernel.Megabytes(policy.DailyUploadMB))))
		}
		if errors.Is(err, repository.ErrUploadReservationConflict) {
			return "", UploadInProgress()
		}
		return "", err
	}
	return day, nil
}

func (s *FileQuota) ReserveGeneratedRetry(userID string, size int64, identity string) (string, error) {
	policy, err := s.policy()
	if err != nil {
		return "", err
	}
	if size <= 0 {
		return "", kernel.BadAuthRequest("上传文件不能为空")
	}
	if size >= kernel.Megabytes(policy.GeneratedFileMB)+1 {
		return "", kernel.BadAuthRequest(fmt.Sprintf("单个生成文件不能超过 %dMB", policy.GeneratedFileMB))
	}
	day := time.Now().UTC().Format("2006-01-02")
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.repo.ReserveIdentifiedDailyUpload(userID, day, identity, size, kernel.Megabytes(policy.DailyUploadMB)); err != nil {
		if errors.Is(err, repository.ErrDailyUploadLimitExceeded) {
			return "", kernel.QuotaExceeded(fmt.Sprintf("每个账号 UTC 自然日上传总量必须小于 %s", FormatStorageLimit(kernel.Megabytes(policy.DailyUploadMB))))
		}
		if errors.Is(err, repository.ErrUploadReservationConflict) {
			return "", UploadInProgress()
		}
		return "", err
	}
	return day, nil
}

func (s *FileQuota) reserveUserStoredFileQuota(userID string, size int64, exclusiveSingleFileLimit int64, dailyLimit int64, storedLimit int64, singleFileMessage string, identity string) (string, error) {
	if size <= 0 {
		return "", kernel.BadAuthRequest("上传文件不能为空")
	}
	if size >= exclusiveSingleFileLimit {
		return "", kernel.BadAuthRequest(singleFileMessage)
	}
	day := time.Now().UTC().Format("2006-01-02")
	s.mu.Lock()
	defer s.mu.Unlock()
	storedBytes, err := s.repo.UserStoredFileBytes(userID)
	if err != nil {
		return "", err
	}
	if s.pendingStorage == nil {
		s.pendingStorage = map[string]int64{}
	}
	key := pendingStorageKey(userID, identity)
	if storedBytes+s.pendingStorageTotal(userID)+size >= storedLimit {
		return "", kernel.QuotaExceeded(fmt.Sprintf("账号资源和会话附件已达到 %s 上限，请联系管理员清理历史文件", FormatStorageLimit(storedLimit)))
	}
	s.pendingStorage[key] += size
	if err := s.repo.ReserveIdentifiedDailyUpload(userID, day, identity, size, dailyLimit); err != nil {
		s.decreasePendingStorage(key, size)
		if errors.Is(err, repository.ErrDailyUploadLimitExceeded) {
			return "", kernel.QuotaExceeded(fmt.Sprintf("每个账号 UTC 自然日上传总量必须小于 %s", FormatStorageLimit(dailyLimit)))
		}
		if errors.Is(err, repository.ErrUploadReservationConflict) {
			return "", UploadInProgress()
		}
		return "", err
	}
	return day, nil
}

func FormatStorageLimit(value int64) string {
	if value%(1<<30) == 0 {
		return fmt.Sprintf("%dGB", value>>30)
	}
	return fmt.Sprintf("%dMB", value>>20)
}

func (s *FileQuota) Release(userID string, day string, size int64, identity string) {
	if day == "" || size <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.repo.ReleaseIdentifiedDailyUpload(userID, day, identity, size); err != nil {
		log.Printf("release upload quota failed: user=%s day=%s size=%d error=%v", userID, day, size, err)
		return
	}
	s.decreasePendingStorage(pendingStorageKey(userID, identity), size)
}

func (s *FileQuota) ReleaseRetry(userID string, day string, size int64, identity string) {
	if day == "" || size <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.repo.ReleaseIdentifiedDailyUpload(userID, day, identity, size); err != nil {
		log.Printf("release retry upload quota failed: user=%s day=%s size=%d error=%v", userID, day, size, err)
		return
	}
}

func (s *FileQuota) Commit(userID string, size int64, identity string) {
	if size <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.repo != nil {
		if err := s.repo.ClearUploadReservation(userID, identity); err != nil {
			log.Printf("clear upload reservation failed: user=%s identity=%s error=%v", userID, identity, err)
			return
		}
	}
	key := pendingStorageKey(userID, identity)
	if _, ok := s.pendingStorage[key]; ok {
		s.decreasePendingStorage(key, size)
	}
}

func (s *FileQuota) decreasePendingStorage(key string, size int64) {
	remaining := s.pendingStorage[key] - size
	if remaining > 0 {
		s.pendingStorage[key] = remaining
		return
	}
	delete(s.pendingStorage, key)
}
