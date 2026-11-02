package appearance

import (
	"os"
	"path/filepath"
	"sync"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
)

type SettingsStore interface {
	SystemSetting(key string) (*model.SystemSetting, error)
	SaveSystemSetting(*model.SystemSetting) error
	DeleteSystemSetting(key string) error
}

type Resources interface {
	Resource(id string) (*model.Resource, error)
}

type LocalFiles interface {
	Exists(objectKey string) bool
}

type AdminGate interface {
	RequireAdmin(user *model.User) error
	AppendAudit(actor *model.User, action, targetType, targetID, summary string, metadata any) error
}

type StorageLock interface {
	WithLock(func() error) error
}

type Dependencies struct {
	Settings  SettingsStore
	Resources Resources
	Files     LocalFiles
	Admin     AdminGate
	Lock      StorageLock
}

type HostConfig struct {
	Settings     SettingsStore
	Resources    Resources
	DataDir      string
	RequireAdmin func(*model.User) error
	AppendAudit  func(*model.User, string, string, string, string, any) error
	Mutex        *sync.Mutex
}

func NewFromHost(cfg HostConfig) *Service {
	return New(Dependencies{
		Settings:  cfg.Settings,
		Resources: cfg.Resources,
		Files:     dataDirFiles{dataDir: cfg.DataDir},
		Admin:     funcAdminGate{requireAdmin: cfg.RequireAdmin, appendAudit: cfg.AppendAudit},
		Lock:      mutexLock{mu: cfg.Mutex},
	})
}

type funcAdminGate struct {
	requireAdmin func(*model.User) error
	appendAudit  func(*model.User, string, string, string, string, any) error
}

func (g funcAdminGate) RequireAdmin(user *model.User) error {
	if g.requireAdmin == nil {
		return kernel.Unauthorized("请先登录")
	}
	return g.requireAdmin(user)
}

func (g funcAdminGate) AppendAudit(actor *model.User, action, targetType, targetID, summary string, metadata any) error {
	if g.appendAudit == nil {
		return kernel.Unauthorized("请先登录")
	}
	return g.appendAudit(actor, action, targetType, targetID, summary, metadata)
}

type dataDirFiles struct {
	dataDir string
}

func (f dataDirFiles) Exists(objectKey string) bool {
	if f.dataDir == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(f.dataDir, "resources", filepath.FromSlash(objectKey)))
	return err == nil && !info.IsDir()
}

type mutexLock struct {
	mu *sync.Mutex
}

func (l mutexLock) WithLock(fn func() error) error {
	if fn == nil {
		return nil
	}
	if l.mu == nil {
		return fn()
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return fn()
}
