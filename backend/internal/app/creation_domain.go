package app

import (
	"encoding/json"

	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/creation"
	"qisitv/backend/internal/repository"
)

func (s *Service) Creation() *creation.Service { return s.creationDomain() }
func (s *Service) creationDomain() *creation.Service {
	return creation.NewFromConfig(s.repo, creation.HostConfig{
		StorageLock: &s.storageMu, PrepareTask: s.CreateLocalTask, RuntimePolicy: s.runtimePolicyWithRepo, ProtectSecrets: s.protectTaskSecrets,
		ValidateDocument: func(u string, repo *repository.Repository, raw json.RawMessage) error {
			return canvas.New(repo, newCanvasHostWithRepo(s, repo)).ValidateCanvasMediaAssets(u, raw)
		},
		UsesTextReplay: isTextReplayTaskRequest, FormatTask: taskForOutput,
	})
}
func toCreationCommand(req CreationRequest) creation.Command {
	return creation.Command{Guard: req.CreationGuard, ClientKey: req.ClientKey, CanvasID: req.CanvasID, Revision: req.Revision, ExpectedEpoch: req.ExpectedEpoch, State: req.State, Status: req.Status, ProposalVersion: req.ProposalVersion, Proposal: req.Proposal, Ops: req.Ops, ItemKey: req.ItemKey, Task: toCreationTaskRequest(req.Request), SubmissionIDs: req.SubmissionIDs, SubmissionID: req.SubmissionID, ExpectedSnapshotHash: req.ExpectedSnapshotHash, Document: req.Document}
}
func toCreationTaskRequest(req CreateTaskRequest) creation.TaskRequest {
	return creation.TaskRequest{ProjectID: req.ProjectID, Type: req.Type, Operation: req.Operation, Prompt: req.Prompt, Provider: req.Provider, Model: req.Model, LogicalModelID: req.LogicalModelID, Input: req.Input, TraceID: req.TraceID, RequestID: req.RequestID}
}

type creationTasksAdapter struct{ s *Service }
type creationQuotaAdapter = creationTasksAdapter

func (a creationTasksAdapter) Prepare(u string, req creation.TaskRequest) (*creation.PreparedTask, error) { return creation.PreparedFromTask(a.s.CreateLocalTask(u, req.ToLocalCreateRequest())) }
func (a creationTasksAdapter) ValidateCanvas(u string, repo *repository.Repository, creating bool, delta int64) error { return creation.ValidateCanvasWithPolicy(u, repo, creating, delta, a.s.runtimePolicyWithRepo) }
