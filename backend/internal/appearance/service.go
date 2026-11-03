package appearance

import (
	"errors"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

type Service struct {
	settings  SettingsStore
	resources Resources
	files     LocalFiles
	admin     AdminGate
}

func New(deps Dependencies) *Service {
	return &Service{
		settings:  deps.Settings,
		resources: deps.Resources,
		files:     deps.Files,
		admin:     deps.Admin,
	}
}

func (s *Service) Public() (*PublicSetting, error) {
	setting, value, err := s.read()
	if err != nil {
		return nil, err
	}
	value = s.resolveAvailable(value)
	return publicSetting(setting, value), nil
}

func (s *Service) Identity() (string, string) {
	_, value, err := s.read()
	if err != nil || strings.TrimSpace(value.BrandName) == "" {
		return DefaultBrandName, DefaultBrandSlug
	}
	return value.BrandName, value.BrandSlug
}

func (s *Service) ConfiguredResource(slot string) (*model.Resource, error) {
	_, value, err := s.read()
	if err != nil {
		return nil, err
	}
	id := resourceID(value, slot)
	if id == "" {
		return nil, kernel.NotFound("未配置该外观资源")
	}
	if s.resources == nil {
		return nil, kernel.NotFound("外观资源不存在")
	}
	resource, err := s.resources.Resource(id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, kernel.NotFound("外观资源不存在")
		}
		return nil, err
	}
	if err := validateResourceType(slot, resource); err != nil {
		return nil, err
	}
	return resource, nil
}

func (s *Service) requireAdmin(actor *model.User) error {
	if s == nil || s.admin == nil {
		return kernel.Unauthorized("请先登录")
	}
	return s.admin.RequireAdmin(actor)
}
