package operations

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"

	"qisitv/backend/internal/model"
)

const generationOrderOpName = "canvas.generation.order"

func generationOrderOpID(proposalID string) string {
	return "generation-order:" + strings.TrimSpace(proposalID)
}

func UpsertGenerationOrderInTx(tx *gorm.DB, userID string, order GenerationOrder) error {
	proposalID := strings.TrimSpace(order.ProposalID)
	if proposalID == "" {
		proposalID = strings.TrimSpace(order.OrderID)
	}
	if proposalID == "" {
		return nil
	}
	order.ProposalID = proposalID
	if strings.TrimSpace(order.OrderID) == "" {
		order.OrderID = proposalID
	}
	encoded, err := json.Marshal(order)
	if err != nil {
		return err
	}
	opID := generationOrderOpID(proposalID)
	status := "order:" + string(order.Status)
	var existing model.AgentOpRecord
	findErr := tx.Where("user_id = ? AND op_id = ?", userID, opID).First(&existing).Error
	if errors.Is(findErr, gorm.ErrRecordNotFound) {
		return tx.Create(&model.AgentOpRecord{
			OpID:        opID,
			UserID:      userID,
			Op:          generationOrderOpName,
			PayloadHash: strings.TrimSpace(order.CanvasID),
			Status:      status,
			ResultJSON:  string(encoded),
			TurnID:      "",
		}).Error
	}
	if findErr != nil {
		return findErr
	}
	return tx.Model(&model.AgentOpRecord{}).Where("user_id = ? AND op_id = ?", userID, opID).Updates(map[string]any{
		"payload_hash": strings.TrimSpace(order.CanvasID),
		"status":       status,
		"result_json":  string(encoded),
	}).Error
}

func LookupGenerationOrderInTx(tx *gorm.DB, userID, proposalID string) (*GenerationOrder, error) {
	proposalID = strings.TrimSpace(proposalID)
	if proposalID == "" {
		return nil, nil
	}
	var record model.AgentOpRecord
	err := tx.Where("user_id = ? AND op_id = ?", userID, generationOrderOpID(proposalID)).First(&record).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var order GenerationOrder
	if err := json.Unmarshal([]byte(record.ResultJSON), &order); err != nil {
		return nil, err
	}
	return &order, nil
}

func ListGenerationOrdersInDB(db *gorm.DB, userID, canvasID string) ([]GenerationOrder, error) {
	query := db.Where("user_id = ? AND op = ?", userID, generationOrderOpName)
	if trimmed := strings.TrimSpace(canvasID); trimmed != "" {
		query = query.Where("payload_hash = ?", trimmed)
	}
	var records []model.AgentOpRecord
	if err := query.Order("created_at DESC").Limit(100).Find(&records).Error; err != nil {
		return nil, err
	}
	orders := make([]GenerationOrder, 0, len(records))
	for _, rec := range records {
		var order GenerationOrder
		if err := json.Unmarshal([]byte(rec.ResultJSON), &order); err != nil {
			continue
		}
		orders = append(orders, order)
	}
	return orders, nil
}

func MarkGenerationOrderSubmittedInTx(
	tx *gorm.DB,
	domain Domain,
	userID, canvasID, turnID, proposalID, kind string,
	nodeIDs []string,
	targets []GenerationTarget,
	admitResult any,
	continuationID, approvedBy string,
) error {
	if strings.TrimSpace(proposalID) == "" {
		return nil
	}
	now := time.Now().UTC().Format(time.RFC3339)
	existing, err := LookupGenerationOrderInTx(tx, userID, proposalID)
	if err != nil {
		return err
	}
	var taskIDs []string
	if resultMap, ok := admitResult.(map[string]any); ok {
		if ids, ok := resultMap["taskIds"].([]string); ok {
			taskIDs = ids
		}
	}
	var order GenerationOrder
	if existing != nil {
		order = *existing
		order.Status = GenerationOrderSubmitted
		order.ApprovedBy = approvedBy
		order.ApprovedAt = now
		order.TaskIDs = taskIDs
		order.ContinuationID = continuationID
		order.UpdatedAt = now
	} else {
		modelDisplay := ""
		modelKey := ""
		if len(targets) > 0 {
			modelKey = targets[0].ModelKey
			modelDisplay = modelKey
			if i := strings.LastIndex(modelDisplay, "::"); i >= 0 {
				modelDisplay = modelDisplay[i+2:]
			}
			if choice, resolveErr := domain.ResolveAssistantGenerationModel(targets[0].Kind, modelKey); resolveErr == nil && choice.Display != "" {
				modelDisplay = choice.Display
			}
		}
		order = GenerationOrder{
			OrderID:        proposalID,
			ProposalID:     proposalID,
			CanvasID:       canvasID,
			CallerKind:     CallerAssistant,
			CallerClient:   "assistant-host",
			ApprovalMode:   ApprovalModeAsk,
			Status:         GenerationOrderSubmitted,
			ApprovedBy:     approvedBy,
			ApprovedAt:     now,
			Kind:           kind,
			Model:          modelDisplay,
			ModelKey:       modelKey,
			Pricing:        ResolveModelPricing(domain, modelKey),
			NodeIDs:        nodeIDs,
			Targets:        targets,
			TargetViews:    BuildGenerationOrderTargetViews(domain, targets),
			SourceTurnID:   turnID,
			TaskIDs:        taskIDs,
			ContinuationID: continuationID,
			CreatedAt:      now,
			UpdatedAt:      now,
		}
	}
	if err := UpsertGenerationOrderInTx(tx, userID, order); err != nil {
		return err
	}
	if resultMap, ok := admitResult.(map[string]any); ok {
		resultMap["orderId"] = order.OrderID
		resultMap["proposalId"] = order.ProposalID
		resultMap["order"] = order
	}
	return nil
}

func SubmittedOrderResponse(order *GenerationOrder) map[string]any {
	return map[string]any{
		"canvasId":       order.CanvasID,
		"orderId":        order.OrderID,
		"proposalId":     order.ProposalID,
		"status":         string(order.Status),
		"taskIds":        order.TaskIDs,
		"nodeIds":        order.NodeIDs,
		"continuationId": order.ContinuationID,
		"order":          order,
	}
}

func LookupOrderForApprovalInDB(db *gorm.DB, userID, proposalID string) (*GenerationOrder, error) {
	if strings.TrimSpace(proposalID) == "" {
		return nil, InvalidArg("missing_proposal_id", "proposalId 必填")
	}
	existing, err := LookupGenerationOrderInTx(db, userID, proposalID)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, NotFound("generation_order_not_found", "生成单不存在: "+proposalID)
	}
	return existing, nil
}

func ApproveExternalGenerationOrderInTx(tx *gorm.DB, domain Domain, userID, proposalID, approvedBy string) (any, error) {
	order, err := LookupGenerationOrderInTx(tx, userID, proposalID)
	if err != nil {
		return nil, err
	}
	if order == nil {
		return nil, NotFound("generation_order_not_found", "生成单不存在: "+proposalID)
	}
	if order.Status == GenerationOrderSubmitted {
		return SubmittedOrderResponse(order), nil
	}
	raw, err := domain.UserCanvasProject(userID, order.CanvasID)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	if order.CanvasRevision > 0 && canvasRevision(doc) != order.CanvasRevision {
		expected := order.CanvasRevision
		opErr := Conflict("revision_conflict", "画布已变化，请重新生成提议后再批准", nil)
		EnrichCanvasConflictErrorInTx(tx, domain, userID, order.CanvasID, &expected, raw, opErr)
		return nil, opErr
	}
	batchTargets, err := GenerationTargets(domain, doc, order.NodeIDs)
	if err != nil {
		return nil, err
	}
	for _, target := range batchTargets {
		choice, resolveErr := domain.ResolveAssistantGenerationModel(target.Kind, target.ModelKey)
		if resolveErr != nil {
			return nil, resolveErr
		}
		if order.ModelConfigRevision > 0 && choice.Revision != order.ModelConfigRevision {
			return nil, Conflict("generation_config_changed", "模型配置已变化，请重新生成提议后再批准", nil)
		}
	}
	if len(order.Targets) > 0 && !generationTargetsContainBatch(order.Targets, batchTargets) {
		return nil, Conflict("production_changed", "制作方案已变化，请重新确认", nil)
	}
	port, ok := domain.(ExternalGenerationAdmission)
	if !ok {
		return nil, Unsupported("generation_unavailable", "当前工作区不能提交生成")
	}
	admitted, err := port.SubmitExternalGeneration(userID, "approve:"+order.ProposalID, order.CanvasID, batchTargets)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	order.Status = GenerationOrderSubmitted
	order.ApprovedBy = approvedBy
	order.ApprovedAt = now
	order.UpdatedAt = now
	if resultMap, ok := admitted.(map[string]any); ok {
		if ids, ok := resultMap["taskIds"].([]string); ok {
			order.TaskIDs = ids
		}
		resultMap["orderId"] = order.OrderID
		resultMap["proposalId"] = order.ProposalID
		resultMap["order"] = order
	}
	if err := UpsertGenerationOrderInTx(tx, userID, *order); err != nil {
		return nil, err
	}
	return admitted, nil
}

func RecordAssistantGenerationProposalInTx(tx *gorm.DB, userID, turnID, canvasID string, proposal GenerationAuthorization) error {
	if strings.TrimSpace(turnID) == "" || strings.TrimSpace(proposal.ProposalID) == "" || len(proposal.Targets) == 0 {
		return nil
	}
	var turn model.AssistantTurn
	if err := tx.First(&turn, "turn_id = ? AND user_id = ? AND canvas_id = ?", turnID, userID, canvasID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	if turn.GenerationAuthorizationJSON != "" {
		var existing GenerationAuthorization
		if json.Unmarshal([]byte(turn.GenerationAuthorizationJSON), &existing) == nil && existing.SourceTurnID != "" {
			return nil
		}
	}
	proposal.SourceTurnID = ""
	encoded, err := json.Marshal(proposal)
	if err != nil {
		return err
	}
	return tx.Model(&turn).Update("generation_authorization_json", string(encoded)).Error
}

func ProductionTargetHash(target GenerationTarget) string {
	encoded, _ := json.Marshal(target)
	return fmt.Sprintf("%x", sha256.Sum256(encoded))
}

func ValidateProductionTask(task *model.Task, canvasID string, target GenerationTarget) error {
	var original struct {
		Metadata map[string]any `json:"metadata"`
	}
	if err := json.Unmarshal([]byte(task.InputJSON), &original); err != nil {
		return err
	}
	if task.ProjectID != canvasID || task.Type != "canvas_"+target.Kind || task.Prompt != target.Prompt || original.Metadata["assistantProductionTargetHash"] != ProductionTargetHash(target) {
		return Conflict("production_task_changed", "原制作任务与确认记录不一致，请先检查原任务", nil)
	}
	return nil
}
