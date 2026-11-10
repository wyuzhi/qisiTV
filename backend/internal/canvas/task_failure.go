package canvas

import (
	"errors"
	"reflect"
	"strings"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

// TaskFailure is a failed generation task as its node shows it. Outcome is the
// task's backend outcome, kept on the node so the UI decides retry from it.
type TaskFailure struct {
	TaskID     string
	TaskStatus string
	Message    string
	Outcome    model.TaskOutcome
}

// generationAttemptFields describe one generation attempt on a node. A new
// attempt starts without them so an earlier failure cannot describe it.
var generationAttemptFields = []string{
	"taskId", "taskType", "taskOutcome", "taskOutcomeSource", "taskOutputIndex", "generationOutputNodeIds",
	"taskClientOperationId", "generationSubmissionState", "retryOf", "attemptGroupId",
	"taskStatus", "taskProgress", "taskStage", "taskProvider", "taskStartedAt", "taskCompletedAt", "taskDurationMs",
	"taskErrorCode", "taskFailureDiagnostics", "taskProviderRequestId", "taskOfficialStatus", "taskReceiptRecorded",
	"taskCreatedAt", "taskUpdatedAt", "processingLabel", "generationFailure", "generationPreflightError",
	"error", "errorDetails", "generationErrorCode", "generationErrorSummary", "generationProviderCode",
	"failedPromptFingerprint", "failedInputFingerprint", "resourceReloadAvailable",
}

// ClearGenerationAttemptMetadata drops the previous attempt's task binding and
// failure state. Prompt, parameters and media stay on the node.
func ClearGenerationAttemptMetadata(metadata map[string]any) {
	for _, key := range generationAttemptFields {
		delete(metadata, key)
	}
}

// ApplyTaskFailureMetadata records a failed task on the metadata of a node that
// references it and reports whether any field changed. Status and outcome are
// the task's; an explanation the client already wrote for this failure is kept
// and only a missing one is filled from the task error.
func ApplyTaskFailureMetadata(metadata map[string]any, failure TaskFailure) bool {
	outcome := map[string]any{"phase": failure.Outcome.Phase, "regenerate": failure.Outcome.Regenerate, "reason": failure.Outcome.Reason}
	if failure.Outcome.ReconcileDeadline != "" {
		outcome["reconcileDeadline"] = failure.Outcome.ReconcileDeadline
	}
	fields := map[string]any{"taskId": failure.TaskID, "taskStatus": failure.TaskStatus, "status": "error", "taskOutcome": outcome}
	if nodeString(metadata, "errorDetails") == "" {
		fields["error"], fields["errorDetails"] = failure.Message, failure.Message
	}
	changed := false
	for key, value := range fields {
		if !reflect.DeepEqual(metadata[key], value) {
			metadata[key] = value
			changed = true
		}
	}
	return changed
}

// RecordTaskFailures writes failed tasks onto the nodes of one canvas that still
// reference them, the failure counterpart of BindTaskOutputToExistingNode.
// outcomes[i] is the backend outcome of tasks[i]. A failed outcome marks the
// node failed; any other outcome only updates a node already showing this task
// failed, so a failure marked while billing was checked follows the task once
// its result becomes retrievable, and a waiting node keeps waiting. It returns
// the canvas revision the nodes were checked at; a deleted canvas is not an
// error. Nodes are left alone when they hold media, reference another task, or
// already carry a newer submission (a retry keeps the old taskId until its own
// task is accepted).
func (s *Service) RecordTaskFailures(userID, canvasID string, tasks []model.Task, outcomes []model.TaskOutcome) (int64, error) {
	byTask := make(map[string]TaskFailure, len(tasks))
	operationKeys := make(map[string]string, len(tasks))
	for i, task := range tasks {
		if id := strings.TrimSpace(task.ID); id != "" && i < len(outcomes) {
			byTask[id] = TaskFailure{TaskID: id, TaskStatus: string(task.Status), Message: task.Error, Outcome: outcomes[i]}
			if task.ClientOperationID != nil {
				operationKeys[id] = strings.TrimSpace(*task.ClientOperationID)
			}
		}
	}
	var last error
	for attempt := 0; attempt < bindRevisionAttempts; attempt++ {
		doc, err := s.loadCanvasDoc(userID, canvasID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, nil
		}
		if err != nil {
			return 0, err
		}
		changed := false
		for _, raw := range canvasDocNodes(doc) {
			node, _ := raw.(map[string]any)
			if node == nil || NodeHasMedia(node) {
				continue
			}
			metadata := nodeMetadata(node)
			taskID := nodeString(metadata, "taskId")
			failure, ok := byTask[taskID]
			if key := nodeString(metadata, "taskClientOperationId"); !ok || nodeString(metadata, "generationSubmissionState") == "submitting" || (key != "" && key != operationKeys[taskID]) {
				continue
			}
			if failure.Outcome.Phase != "failed" && nodeString(metadata, "status") != "error" {
				continue
			}
			if ApplyTaskFailureMetadata(metadata, failure) {
				node["metadata"] = metadata
				changed = true
			}
		}
		expected := canvasRevisionValue(doc)
		if !changed {
			return expected, nil
		}
		if expected <= 0 {
			expected = 1
		}
		summary, err := s.saveCanvasDocWithRevision(userID, canvasID, doc, expected)
		if err == nil {
			return summary.Revision, nil
		}
		if !isCanvasRevisionConflict(err) {
			return 0, err
		}
		last = err
	}
	return 0, last
}
