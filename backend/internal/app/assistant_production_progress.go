package app

import (
	"encoding/json"
	"reflect"
	"strings"

	"gorm.io/gorm"
	"qisitv/backend/internal/assistantturns"
	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/operations"
)

// The existing continuation receipt advances the exact confirmed inputs. Model
// admission waits until their files are saved; this does not create a new queue
// or retry failed/unknown purchases. Called under the claim's scope transaction.
func (s *Service) prepareAssistantProduction(tx *gorm.DB, receipt *model.AssistantContinuation) (bool, error) {
	var source model.AssistantTurn
	if err := tx.First(&source, "turn_id = ? AND user_id = ?", receipt.SourceTurnID, receipt.UserID).Error; err != nil {
		return false, err
	}
	if source.GenerationAuthorizationJSON == "" {
		return true, nil
	}
	var plan operations.GenerationAuthorization
	if err := json.Unmarshal([]byte(source.GenerationAuthorizationJSON), &plan); err != nil {
		return false, err
	}
	if plan.SourceTurnID == "" {
		return true, nil
	}
	if source.Undone || source.ContinuationInvalidated || plan.SourceTurnID != source.TurnID || plan.ProposalID != receipt.ProposalID {
		return false, operations.PreconditionFailed("production_revoked", "本次制作授权已停止", nil)
	}
	domain := s.BindDomain(tx).(*operationSession)
	raw, err := domain.UserCanvasProject(receipt.UserID, receipt.CanvasID)
	if err != nil {
		return false, err
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		return false, err
	}
	nodes := map[string]map[string]any{}
	for _, value := range doc["nodes"].([]any) {
		node := value.(map[string]any)
		nodes[node["id"].(string)] = node
	}
	ids := make([]string, 0, len(plan.Targets))
	for _, target := range plan.Targets {
		ids = append(ids, target.NodeID)
	}
	current, err := operations.GenerationTargets(domain, doc, ids)
	if err != nil {
		return false, err
	}
	if !reflect.DeepEqual(current, plan.Targets) {
		return false, &assistantturns.Error{Reason: "continuation_intent_changed", Message: "制作方案已修改，自动制作已停止，请确认新的方案"}
	}
	saved, planned := map[string]bool{}, map[string]bool{}
	pending := []operations.GenerationTarget{}
	allSaved := true
	failed, running, targetChanged, changed := false, false, false, false
	for _, target := range plan.Targets {
		planned[target.NodeID] = true
		key := productionTaskKey(plan, target.NodeID)
		task, err := domain.repo.TaskByClientOperation(receipt.UserID, key)
		if err != nil {
			return false, err
		}
		node := nodes[target.NodeID]
		meta, _ := node["metadata"].(map[string]any)
		nodeTaskID, _ := meta["taskId"].(string)
		nodeTaskID = strings.TrimSpace(nodeTaskID)
		if task == nil {
			if node == nil || nodeTaskID != "" || meta["status"] == "loading" || meta["taskStatus"] == "queued" || meta["taskStatus"] == "running" || meta["generationSubmissionState"] == "submitting" {
				targetChanged = true
				failed = true
				allSaved = false
				continue
			}
			pending = append(pending, target)
			allSaved = false
			continue
		}
		if err := operations.ValidateProductionTask(task, receipt.CanvasID, target); err != nil {
			return false, err
		}
		inspection, err := assistantturns.InspectTaskTargetsInTx(tx, receipt.UserID, *task, target.Kind, target.NodeID, []string{target.NodeID}, func(id string) (map[string]any, bool) {
			n, ok := nodes[id]
			if !ok || n == nil {
				return nil, false
			}
			m, _ := n["metadata"].(map[string]any)
			return m, true
		})
		if err != nil {
			return false, err
		}
		switch inspection.State {
		case assistantturns.TargetBindingTargetChanged:
			targetChanged = true
			failed = true
			allSaved = false
		case assistantturns.TargetBindingWaiting:
			// A successful supplier task or retrievable task pending auto-recovery
			// stays in flight until its canonical file and target binding are saved,
			// even when a sibling has already failed.
			running = true
			allSaved = false
		case assistantturns.TargetBindingFailed:
			failed = true
			allSaved = false
			if task.Status == model.TaskStatusFailed || task.Status == model.TaskStatusCancelled {
				changed = syncProductionNodeFailure(meta, task, key, inspection.Projection.Outcome) || changed
			}
		case assistantturns.TargetBindingReady:
			saved[target.NodeID] = true
		}
	}
	if changed {
		encoded, err := json.Marshal(doc)
		if err != nil {
			return false, err
		}
		if _, _, err := domain.CommitUserCanvasDocument(receipt.UserID, receipt.CanvasID, assistantDocRevision(doc), encoded); err != nil {
			return false, err
		}
	}
	if targetChanged {
		if running {
			return false, nil
		}
		return false, &assistantturns.Error{Reason: "continuation_target_changed", Message: "暂不能自动继续，请查看本次生成或手动继续"}
	}
	if failed {
		// Keep the single wake until every already-admitted sibling settles.
		// Do not admit pending dependants or repurchase a failed task.
		return !running, nil
	}
	if allSaved {
		return true, nil
	}
	ready := []operations.GenerationTarget{}
	for _, target := range pending {
		dependenciesSaved := true
		for _, id := range target.ReferenceNodeIDs {
			if planned[id] && !saved[id] {
				dependenciesSaved = false
			}
		}
		if dependenciesSaved {
			ready = append(ready, target)
		}
	}
	if len(ready) == 0 {
		return false, nil
	}
	_, err = domain.admitProductionTargets(receipt.UserID, receipt.CanvasID, plan, ready)
	return false, err
}

// Inspection only reports a failure for the node that still references the task.
func syncProductionNodeFailure(meta map[string]any, task *model.Task, key string, outcome model.TaskOutcome) bool {
	receiptChanged := meta["taskClientOperationId"] != key || meta["generationSubmissionState"] != "accepted"
	meta["taskClientOperationId"], meta["generationSubmissionState"] = key, "accepted"
	return canvas.ApplyTaskFailureMetadata(meta, canvas.TaskFailure{TaskID: task.ID, TaskStatus: string(task.Status), Message: task.Error, Outcome: outcome}) || receiptChanged
}
