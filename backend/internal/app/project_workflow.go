package app

import (
	"strings"

	"qisitv/backend/internal/model"
	localproject "qisitv/backend/internal/project"
)

type UpdateWorkflowStepRequest = localproject.UpdateWorkflowStepRequest
type RegisterTaskOutputRequest = localproject.RegisterTaskOutputRequest

func (s *Service) EnsureBuiltinProjectWorkflowTemplate() error {
	return s.projectDomain().EnsureBuiltinTemplate()
}

func (s *Service) RegisterTaskOutputFromTask(task model.Task) error {
	if strings.TrimSpace(task.ProjectID) == "" || task.Status != model.TaskStatusSucceeded {
		return nil
	}
	if strings.TrimSpace(task.InputJSON) == "" {
		return nil
	}
	decrypted, err := s.decryptTaskInputJSON(task.InputJSON)
	if err != nil {
		return err
	}
	return s.projectDomain().RegisterTaskOutputFromTask(task, decrypted)
}

func taskOutputResource(raw string, taskType string) (string, string) {
	return localproject.CanonicalTaskOutputResource(raw, taskType)
}

func workflowGeneratedEntityID(namespace string, taskID string) string {
	return localproject.GeneratedEntityID(namespace, taskID)
}
