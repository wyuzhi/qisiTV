package app

import (
	"crypto/sha256"
	"fmt"

	"qisitv/backend/internal/operations"
)

// The operation registry authenticates external clients and commits admission,
// canvas receipts and operation replay together. No synthetic assistant turn is needed.
func (s *operationSession) SubmitExternalGeneration(userID, operationID, canvasID string, targets []operations.GenerationTarget) (any, error) {
	if err := operations.ReleaseFailedGenerationNodes(s, s.tx, userID, canvasID, targets); err != nil {
		return nil, err
	}
	// Namespace task keys separately from internal proposal IDs and caller-chosen strings.
	plan := operations.GenerationAuthorization{ProposalID: fmt.Sprintf("external-%x", sha256.Sum256([]byte(operationID))), Targets: targets}
	return s.admitProductionTargets(userID, canvasID, plan, targets)
}
