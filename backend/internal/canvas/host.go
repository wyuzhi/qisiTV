package canvas

import (
	"strconv"
	"strings"

	"qisitv/backend/internal/asset"
	"qisitv/backend/internal/assets"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/platform"
	"qisitv/backend/internal/repository"
	"qisitv/backend/internal/resource"
	"sync"
)

// Host 由组合根注入，避免 canvas → service 回环。
type Host interface {
	EncryptSecret(value string) (string, error)
	DecryptSecret(value string) (string, error)
	OpenResourceRange(userID string, resource *model.Resource, rangeHeader string) (*assets.ResourceStream, error)
	PrepareResourceDelivery(userID string, resource *model.Resource, options assets.ResourceDeliveryOptions) (*assets.ResourceDelivery, error)
	WithStorageLock(fn func() error) error
	StructuredQuota(userID, kind string, creating bool, deltaBytes int64) error
	StructuredBatchQuota(userID, kind string, createdCount int, deltaBytes int64) error
	AdmitStructuredQuota(usage repository.UserStorageUsage, kind string, creating bool, deltaBytes int64) error
	StructuredReplacementQuota(userID, kind string, count int, bytes int64) error
	DeleteUserAssetWithResources(userID, assetID string, expectedStatus ...string) error
	RecordActivity(userID, event string, count int)
}

type nopHost struct{}

func (nopHost) EncryptSecret(value string) (string, error) { return value, nil }
func (nopHost) DecryptSecret(value string) (string, error) { return value, nil }
func (nopHost) OpenResourceRange(string, *model.Resource, string) (*assets.ResourceStream, error) {
	return nil, nil
}
func (nopHost) PrepareResourceDelivery(string, *model.Resource, assets.ResourceDeliveryOptions) (*assets.ResourceDelivery, error) {
	return nil, nil
}
func (nopHost) WithStorageLock(fn func() error) error {
	if fn == nil {
		return nil
	}
	return fn()
}
func (nopHost) StructuredQuota(string, string, bool, int64) error     { return nil }
func (nopHost) StructuredBatchQuota(string, string, int, int64) error { return nil }
func (nopHost) AdmitStructuredQuota(repository.UserStorageUsage, string, bool, int64) error {
	return nil
}
func (nopHost) StructuredReplacementQuota(string, string, int, int64) error  { return nil }
func (nopHost) DeleteUserAssetWithResources(string, string, ...string) error { return nil }
func (nopHost) RecordActivity(string, string, int)                           {}

type Service struct {
	repo          *repository.Repository
	host          Host
	library       *asset.Library
	interactionMu *sync.Mutex
	interactions  map[string]CanvasInteraction
}

type canvasLibraryHost struct {
	service *Service
}

func (h *canvasLibraryHost) WithStorageLock(fn func() error) error {
	return h.service.host.WithStorageLock(fn)
}
func (h *canvasLibraryHost) StructuredBatchQuota(userID, kind string, createdCount int, deltaBytes int64) error {
	return h.service.host.StructuredBatchQuota(userID, kind, createdCount, deltaBytes)
}
func (h *canvasLibraryHost) StructuredReplacementQuota(userID, kind string, count int, bytes int64) error {
	return h.service.host.StructuredReplacementQuota(userID, kind, count, bytes)
}
func (h *canvasLibraryHost) DeleteUserAssetWithResources(userID, assetID string, expectedStatus ...string) error {
	return h.service.host.DeleteUserAssetWithResources(userID, assetID, expectedStatus...)
}
func (h *canvasLibraryHost) RecordActivity(userID, event string, count int) {
	h.service.host.RecordActivity(userID, event, count)
}

var _ asset.Host = (*canvasLibraryHost)(nil)

// WithHost 返回使用指定 host 的服务副本；host 提供配额、存储锁与资源访问等真实校验。
func (s *Service) WithHost(host Host) *Service {
	if s == nil {
		return New(nil, host)
	}
	next := New(s.repo, host)
	next.interactionMu, next.interactions = s.interactionMu, s.interactions
	return next
}

// WithRepository 返回绑定到指定仓储（可为事务）的服务副本。
func (s *Service) WithRepository(repo *repository.Repository) *Service {
	if s == nil {
		return New(repo, nil)
	}
	host := s.host
	if binder, ok := host.(interface {
		WithRepository(*repository.Repository) Host
	}); ok {
		host = binder.WithRepository(repo)
	}
	next := New(repo, host)
	next.interactionMu, next.interactions = s.interactionMu, s.interactions
	if s.library != nil {
		next.library = s.library.WithRepository(repo).WithHost(&canvasLibraryHost{service: next})
	}
	return next
}

// HostConfig 聚合组合根注入给画布领域的回调，支持随事务仓储自动重绑。
type HostConfig struct {
	Repo                        *repository.Repository
	EncryptSecret               func(value string) (string, error)
	DecryptSecret               func(value string) (string, error)
	OpenResourceRange           func(userID string, resource *model.Resource, rangeHeader string) (*assets.ResourceStream, error)
	PrepareResourceDelivery     func(userID string, resource *model.Resource, options assets.ResourceDeliveryOptions) (*assets.ResourceDelivery, error)
	LockStorage                 func(fn func() error) error
	ResourcePolicy              func(repo *repository.Repository) (platform.RuntimeResourcePolicy, error)
	DeleteUserAssetWithResource func(userID, assetID string, expectedStatus ...string) error
	RecordActivity              func(userID, event string, count int)
}

type configHost struct {
	cfg HostConfig
}

func NewHost(cfg HostConfig) Host {
	return configHost{cfg: cfg}
}

func (h configHost) WithRepository(repo *repository.Repository) Host {
	next := h.cfg
	next.Repo = repo
	return configHost{cfg: next}
}

func (h configHost) EncryptSecret(value string) (string, error) {
	if h.cfg.EncryptSecret == nil {
		return value, nil
	}
	return h.cfg.EncryptSecret(value)
}

func (h configHost) DecryptSecret(value string) (string, error) {
	if h.cfg.DecryptSecret == nil {
		return value, nil
	}
	return h.cfg.DecryptSecret(value)
}

func (h configHost) OpenResourceRange(userID string, resource *model.Resource, rangeHeader string) (*assets.ResourceStream, error) {
	if h.cfg.OpenResourceRange == nil {
		return nil, nil
	}
	return h.cfg.OpenResourceRange(userID, resource, rangeHeader)
}

func (h configHost) PrepareResourceDelivery(userID string, resource *model.Resource, options assets.ResourceDeliveryOptions) (*assets.ResourceDelivery, error) {
	if h.cfg.PrepareResourceDelivery == nil {
		return nil, nil
	}
	return h.cfg.PrepareResourceDelivery(userID, resource, options)
}

func (h configHost) WithStorageLock(fn func() error) error {
	if fn == nil {
		return nil
	}
	if h.cfg.Repo != nil && h.cfg.Repo.HoldsTransaction() {
		return fn()
	}
	if h.cfg.LockStorage == nil {
		return fn()
	}
	return h.cfg.LockStorage(fn)
}

func ApplyDocumentLimitToPolicy(repo *repository.Repository, policy platform.RuntimeResourcePolicy) platform.RuntimeResourcePolicy {
	if repo == nil || repo.DB() == nil || !repo.DB().Migrator().HasTable(&model.SystemSetting{}) {
		return policy
	}
	setting, err := repo.SystemSetting(canvasDocumentLimitSettingKey)
	if err != nil || setting == nil {
		return policy
	}
	parsed, parseErr := strconv.ParseInt(strings.TrimSpace(setting.ValueJSON), 10, 64)
	if parseErr != nil || parsed < 0 || parsed > MaxCanvasDocumentLimitMB {
		return policy
	}
	if parsed == 0 {
		policy.StructuredDataMB = max(policy.StructuredDataMB, MaxCanvasDocumentLimitMB+64)
	} else if parsed+64 > policy.StructuredDataMB && parsed > DefaultCanvasDocumentLimitMB {
		policy.StructuredDataMB = parsed + 64
	}
	return policy
}

func (h configHost) StructuredQuota(userID, kind string, creating bool, deltaBytes int64) error {
	if h.cfg.ResourcePolicy == nil || h.cfg.Repo == nil {
		return nil
	}
	policy, err := h.cfg.ResourcePolicy(h.cfg.Repo)
	if err != nil {
		return err
	}
	policy = ApplyDocumentLimitToPolicy(h.cfg.Repo, policy)
	usage, err := h.cfg.Repo.UserStorageUsage(userID)
	if err != nil {
		return err
	}
	return resource.ValidateStructuredStorageQuota(usage, kind, creating, deltaBytes, policy)
}

func (h configHost) StructuredBatchQuota(userID, kind string, createdCount int, deltaBytes int64) error {
	if h.cfg.ResourcePolicy == nil || h.cfg.Repo == nil {
		return nil
	}
	policy, err := h.cfg.ResourcePolicy(h.cfg.Repo)
	if err != nil {
		return err
	}
	policy = ApplyDocumentLimitToPolicy(h.cfg.Repo, policy)
	usage, err := h.cfg.Repo.UserStorageUsage(userID)
	if err != nil {
		return err
	}
	return resource.ValidateStructuredCountQuota(usage, kind, createdCount, deltaBytes, policy)
}

func (h configHost) AdmitStructuredQuota(usage repository.UserStorageUsage, kind string, creating bool, deltaBytes int64) error {
	if h.cfg.ResourcePolicy == nil || h.cfg.Repo == nil {
		return nil
	}
	policy, err := h.cfg.ResourcePolicy(h.cfg.Repo)
	if err != nil {
		return err
	}
	policy = ApplyDocumentLimitToPolicy(h.cfg.Repo, policy)
	return resource.ValidateStructuredStorageQuota(usage, kind, creating, deltaBytes, policy)
}

func (h configHost) StructuredReplacementQuota(userID, kind string, count int, bytes int64) error {
	if h.cfg.ResourcePolicy == nil || h.cfg.Repo == nil {
		return nil
	}
	policy, err := h.cfg.ResourcePolicy(h.cfg.Repo)
	if err != nil {
		return err
	}
	policy = ApplyDocumentLimitToPolicy(h.cfg.Repo, policy)
	usage, err := h.cfg.Repo.UserStorageUsage(userID)
	if err != nil {
		return err
	}
	return resource.ValidateStructuredReplacementQuota(usage, kind, count, bytes, policy)
}

func (h configHost) DeleteUserAssetWithResources(userID, assetID string, expectedStatus ...string) error {
	if h.cfg.DeleteUserAssetWithResource == nil {
		return nil
	}
	return h.cfg.DeleteUserAssetWithResource(userID, assetID, expectedStatus...)
}

func (h configHost) RecordActivity(userID, event string, count int) {
	if h.cfg.RecordActivity == nil {
		return
	}
	h.cfg.RecordActivity(userID, event, count)
}

func New(repo *repository.Repository, host Host) *Service {
	if host == nil {
		host = nopHost{}
	}
	s := &Service{repo: repo, host: host, interactionMu: &sync.Mutex{}, interactions: make(map[string]CanvasInteraction)}
	if repo != nil && !repo.HoldsTransaction() {
		s.hydrateCanvasDocumentLimitFromDB()
	}
	s.library = asset.NewLibrary(repo, &canvasLibraryHost{service: s})
	return s
}

func (s *Service) Library() *asset.Library {
	if s == nil {
		return asset.NewLibrary(nil, nil)
	}
	if s.library != nil {
		return s.library
	}
	return asset.NewLibrary(s.repo, &canvasLibraryHost{service: s})
}
