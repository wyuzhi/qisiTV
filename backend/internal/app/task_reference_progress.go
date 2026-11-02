package app

import (
	"qisitv/backend/internal/generation"
	localtask "qisitv/backend/internal/task"
)

type appReferenceProgressPort = localtask.ReferenceProgressPort

func (s *Service) newReferenceProgressPort(taskID string) *appReferenceProgressPort {
	return localtask.NewReferenceProgressPort(&s.referenceProgress, taskID)
}

func (s *Service) referenceProgressForTask(taskID string) *generation.ReferenceProgress {
	return localtask.ReferenceProgressForTask(&s.referenceProgress, taskID)
}
