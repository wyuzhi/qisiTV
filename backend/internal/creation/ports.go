package creation

import (
	"encoding/json"
	"sync"
	"time"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/platform"
	"qisitv/backend/internal/repository"
	"qisitv/backend/internal/resource"
	localtask "qisitv/backend/internal/task"
)

// Tasks is the typed task-admission seam. Creation never imports internal/app
// or calls Service.CreateTask. Prepare quotes without persisting. Admit is a
// local SQLite insert on the MutateCreationRun transaction repository.
type Tasks interface {
	Prepare(userID string, req TaskRequest) (*PreparedTask, error)
	Admit(userID string, repo *repository.Repository, task *model.Task) (*model.Task, error)
}

// Secrets protects credentials after quoting and before durable submit.
type Secrets interface {
	Protect(input map[string]any) error
}

// Quota is workspace structured-storage policy. Creation records and canvas
// documents share the canvas quota class but are measured separately.
type Quota interface {
	ValidateRun(userID string, repo *repository.Repository, creating bool, delta int64) error
	ValidateCanvas(userID string, repo *repository.Repository, creating bool, delta int64) error
}

// Media rejects canvas documents that point at unowned or unreadied assets.
// The repository must be the MutateCreationRun transaction, not the root
// connection, so concurrent asset/resource deletion is visible to the write.
type Media interface {
	ValidateDocument(userID string, repo *repository.Repository, raw json.RawMessage) error
}

// TaskKinds identifies generation modes that creation refuses to quote.
type TaskKinds interface {
	UsesWorkflow(input map[string]any) bool
	UsesTextReplay(input map[string]any) bool
}

// Dependencies are the explicit collaborators. Missing ports fail closed on
// the path that needs them.
type Dependencies struct {
	Tasks       Tasks
	Secrets     Secrets
	Quota       Quota
	Media       Media
	Kinds       TaskKinds
	StorageLock sync.Locker
	FormatTask  func(model.Task) *model.Task
	Now         func() time.Time
	NewID       func() string
}

type Host interface {
	Tasks
	Protect(input map[string]any) error
	ValidateCanvas(userID string, repo *repository.Repository, creating bool, delta int64) error
	ValidateDocument(userID string, repo *repository.Repository, raw json.RawMessage) error
	UsesWorkflow(input map[string]any) bool
	UsesTextReplay(input map[string]any) bool
	StorageLock() sync.Locker
	FormatTask(model.Task) *model.Task
}

type hostAdapter struct{ Host }

func (h hostAdapter) ValidateRun(userID string, repo *repository.Repository, creating bool, delta int64) error {
	_, bytes, err := repo.CreationStorageUsage(userID)
	if err != nil {
		return err
	}
	return h.ValidateCanvas(userID, repo, creating, bytes+delta)
}

func NewFromHost(repo *repository.Repository, host Host) *Service {
	a := hostAdapter{host}
	return New(repo, Dependencies{
		Tasks: a, Secrets: a, Quota: a, Media: a, Kinds: a,
		StorageLock: host.StorageLock(), FormatTask: host.FormatTask, NewID: kernel.NewID,
	})
}

func (d Dependencies) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d Dependencies) newID() string {
	if d.NewID != nil {
		return d.NewID()
	}
	return kernel.NewID()
}

type HostConfig struct {
	StorageLock      sync.Locker
	PrepareTask      func(userID string, req localtask.CreateRequest) (*model.Task, error)
	RuntimePolicy    func(repo *repository.Repository) (platform.RuntimePolicySetting, error)
	ProtectSecrets   func(input any) error
	ValidateDocument func(userID string, repo *repository.Repository, raw json.RawMessage) error
	UsesWorkflow     func(input map[string]any) bool
	UsesTextReplay   func(input map[string]any) bool
	FormatTask       func(model.Task) *model.Task
}

type configHost struct{ cfg HostConfig }

func NewFromConfig(repo *repository.Repository, cfg HostConfig) *Service {
	return NewFromHost(repo, configHost{cfg: cfg})
}
func (h configHost) Prepare(u string, req TaskRequest) (*PreparedTask, error) {
	return PreparedFromTask(h.cfg.PrepareTask(u, req.ToLocalCreateRequest()))
}
func (h configHost) Admit(_ string, repo *repository.Repository, task *model.Task) (*model.Task, error) {
	p, err := h.cfg.RuntimePolicy(repo)
	if err != nil {
		return nil, err
	}
	return task, resource.CreateTaskWithStorageQuota(repo, task, p)
}
func (h configHost) Protect(input map[string]any) error { return h.cfg.ProtectSecrets(input) }
func (h configHost) ValidateCanvas(u string, repo *repository.Repository, creating bool, delta int64) error {
	return ValidateCanvasWithPolicy(u, repo, creating, delta, h.cfg.RuntimePolicy)
}

func ValidateCanvasWithPolicy(u string, repo *repository.Repository, creating bool, delta int64, loadPolicy func(*repository.Repository) (platform.RuntimePolicySetting, error)) error {
	p, err := loadPolicy(repo)
	if err != nil {
		return err
	}
	usage, err := repo.UserStorageUsage(u)
	if err != nil {
		return err
	}
	return resource.ValidateStructuredStorageQuota(usage, "canvas", creating, delta, p.Resource)
}
func (h configHost) ValidateDocument(u string, repo *repository.Repository, raw json.RawMessage) error {
	if repo == nil {
		return kernel.NewAppError(kernel.CodeInternal, "画布媒体校验缺少事务仓储")
	}
	return h.cfg.ValidateDocument(u, repo, raw)
}
func (h configHost) UsesWorkflow(input map[string]any) bool   { return h.cfg.UsesWorkflow(input) }
func (h configHost) UsesTextReplay(input map[string]any) bool { return h.cfg.UsesTextReplay(input) }
func (h configHost) StorageLock() sync.Locker                 { return h.cfg.StorageLock }
func (h configHost) FormatTask(t model.Task) *model.Task      { return h.cfg.FormatTask(t) }
