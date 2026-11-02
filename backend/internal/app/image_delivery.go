package app

import (
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

func (s *Service) completionInputJSON(task model.Task, resultJSON []byte) (string, error) {
	return localtask.CompletionInputJSON(task, resultJSON, s.decryptTaskInputJSON, s.encryptSettingSecret)
}
