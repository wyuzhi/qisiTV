package app

import (
	"encoding/json"
	"errors"
	"strings"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	localtask "infinite-canvas/backend/internal/task"
)

const canvasBindRecoveryBatch = localtask.CanvasBindRecoveryBatch

func (s *Service) workspaceOperations() *operations.Registry {
	if s == nil || s.repo == nil {
		return nil
	}
	s.workspaceOpsMu.Lock()
	defer s.workspaceOpsMu.Unlock()
	if s.workspaceOps != nil {
		return s.workspaceOps
	}
	db := s.Database()
	if db == nil {
		return nil
	}
	registry := operations.NewRegistry(s, operations.NewStore(db))
	operations.RegisterDefaultOps(registry)
	s.workspaceOps = registry
	return registry
}

func (s *Service) recoverCanvasTaskBindings(task model.Task) error {
	if s == nil {
		return nil
	}
	registry := s.workspaceOperations()
	return localtask.RecoverCanvasTaskBindings(localtask.CanvasBindDeps{
		Repo:            s.repo,
		Intents:         s.CanvasBindingIntents,
		PrepareSeedream: s.prepareSeedreamOutputNodes,
		RegisterOutput:  s.RegisterTaskOutputFromTask,
		DeliverAndIntents: func(t model.Task) []localtask.CanvasBindingIntent {
			_ = s.generationDeliverer().Deliver(t)
			return s.CanvasBindingIntents(t)
		},
		HasWorkspaceOps: registry != nil,
		ExecuteCanvasBind: func(t model.Task, nodeID string, outputIndex int) error {
			return s.executeCanvasTaskBind(registry, t, nodeID, outputIndex)
		},
		ExecuteMessageBind: func(t model.Task, conversationID, messageID string, outputIndex int) error {
			return s.executeMessageTaskAttach(registry, t, conversationID, messageID, outputIndex)
		},
		Refusal:             canvasBindRefusal,
		ReconcileTurnaround: s.reconcileCharacterTurnaroundTasks,
	}, task)
}

func (s *Service) recoverPendingCanvasBindings(limit int) error {
	if s == nil || s.repo == nil {
		return nil
	}
	return localtask.RecoverPendingCanvasBindings(s.repo, s.workspaceOperations() != nil, &s.bindCursorMu, &s.bindAfterID, limit, s.recoverCanvasTaskBindings)
}

func (s *Service) recoverPendingCanvasFailures(limit int) error {
	if s == nil || s.repo == nil {
		return nil
	}
	return s.canvasFailures.Run(localtask.CanvasFailureDeps{Repo: s.repo, Record: s.canvasDomain().RecordTaskFailures, Outcome: func(task model.Task) (localtask.Outcome, error) {
		projection, _, _, err := assistantturns.ProjectTaskInTx(s.repo.DB(), task.UserID, task)
		return projection.Outcome, err
	}}, limit)
}

func (s *Service) executeMessageTaskAttach(registry *operations.Registry, task model.Task, conversationID, messageID string, outputIndex int) error {
	conversationID, messageID = strings.TrimSpace(conversationID), strings.TrimSpace(messageID)
	if registry == nil || conversationID == "" || messageID == "" {
		return nil
	}
	params, err := json.Marshal(map[string]any{"conversationId": conversationID, "taskId": task.ID, "messageId": messageID, "outputIndex": outputIndex})
	if err != nil {
		return err
	}
	_, err = registry.Execute(operations.Request{Op: "conversation.message.attach", OpID: localtask.AttachMessageEffectKey(task.ID, messageID, outputIndex), UserID: task.UserID, Caller: operations.ManualCaller(false), Params: params})
	if skippableCanvasBindError(err) {
		return nil
	}
	return err
}

func (s *Service) executeCanvasTaskBind(registry *operations.Registry, task model.Task, nodeID string, outputIndex int) error {
	canvasID, nodeID := strings.TrimSpace(task.ProjectID), strings.TrimSpace(nodeID)
	if registry == nil || canvasID == "" || nodeID == "" {
		return nil
	}
	params, err := json.Marshal(map[string]any{"canvasId": canvasID, "taskId": task.ID, "nodeId": nodeID, "outputIndex": outputIndex})
	if err != nil {
		return err
	}
	_, err = registry.Execute(operations.Request{Op: "canvas.task.bind", OpID: localtask.AttachNodeEffectKey(task.ID, nodeID, outputIndex), UserID: task.UserID, Caller: operations.ManualCaller(false), Params: params})
	return err
}

func skippableCanvasBindError(err error) bool {
	return localtask.SkippableCanvasBindError(err, canvasBindRefusal)
}

func (s *Service) canvasRevision(task model.Task) func() (int64, error) {
	return localtask.CanvasRevisionFromRepo(s.repo, task)
}

func (s *Service) canvasExists(userID string) func(string) (bool, error) {
	return localtask.CanvasExistsInRepo(s.repo, userID)
}

func (s *Service) isOwnedBusinessProject(userID string) func(string) (bool, error) {
	return localtask.IsOwnedBusinessProjectInRepo(s.repo, userID)
}

func canvasBindRefusal(err error) (string, map[string]any) {
	var opErr *operations.Error
	if err == nil || !errors.As(err, &opErr) {
		return "", nil
	}
	return opErr.Reason, opErr.Details
}

func bindInfrastructureUnavailable(err error) bool {
	return localtask.BindInfrastructureUnavailable(err)
}
