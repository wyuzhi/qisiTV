package task

import (
	"context"

	"qisitv/backend/internal/model"
)

type Backend interface {
	TasksWithOptions(string, ListOptions) ([]Summary, error)
	CreateLocalTask(string, CreateRequest) (*model.Task, error)
	StartWorker()
	StopWorker(context.Context) error
	Close() error
}

// Service is the local task admission boundary.
type Service struct{ backend Backend }

func New(backend Backend) *Service { return &Service{backend: backend} }

func (s *Service) TasksWithOptions(userID string, options ListOptions) ([]Summary, error) {
	return s.backend.TasksWithOptions(userID, options)
}

func (s *Service) CreateTask(userID string, request CreateRequest) (*model.Task, error) {
	return s.backend.CreateLocalTask(userID, request)
}

func (s *Service) StartWorker() { s.backend.StartWorker() }

func (s *Service) StopWorker(ctx context.Context) error { return s.backend.StopWorker(ctx) }

func (s *Service) Close() error { return s.backend.Close() }
