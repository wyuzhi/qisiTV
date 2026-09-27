package project

import (
	"fmt"

	"qisitv/backend/internal/app"
)

type Backend interface {
	ListProjects(string) ([]app.ProjectSummary, error)
}

type Service struct{ backend Backend }

func New(backend Backend) *Service { return &Service{backend: backend} }

func (s *Service) ListProjects(userID string) ([]app.ProjectSummary, error) {
	projects, err := s.backend.ListProjects(userID)
	if err != nil {
		return nil, err
	}
	for _, item := range projects {
		if item.Project.ID == "" || item.Project.Revision < 1 {
			return nil, fmt.Errorf("项目缺少有效的本地修订版本")
		}
	}
	return projects, nil
}
