package app

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	"gorm.io/gorm"
	"qisitv/backend/internal/assistantturns"
	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/operations"
	localtask "qisitv/backend/internal/task"
)

type AssistantProductionConfirmation struct {
	CanvasID     string                        `json:"canvasId"`
	ProposalID   string                        `json:"proposalId"`
	Kind         string                        `json:"kind"`
	NodeIDs      []string                      `json:"nodeIds"`
	Targets      []operations.GenerationTarget `json:"targets"`
	ContinuePlan bool                          `json:"continuePlan,omitempty"`
}

func (s *Service) ConfirmAssistantProduction(userID, turnID string, input AssistantProductionConfirmation) (any, error) {
	return s.confirmAssistantProductionWithApprover(userID, turnID, input, "ui")
}

func (s *Service) confirmAssistantProductionWithApprover(userID, turnID string, input AssistantProductionConfirmation, approvedBy string) (any, error) {
	if err := s.CheckAssistantProposalRunnable(userID, input.CanvasID, turnID); err != nil {
		return nil, err
	}
	var result any
	err := s.repo.DB().Transaction(func(tx *gorm.DB) error {
		domain := s.BindDomain(tx).(*operationSession)
		raw, err := domain.UserCanvasProject(userID, input.CanvasID)
		if err != nil {
			return err
		}
		var doc map[string]any
		if err = json.Unmarshal(raw, &doc); err != nil {
			return err
		}
		var source model.AssistantTurn
		if err = tx.First(&source, "turn_id = ? AND user_id = ? AND canvas_id = ?", turnID, userID, input.CanvasID).Error; err != nil {
			return err
		}
		expectedTargets := input.Targets
		if len(expectedTargets) == 0 && source.GenerationAuthorizationJSON != "" {
			var existing operations.GenerationAuthorization
			if json.Unmarshal([]byte(source.GenerationAuthorizationJSON), &existing) == nil {
				if existing.ProposalID != "" && existing.ProposalID != input.ProposalID {
					return operations.Conflict("production_changed", "这一轮已确认了不同的制作方案", nil)
				}
				expectedTargets = existing.Targets
			}
		}
		ids := input.NodeIDs
		if len(expectedTargets) > 0 {
			ids = make([]string, 0, len(expectedTargets))
			for _, target := range expectedTargets {
				ids = append(ids, target.NodeID)
			}
		}
		current, err := operations.GenerationTargets(domain, doc, ids)
		if err != nil {
			return err
		}
		if len(expectedTargets) > 0 && !reflect.DeepEqual(current, expectedTargets) {
			return operations.Conflict("production_changed", "制作方案已变化，请重新确认", nil)
		}
		isMultiStage := len(input.Targets) > 0 || input.ContinuePlan || len(current) > len(input.NodeIDs)
		if source.Undone || source.ContinuationInvalidated || (isMultiStage && source.DurableSessionID == "") {
			return operations.PreconditionFailed("production_revoked", "这次制作授权已停止，请重新确认", nil)
		}
		plan := operations.GenerationAuthorization{SourceTurnID: turnID, ProposalID: input.ProposalID, Targets: current}
		encoded, _ := json.Marshal(plan)
		if source.GenerationAuthorizationJSON != "" && source.GenerationAuthorizationJSON != string(encoded) {
			var existing operations.GenerationAuthorization
			if json.Unmarshal([]byte(source.GenerationAuthorizationJSON), &existing) != nil || existing.SourceTurnID != "" {
				return operations.Conflict("production_changed", "这一轮已确认了不同的制作方案", nil)
			}
		}
		if err = tx.Model(&source).Update("generation_authorization_json", string(encoded)).Error; err != nil {
			return err
		}
		batch := []operations.GenerationTarget{}
		wanted := map[string]bool{}
		for _, id := range input.NodeIDs {
			wanted[id] = true
		}
		for _, target := range current {
			if wanted[target.NodeID] {
				if target.Kind != input.Kind {
					return operations.InvalidArg("invalid_kind", "首批素材类型不一致")
				}
				batch = append(batch, target)
			}
		}
		if len(batch) == 0 || len(batch) != len(wanted) {
			return operations.InvalidArg("invalid_batch", "首批素材不在制作计划内")
		}
		result, err = domain.admitProductionTargets(userID, input.CanvasID, plan, batch)
		if err != nil {
			return err
		}
		var continuationID string
		if isMultiStage {
			turns := assistantturns.New(assistantturns.NewStore(domain.repo), assistantCanvasFactory{s}, s.assistantTurnDir())
			continuation, err := turns.ArmContinuation(userID, assistantturns.ContinuationInput{CanvasID: input.CanvasID, SessionID: source.DurableSessionID, SourceTurnID: turnID, ProposalID: input.ProposalID, Kind: input.Kind, NodeIDs: input.NodeIDs})
			if err != nil {
				return err
			}
			for _, target := range batch {
				if err = turns.RegisterContinuationManifest(userID, continuation.ID, assistantturns.ContinuationManifest{SourceNodeID: target.NodeID, Submissions: []assistantturns.ContinuationSubmission{{OperationID: productionTaskKey(plan, target.NodeID), OutputNodeIDs: []string{target.NodeID}}}}); err != nil {
					return err
				}
			}
			continuationID = continuation.ID
			result.(map[string]any)["continuationId"] = continuation.ID
		}
		return operations.MarkGenerationOrderSubmittedInTx(tx, domain, userID, input.CanvasID, turnID, input.ProposalID, input.Kind, input.NodeIDs, current, result, continuationID, approvedBy)
	})
	return result, err
}

func productionTaskKey(plan operations.GenerationAuthorization, nodeID string) string {
	return "proposal:" + plan.ProposalID + ":" + nodeID
}

func (s *operationSession) RecordGenerationOrder(userID string, order operations.GenerationOrder) error {
	return operations.UpsertGenerationOrderInTx(s.tx, userID, order)
}

func (s *operationSession) LookupGenerationOrder(userID, proposalID string) (*operations.GenerationOrder, error) {
	return operations.LookupGenerationOrderInTx(s.tx, userID, proposalID)
}

func (s *Service) ListGenerationOrders(userID, canvasID string) ([]operations.GenerationOrder, error) {
	return operations.ListGenerationOrdersInDB(s.repo.DB(), userID, canvasID)
}

func (s *Service) ApproveGenerationOrder(userID, proposalID, approvedBy string) (any, error) {
	if approvedBy == "" {
		approvedBy = "owner"
	}
	existing, err := operations.LookupOrderForApprovalInDB(s.repo.DB(), userID, proposalID)
	if err != nil {
		return nil, err
	}
	if existing.Status == operations.GenerationOrderSubmitted {
		return operations.SubmittedOrderResponse(existing), nil
	}
	if strings.TrimSpace(existing.SourceTurnID) != "" {
		var targets []operations.GenerationTarget
		if len(existing.ProductionNodeIDs) > 0 {
			targets = existing.Targets
		}
		return s.confirmAssistantProductionWithApprover(userID, existing.SourceTurnID, AssistantProductionConfirmation{CanvasID: existing.CanvasID, ProposalID: existing.ProposalID, Kind: existing.Kind, NodeIDs: existing.NodeIDs, Targets: targets, ContinuePlan: len(existing.ProductionNodeIDs) > 0}, approvedBy)
	}
	var out any
	return out, s.repo.DB().Transaction(func(tx *gorm.DB) (approveErr error) {
		out, approveErr = operations.ApproveExternalGenerationOrderInTx(tx, s.BindDomain(tx), userID, proposalID, approvedBy)
		return approveErr
	})
}

func (s *operationSession) RecordAssistantGenerationProposal(userID, turnID, canvasID string, proposal operations.GenerationAuthorization) error {
	return operations.RecordAssistantGenerationProposalInTx(s.tx, userID, turnID, canvasID, proposal)
}

func (s *operationSession) SubmitAuthorizedGeneration(userID, turnID, canvasID string, targets []operations.GenerationTarget) (any, error) {
	var source model.AssistantTurn
	if err := s.tx.First(&source, "turn_id = ? AND user_id = ? AND canvas_id = ?", turnID, userID, canvasID).Error; err != nil {
		return nil, err
	}
	var plan operations.GenerationAuthorization
	if json.Unmarshal([]byte(source.GenerationAuthorizationJSON), &plan) != nil || plan.SourceTurnID == "" {
		// Only the trusted confirmation endpoint can create a spend grant.
		// A later model call cannot promote a recorded, unconfirmed proposal.
		return nil, operations.PreconditionFailed("production_authorization_required", "请先在确认卡片中确认本次制作方案", nil)
	}
	var owner model.AssistantTurn
	if err := s.tx.First(&owner, "turn_id = ? AND user_id = ? AND canvas_id = ?", plan.SourceTurnID, userID, canvasID).Error; err != nil {
		return nil, err
	}
	if owner.Undone || owner.ContinuationInvalidated || owner.DurableSessionID != source.DurableSessionID || owner.GenerationAuthorizationJSON != source.GenerationAuthorizationJSON {
		return nil, operations.PreconditionFailed("production_revoked", "本次制作授权已停止", nil)
	}
	approved := map[string]operations.GenerationTarget{}
	for _, target := range plan.Targets {
		approved[target.NodeID] = target
	}
	for _, target := range targets {
		if !reflect.DeepEqual(approved[target.NodeID], target) {
			return nil, operations.PreconditionFailed("production_changed", "素材或参数超出已确认的制作方案，请重新确认", nil)
		}
	}
	return s.admitProductionTargets(userID, canvasID, plan, targets)
}

func (s *operationSession) admitProductionTargets(userID, canvasID string, plan operations.GenerationAuthorization, targets []operations.GenerationTarget) (any, error) {
	raw, err := s.canvas.UserCanvasProject(userID, canvasID)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	nodes := map[string]map[string]any{}
	for _, v := range doc["nodes"].([]any) {
		n, _ := v.(map[string]any)
		nodes[fmt.Sprint(n["id"])] = n
	}
	policy, err := s.service.runtimePolicyWithRepo(s.repo)
	if err != nil {
		return nil, err
	}
	adapter := operationRenderDependencies{s: s, policy: policy}
	deps := s.service.taskDependencies()
	deps.Projects = adapter
	deps.Policy = adapter
	deps.Persist = adapter
	deps.Present = operationRenderPresenter{}
	deps.Logs = nil
	deps.Activity = nil
	domain := localtask.NewService(localtask.NewStore(s.repo), deps)
	taskIDs := []string{}
	nodeIDs := []string{}
	changed := false
	for _, target := range targets {
		key := productionTaskKey(plan, target.NodeID)
		existing, err := s.repo.TaskByClientOperation(userID, key)
		if err != nil {
			return nil, err
		}
		if existing != nil {
			// Validate the original admitted request against its hash before
			// repairing a missing node receipt. Never re-resolve credentials or
			// references merely to recover an already accepted task.
			if err := operations.ValidateProductionTask(existing, canvasID, target); err != nil {
				return nil, err
			}
			meta, _ := nodes[target.NodeID]["metadata"].(map[string]any)
			if meta == nil {
				meta = map[string]any{}
				nodes[target.NodeID]["metadata"] = meta
			}
			// Preserve successful material bindings. Missing receipts use the
			// normal delivery recovery path with the same task identity.
			id, _ := meta["taskId"].(string)
			id = strings.TrimSpace(id)
			opID, _ := meta["taskClientOperationId"].(string)
			opID = strings.TrimSpace(opID)
			storage, _ := meta["storageKey"].(string)
			content, _ := meta["content"].(string)
			if (id != "" && id != existing.ID) || (id == "" && ((opID != "" && opID != key) || meta["generationSubmissionState"] == "submitting" || strings.TrimSpace(storage) != "" || strings.TrimSpace(content) != "")) {
				return nil, operations.Conflict("production_node_changed", "素材节点已使用其他任务，请先检查当前结果", nil)
			}
			proj, _, _, err := assistantturns.ProjectTaskInTx(s.tx, userID, *existing)
			if err != nil {
				return nil, err
			}
			for field, value := range map[string]any{"taskId": existing.ID, "taskStatus": string(existing.Status), "taskClientOperationId": key, "generationSubmissionState": "accepted"} {
				if meta[field] != value {
					meta[field] = value
					changed = true
				}
			}
			if existing.Status == model.TaskStatusCancelled || (existing.Status == model.TaskStatusFailed && proj.Outcome.Phase == "failed") {
				changed = canvas.ApplyTaskFailureMetadata(meta, canvas.TaskFailure{TaskID: existing.ID, TaskStatus: string(existing.Status), Message: existing.Error, Outcome: proj.Outcome}) || changed
			} else if storage, _ := meta["storageKey"].(string); storage == "" && meta["status"] != "loading" {
				meta["status"] = "loading"
				changed = true
			}
			taskIDs = append(taskIDs, existing.ID)
			nodeIDs = append(nodeIDs, target.NodeID)
			continue
		}
		meta, _ := nodes[target.NodeID]["metadata"].(map[string]any)
		if meta == nil {
			meta = map[string]any{}
			nodes[target.NodeID]["metadata"] = meta
		}
		if meta["status"] == "loading" || meta["taskStatus"] == "queued" || meta["taskStatus"] == "running" || meta["generationSubmissionState"] == "submitting" {
			return nil, operations.Conflict("production_node_changed", "素材节点已使用其他任务，请先检查当前结果", nil)
		}
		input, err := s.productionTaskInput(userID, target, nodes)
		if err != nil {
			return nil, err
		}
		input["metadata"].(map[string]any)["clientOperationId"] = key
		input["metadata"].(map[string]any)["assistantProductionTargetHash"] = operations.ProductionTargetHash(target)
		task, err := domain.CreateTask(userID, localtask.CreateRequest{ProjectID: canvasID, Type: "canvas_" + target.Kind, Prompt: target.Prompt, Input: input})
		if err != nil {
			return nil, err
		}
		canvas.ClearGenerationAttemptMetadata(meta)
		meta["taskId"], meta["taskStatus"], meta["status"] = task.ID, string(task.Status), "loading"
		meta["taskClientOperationId"], meta["generationSubmissionState"] = key, "accepted"
		changed = true
		taskIDs = append(taskIDs, task.ID)
		nodeIDs = append(nodeIDs, target.NodeID)
	}
	revision := assistantDocRevision(doc)
	if changed {
		encoded, _ := json.Marshal(doc)
		summary, _, err := s.canvas.CommitUserCanvasDocument(userID, canvasID, revision, encoded)
		if err != nil {
			return nil, err
		}
		revision = summary.Revision
	}
	return map[string]any{"canvasId": canvasID, "taskIds": taskIDs, "nodeIds": nodeIDs, "status": "submitted", "revision": revision, "authorized": true}, nil
}

func (s *operationSession) productionTaskInput(userID string, target operations.GenerationTarget, nodes map[string]map[string]any) (map[string]any, error) {
	config, err := s.service.assistantGenerationConfig(target)
	if err != nil {
		return nil, err
	}
	input := map[string]any{"mode": target.Kind, "prompt": target.Prompt, "config": config, "metadata": map[string]any{"nodeId": target.NodeID, "sourceNodeId": target.NodeID, "outputNodeIds": []string{target.NodeID}, "source": "assistant-production"}}
	for key, value := range target.Metadata {
		input["metadata"].(map[string]any)[key] = value
	}
	for _, key := range []string{"videoStartFrameNodeId", "videoEndFrameNodeId", "videoMiddleFrameNodeId"} {
		if value := target.Parameters[key]; value != "" {
			input["metadata"].(map[string]any)[key] = value
		}
	}
	for _, id := range target.ReferenceNodeIDs {
		node := nodes[id]
		meta, _ := node["metadata"].(map[string]any)
		if meta["status"] == "loading" || meta["taskStatus"] == "queued" || meta["taskStatus"] == "running" || meta["generationSubmissionState"] == "submitting" {
			return nil, operations.PreconditionFailed("generation_dependencies_not_ready", "参考素材仍在生成，请等待原任务保存", nil)
		}
		key, _ := meta["storageKey"].(string)
		if !strings.HasPrefix(key, "resource:") {
			return nil, operations.PreconditionFailed("generation_dependencies_not_ready", "参考素材尚未保存", nil)
		}
		resource, err := s.repo.Resource(strings.TrimPrefix(key, "resource:"))
		if err != nil {
			return nil, err
		}
		if resource.UserID != userID || resource.Status != "ready" {
			return nil, operations.PreconditionFailed("generation_dependencies_not_ready", "参考素材尚未就绪或不属于当前工作区", nil)
		}
		kind := fmt.Sprint(node["type"])
		field := map[string]string{"image": "referenceImages", "video": "referenceVideos", "audio": "referenceAudios"}[kind]
		if field == "" {
			return nil, operations.InvalidArg("unsupported_reference", "本次制作只支持已保存的图片、视频和声音参考")
		}
		list, _ := input[field].([]any)
		input[field] = append(list, map[string]any{"id": id, "storageKey": key, "mimeType": resource.MimeType, "width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs})
	}
	return input, nil
}
