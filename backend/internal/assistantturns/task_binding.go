package assistantturns

import (
	"errors"
	"strings"

	"gorm.io/gorm"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
	localtask "qisitv/backend/internal/task"
	"qisitv/backend/internal/taskdelivery"
)

const taskStageRequestNotSent = "请求尚未提交"

type TargetBindingState string

const (
	TargetBindingWaiting       TargetBindingState = "waiting"
	TargetBindingReady         TargetBindingState = "ready"
	TargetBindingFailed        TargetBindingState = "failed"
	TargetBindingTargetChanged TargetBindingState = "target_changed"
)

type TaskTargetInspection struct {
	Projection taskdelivery.Projection
	State      TargetBindingState
}

// ProjectTaskInTx computes the canonical task delivery and outcome projection
// inside the caller's transaction. Any database or payload error is returned
// directly so callers defer observation without mutating or replacing tasks.
func ProjectTaskInTx(tx *gorm.DB, userID string, task model.Task) (taskdelivery.Projection, map[int]localtask.CanonicalOutput, map[string]bool, error) {
	if tx == nil {
		return taskdelivery.Projection{}, nil, nil, errors.New("task projection requires a database connection")
	}
	repo := repository.New(tx)
	if task.Status == model.TaskStatusFailed && task.ProviderRequestID == "" {
		providerRequestID, err := repo.LatestProviderRequestIDForTask(task.ID)
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return taskdelivery.Projection{}, nil, nil, err
		}
		task.ProviderRequestID = providerRequestID
	}
	var records []model.Result
	if err := tx.Where("task_id = ? AND user_id = ? AND kind = ?", task.ID, userID, localtask.ResultKindGenerationOutput).Find(&records).Error; err != nil {
		return taskdelivery.Projection{}, nil, nil, err
	}
	stored, err := taskdelivery.DecodeStoredOutputs(records)
	if err != nil {
		return taskdelivery.Projection{}, nil, nil, err
	}
	storedByIndex := make(map[int]localtask.CanonicalOutput, len(stored))
	readyResources := make(map[string]bool, len(stored))
	for i := range stored {
		output := stored[i]
		if _, duplicate := storedByIndex[output.OutputIndex]; duplicate {
			return taskdelivery.Projection{}, nil, nil, continuationError("task_mismatch")
		}
		if output.ResourceID != "" && output.MaterializationErrorCode == "" {
			var resource model.Resource
			err := tx.First(&resource, "id = ? AND user_id = ? AND status = ?", output.ResourceID, userID, model.ResourceStatusReady).Error
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return taskdelivery.Projection{}, nil, nil, err
			}
			if err == nil {
				readyResources[output.ResourceID] = true
				if output.MaterializedAssetID == "" {
					output.MaterializedAssetID = localtask.MaterializedAssetID(task.ID, output.OutputIndex)
				}
			} else {
				output.MaterializedAssetID = ""
			}
		}
		stored[i] = output
		storedByIndex[output.OutputIndex] = output
	}
	var facts localtask.OutcomeFacts
	if task.Status != model.TaskStatusQueued && task.Status != model.TaskStatusRunning && task.Status != model.TaskStatusSucceeded {
		evidence, err := repo.ImageRecoveryEvidence([]string{task.ID})
		if err != nil {
			return taskdelivery.Projection{}, nil, nil, err
		}
		facts = localtask.OutcomeFacts{RequestNotSent: task.Stage == taskStageRequestNotSent}
		if e, ok := evidence[task.ID]; ok {
			facts.HasImageReceipt = e.HasReceipt
			if e.Attempt != nil && e.Attempt.RouteRun == task.RouteRun {
				facts.DispatchState = e.Attempt.DispatchState
				if e.Submission != nil && e.Submission.UserID == task.UserID {
					facts.ImageResponseAccepted = e.Submission.ResponseAccepted
				}
			}
		}
	}
	failedRetryBlocked := task.Stage != taskStageRequestNotSent && (task.Stage == "submission_unknown" || generation.ClassifyText(task.Error).BlocksManualRetry())
	proj := taskdelivery.ProjectWithFacts(task, stored, nil, failedRetryBlocked, facts)
	return proj, storedByIndex, readyResources, nil
}

// InspectTaskTargetsInTx centralizes task outcome reading and target node
// binding verification for assistant production progress and continuation.
func InspectTaskTargetsInTx(
	tx *gorm.DB,
	userID string,
	task model.Task,
	expectedKind string,
	primaryNodeID string,
	targetNodeIDs []string,
	nodeMeta func(nodeID string) (map[string]any, bool),
) (TaskTargetInspection, error) {
	for _, nodeID := range targetNodeIDs {
		meta, exists := nodeMeta(nodeID)
		if !exists {
			return TaskTargetInspection{State: TargetBindingTargetChanged}, nil
		}
		nodeTaskID, _ := meta["taskId"].(string)
		if strings.TrimSpace(nodeTaskID) != task.ID {
			return TaskTargetInspection{State: TargetBindingTargetChanged}, nil
		}
	}
	proj, storedByIndex, readyResources, err := ProjectTaskInTx(tx, userID, task)
	if err != nil {
		return TaskTargetInspection{}, err
	}
	if task.Status == model.TaskStatusCancelled {
		return TaskTargetInspection{Projection: proj, State: TargetBindingFailed}, nil
	}
	if task.Status != model.TaskStatusSucceeded {
		if proj.Outcome.Phase == "running" || proj.Outcome.Phase == "fetching" || proj.Outcome.Phase == "retrievable" {
			return TaskTargetInspection{Projection: proj, State: TargetBindingWaiting}, nil
		}
		return TaskTargetInspection{Projection: proj, State: TargetBindingFailed}, nil
	}
	if len(storedByIndex) > len(targetNodeIDs) {
		return TaskTargetInspection{Projection: proj, State: TargetBindingWaiting}, nil
	}
	waiting, failed, targetChanged := false, false, false
	for index, nodeID := range targetNodeIDs {
		output, present := storedByIndex[index]
		if !present {
			waiting = true
			continue
		}
		if output.MaterializationErrorCode != "" {
			if output.MediaType == expectedKind && output.TargetBinding != nil && output.TargetBinding.NodeID == primaryNodeID {
				failed = true
			} else {
				waiting = true
			}
			continue
		}
		meta, _ := nodeMeta(nodeID)
		key, _ := meta["storageKey"].(string)
		if output.ResourceID == "" || !strings.HasPrefix(key, "resource:") || meta["status"] != "success" || meta["resourceReloadAvailable"] == true {
			waiting = true
			continue
		}
		// Delivery keeps the task's primary node on every canonical output.
		// Native multi-image destinations are the immutable indexed outputNodeIds
		// checked above, exactly as taskbinding.Bind resolves them.
		if key != "resource:"+output.ResourceID || output.TargetBinding == nil || output.TargetBinding.NodeID != primaryNodeID || output.MediaType != expectedKind {
			targetChanged = true
			continue
		}
		if !readyResources[output.ResourceID] {
			waiting = true
			continue
		}
	}
	if waiting {
		return TaskTargetInspection{Projection: proj, State: TargetBindingWaiting}, nil
	}
	if targetChanged {
		return TaskTargetInspection{Projection: proj, State: TargetBindingTargetChanged}, nil
	}
	if failed || proj.Outcome.Phase == "failed" {
		return TaskTargetInspection{Projection: proj, State: TargetBindingFailed}, nil
	}
	if proj.Outcome.Phase != "ready" {
		return TaskTargetInspection{Projection: proj, State: TargetBindingWaiting}, nil
	}
	return TaskTargetInspection{Projection: proj, State: TargetBindingReady}, nil
}
