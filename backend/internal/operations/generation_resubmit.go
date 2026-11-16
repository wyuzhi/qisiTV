package operations

import (
	"encoding/json"
	"errors"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
)

// generationReleaseRule 决定哪些旧任务的结果允许在原节点被新的付费任务替换。
type generationReleaseRule int

const (
	// releaseFailedOnly 是 submit 的规则：只替换用户可以重做的失败结果。
	releaseFailedOnly generationReleaseRule = iota
	// releaseEnded 是 regenerate 的规则：替换已经结束的结果，成功或失败都算。
	releaseEnded
)

// ReleaseFailedGenerationNodes prepares the target nodes of an external
// submission. A node linked to an earlier task takes a new paid task only when
// that task's outcome is a failure the user may regenerate; its old binding is
// then cleared so the new task owns the node. Any other link (running,
// retrievable, settling or delivered, or a submission without a task record)
// keeps the node: a changed operation key is not evidence that work which may
// still arrive can be bought again.
func ReleaseFailedGenerationNodes(domain Domain, tx *gorm.DB, userID, canvasID string, targets []GenerationTarget) error {
	return releaseGenerationNodes(domain, tx, userID, canvasID, targets, releaseFailedOnly)
}

// ReleaseEndedGenerationNodes is the regenerate counterpart. A node whose task
// has ended, whether it succeeded or failed, is released so the caller can
// redo it in place; the earlier result stays in the asset library. Nodes still
// queued, running, downloading or saving keep their task, and a submission
// that has not been recorded cannot be released.
func ReleaseEndedGenerationNodes(domain Domain, tx *gorm.DB, userID, canvasID string, targets []GenerationTarget) error {
	return releaseGenerationNodes(domain, tx, userID, canvasID, targets, releaseEnded)
}

func releaseGenerationNodes(domain Domain, tx *gorm.DB, userID, canvasID string, targets []GenerationTarget, rule generationReleaseRule) error {
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
		if !wanted[dependencyString(node, "id")] {
			continue
		}
		taskID, operationKey := dependencyString(meta, "taskId"), dependencyString(meta, "taskClientOperationId")
		if taskID == "" && operationKey == "" && dependencyString(meta, "generationSubmissionState") == "" && meta["status"] != "loading" {
			// 通过素材绑定或导入得到的节点没有任务回执，但节点上的旧媒体同样要清掉：
			// 新任务失败时 RecordTaskFailures 会跳过仍有媒体的节点，节点会停在 loading。
			if rule == releaseEnded {
				changed := canvas.ClearInPlaceGenerationOutput(node)
				if meta["status"] != "idle" {
					meta["status"] = "idle"
					changed = true
				}
				released = released || changed
			}
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
			if generationResultReplaceable(projection.Outcome, rule) {
				if rule == releaseEnded {
					canvas.ClearInPlaceGenerationOutput(node)
				}
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

// generationResultReplaceable 是 submit 与 regenerate 唯一的释放规则差异。
// running、retrievable（结果仍可能到达）和正在下载保存（fetching）都不算结束。
// 失败但 regenerate=blocked（例如仍在核对扣费）也不能释放，否则旧任务稍后结算
// 会与新任务重复计费；allowed/confirm 才表示这次失败已经可以重做。
func generationResultReplaceable(outcome model.TaskOutcome, rule generationReleaseRule) bool {
	if rule == releaseEnded {
		return outcome.Phase == "ready" || (outcome.Phase == "failed" && outcome.Regenerate != "blocked")
	}
	return localtask.RegenerableFailure(outcome)
}
