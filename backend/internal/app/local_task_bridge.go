package app

import (
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

// CreateLocalTask adapts the stable local task command to the richer internal
// admission request. Private admission state remains unavailable to transports.
func (s *Service) CreateLocalTask(userID string, request localtask.CreateRequest) (*model.Task, error) {
	return s.CreateTask(userID, CreateTaskRequest{
		ProjectID:      request.ProjectID,
		Type:           request.Type,
		Operation:      request.Operation,
		Prompt:         request.Prompt,
		Provider:       request.Provider,
		Model:          request.Model,
		LogicalModelID: request.LogicalModelID,
		Input:          request.Input,
		TraceID:        request.TraceID,
		RequestID:      request.RequestID,
	})
}
