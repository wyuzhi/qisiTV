package appearance

import (
	"os"
	"path/filepath"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

type SettingsStore interface {
	SystemSetting(key string) (*model.SystemSetting, error)
}

type Resources interface {
	Resource(id string) (*model.Resource, error)
}

type LocalFiles interface {
	Exists(objectKey string) bool
}

type AdminGate interface {
	RequireAdmin(user *model.User) error
}

type Dependencies struct {
	Settings  SettingsStore
	Resources Resources
	Files     LocalFiles
	Admin     AdminGate
}

type HostConfig struct {
	Settings     SettingsStore
	Resources    Resources
	DataDir      string
	RequireAdmin func(*model.User) error
}

func NewFromHost(cfg HostConfig) *Service {
	return New(Dependencies{
		Settings:  cfg.Settings,
		Resources: cfg.Resources,
		Files:     dataDirFiles{dataDir: cfg.DataDir},
		Admin:     funcAdminGate{requireAdmin: cfg.RequireAdmin},
	})
}

type funcAdminGate struct {
	requireAdmin func(*model.User) error
}

func (g funcAdminGate) RequireAdmin(user *model.User) error {
	if g.requireAdmin == nil {
		return kernel.Unauthorized("请先登录")
	}
	return g.requireAdmin(user)
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
