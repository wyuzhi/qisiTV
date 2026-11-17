package app

import (
	"crypto/sha256"
	"fmt"

	"qisitv/backend/internal/operations"
)

func (s *operationSession) SubmitExternalGeneration(userID, operationID, canvasID string, targets []operations.GenerationTarget, releaseEnded bool) (any, error) {
	release := operations.ReleaseFailedGenerationNodes
	if releaseEnded {
		release = operations.ReleaseEndedGenerationNodes
	}
	if err := release(s, s.tx, userID, canvasID, targets); err != nil {
		return nil, err
	}
	return s.admitProductionTargets(userID, canvasID, operations.GenerationAuthorization{ProposalID: fmt.Sprintf("external-%x", sha256.Sum256([]byte(operationID))), Targets: targets}, targets)
}
