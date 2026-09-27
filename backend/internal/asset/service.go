package asset

import (
	"errors"
	"fmt"
	"mime/multipart"
	"os"
	"path/filepath"

	"qisitv/backend/internal/model"
)

type Backend interface {
	Resources(string, int) ([]model.Resource, error)
	UploadLocalResource(string, *multipart.FileHeader, string, int, int, int64, ...string) (*model.Resource, error)
}

type Service struct {
	backend Backend
	root    string
}

func New(backend Backend, dataDir string) *Service {
	return &Service{backend: backend, root: filepath.Join(dataDir, "resources")}
}

func (s *Service) Resources(userID string, limit int) ([]model.Resource, error) {
	resources, err := s.backend.Resources(userID, limit)
	if err != nil {
		return nil, err
	}
	for index := range resources {
		if err := s.validateLocalResource(&resources[index]); err != nil {
			return nil, err
		}
	}
	return resources, nil
}

func (s *Service) UploadLocalResource(userID string, header *multipart.FileHeader, kind string, width, height int, durationMs int64, identity ...string) (*model.Resource, error) {
	resource, err := s.backend.UploadLocalResource(userID, header, kind, width, height, durationMs, identity...)
	if err != nil {
		return nil, err
	}
	if err := s.validateLocalResource(resource); err != nil {
		return nil, err
	}
	return resource, nil
}

func (s *Service) validateLocalResource(resource *model.Resource) error {
	if resource == nil {
		return errors.New("本地资源为空")
	}
	if resource.Provider != "local" {
		return fmt.Errorf("资源 %s 不属于本地存储", resource.ID)
	}
	clean, err := localizedObjectKey(resource.ObjectKey)
	if err != nil {
		return fmt.Errorf("资源 %s 的本地路径无效", resource.ID)
	}
	if resource.Status == model.ResourceStatusReady {
		if info, err := os.Stat(filepath.Join(s.root, clean)); err != nil || info.IsDir() {
			return fmt.Errorf("资源 %s 的本地文件缺失", resource.ID)
		}
	}
	return nil
}
