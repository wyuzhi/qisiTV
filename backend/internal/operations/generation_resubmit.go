package operations

import (
	"encoding/json"
	"errors"

	"gorm.io/gorm"
	"qisitv/backend/internal/assistantturns"
	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
	localtask "qisitv/backend/internal/task"
)

// ReleaseFailedGenerationNodes prepares the target nodes of an external
// submission. A node linked to an earlier task takes a new paid task only when
// that task's outcome is a failure the user may regenerate; its old binding is
// then cleared so the new task owns the node. Any other link (running,
// retrievable, settling or delivered, or a submission without a task record)
// keeps the node: a changed operation key is not evidence that work which may
// still arrive can be bought again.
func ReleaseFailedGenerationNodes(domain Domain, tx *gorm.DB, userID, canvasID string, targets []GenerationTarget) error {
	raw, err := domain.UserCanvasProject(userID, canvasID)
	if err != nil {
		return err
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return err
	}
	wanted := map[string]bool{}
	for _, target := range targets {
		wanted[target.NodeID] = true
	}
	repo := repository.New(tx)
	released := false
	for _, value := range canvasNodes(doc) {
		node, _ := value.(map[string]any)
		meta := dependencyMetadata(node)
		taskID, operationKey := dependencyString(meta, "taskId"), dependencyString(meta, "taskClientOperationId")
		if !wanted[dependencyString(node, "id")] || (taskID == "" && operationKey == "" && dependencyString(meta, "generationSubmissionState") == "" && meta["status"] != "loading") {
			continue
		}
		// The operation key names the node's latest submission; a retry keeps the
		// old taskId until its own task is accepted.
		var task *model.Task
		if operationKey != "" {
			task, err = repo.TaskByClientOperation(userID, operationKey)
		} else if taskID != "" {
			task, err = repo.TaskForUser(userID, taskID)
		}
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		details := map[string]any{"nodeId": node["id"], "taskId": meta["taskId"]}
		if task != nil && dependencyString(meta, "generationSubmissionState") != "submitting" {
			projection, _, _, err := assistantturns.ProjectTaskInTx(tx, userID, *task)
			if err != nil {
				return err
			}
			if localtask.RegenerableFailure(projection.Outcome) {
				canvas.ClearGenerationAttemptMetadata(meta)
				meta["status"] = "idle"
				released = true
				continue
			}
			details["taskOutcome"] = projection.Outcome
		}
		return PreconditionFailed("generation_task_exists", "节点已关联生成任务，请先查询原任务；需要另做一份时请新建节点", details)
	}
	if !released {
		return nil
	}
	encoded, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	_, _, err = domain.CommitUserCanvasDocument(userID, canvasID, canvasRevision(doc), encoded)
	return err
}
