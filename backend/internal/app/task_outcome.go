package app

import (
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

func (s *Service) taskOutcomeFacts(tasks []model.Task) map[string]localtask.OutcomeFacts {
	return localtask.OutcomeFactsForTasks(s.repo, tasks, taskStageRequestNotSent)
}
