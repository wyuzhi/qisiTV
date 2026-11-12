package platform

import (
	"time"

	"qisitv/backend/internal/repository"
)

const TaskWorkerConcurrency = 3

// Host 由组合根注入，避免 platform → app 回环。
type Host interface {
	ChannelConcurrencyLimit(channelID string) (int, error)
}

type nopHost struct{}

func (nopHost) ChannelConcurrencyLimit(string) (int, error) {
	return 0, nil
}

type Service struct {
	repo             *repository.Repository
	host             Host
	Coordinator      *Coordinator
	concurrencyCache *BoundedReadCache[string, RuntimeTaskPolicy]
	localMode        bool
}

func New(repo *repository.Repository, coordinator *Coordinator, host Host) *Service {
	return newService(repo, coordinator, host, false)
}

// NewLocal creates the platform domain for the desktop profile. Local mode
// uses an in-memory self-use policy and must not depend on hosted runtime
// policy rows or their administrative controls.
func NewLocal(repo *repository.Repository, coordinator *Coordinator, host Host) *Service {
	return newService(repo, coordinator, host, true)
}

func newService(repo *repository.Repository, coordinator *Coordinator, host Host, localMode bool) *Service {
	if host == nil {
		host = nopHost{}
	}
	return &Service{
		repo:             repo,
		host:             host,
		Coordinator:      coordinator,
		concurrencyCache: NewBoundedReadCache[string, RuntimeTaskPolicy](1, 1024, 1, 2*time.Second),
		localMode:        localMode,
	}
}

type HostConfig struct {
	Repo *repository.Repository
}

type configHost struct {
	cfg HostConfig
}

func NewHost(cfg HostConfig) Host {
	return configHost{cfg: cfg}
}

func (h configHost) ChannelConcurrencyLimit(channelID string) (int, error) {
	if h.cfg.Repo == nil {
		return 0, nil
	}
	channel, err := h.cfg.Repo.SystemChannel(channelID)
	if err != nil {
		return 0, err
	}
	return channel.ConcurrencyLimit, nil
}

func NewForMode(repo *repository.Repository, coordinator *Coordinator, host Host, localMode bool) *Service {
	if localMode {
		return NewLocal(repo, coordinator, host)
	}
	return New(repo, coordinator, host)
}

func RuntimePolicyWithRepo(repo *repository.Repository, localMode bool) (RuntimePolicySetting, error) {
	if localMode {
		return SelfUseRuntimePolicy(), nil
	}
	return New(repo, nil, nil).RuntimePolicy()
}
