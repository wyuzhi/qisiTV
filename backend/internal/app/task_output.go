package app

import (
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

type TaskSummary = localtask.Summary
type TaskClientContext = localtask.ClientContext

func taskSummariesForOutput(tasks []model.Task) []TaskSummary {
	return localtask.SummariesForOutput(tasks)
}

func taskSummaryForOutput(task model.Task) TaskSummary {
	return localtask.SummaryForOutput(task)
}

func taskClientContext(raw string) *TaskClientContext {
	return localtask.ClientContextFromInput(raw)
}

func taskMediaPreview(raw string, taskType string) (string, string) {
	return localtask.MediaPreview(raw, taskType)
}

func taskMediaPreviewWithPoster(raw string, taskType string) (string, string, string) {
	return localtask.MediaPreviewWithPoster(raw, taskType)
}

func truncateRunes(value string, limit int) string {
	return kernel.TruncateRunes(value, limit)
}

func taskForOutput(task model.Task) *model.Task {
	return localtask.TaskForOutput(task)
}

func safePersistedFailureMessage(message, stage string) string {
	return localtask.SafePersistedFailureMessage(message, stage)
}

func publicTaskInputJSON(raw string) string {
	return localtask.PublicTaskInputJSON(raw)
}

func correctPersistedVODParameterFailure(task model.Task) model.Task {
	return localtask.CorrectPersistedVODParameterFailure(task)
}
