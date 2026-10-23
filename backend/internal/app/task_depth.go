package app

import (
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

type DepthCaptureCreateRequest = localtask.DepthCaptureCreateRequest

func (s *Service) CreateDepthCaptureTask(userID string, req DepthCaptureCreateRequest) (*model.Task, error) {
	return s.taskDomain().CreateDepthCaptureTask(userID, req)
}
