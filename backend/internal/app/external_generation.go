package app

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"

	"qisitv/backend/internal/operations"
)

// The operation registry authenticates external clients and commits admission,
// canvas receipts and operation replay together. No synthetic assistant turn is needed.
func (s *operationSession) SubmitExternalGeneration(userID, operationID, canvasID string, targets []operations.GenerationTarget) (any, error) {
	raw, err := s.canvas.UserCanvasProject(userID, canvasID)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	wanted := map[string]bool{}
	for _, target := range targets {
		wanted[target.NodeID] = true
	}
	for _, value := range doc["nodes"].([]any) {
		node, _ := value.(map[string]any)
		if !wanted[stringValue(node["id"])] {
			continue
		}
		meta, _ := node["metadata"].(map[string]any)
		// A changed operation key is not evidence that an earlier uncertain
		// generation may be purchased again. Existing tasks keep their own retry path.
		if stringValue(meta["taskId"]) != "" || stringValue(meta["taskClientOperationId"]) != "" || stringValue(meta["generationSubmissionState"]) != "" || meta["status"] == "loading" {
			return nil, operations.PreconditionFailed("generation_task_exists", "节点已关联生成任务，请先查询原任务；需要另做一份时请新建节点", map[string]any{"nodeId": node["id"], "taskId": meta["taskId"]})
		}
	}
	// Namespace task keys separately from internal proposal IDs and caller-chosen strings.
	plan := operations.GenerationAuthorization{ProposalID: fmt.Sprintf("external-%x", sha256.Sum256([]byte(operationID))), Targets: targets}
	return s.admitProductionTargets(userID, canvasID, plan, targets)
}
