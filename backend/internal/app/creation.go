package app

import (
	"encoding/json"

	"qisitv/backend/internal/creation"
	"qisitv/backend/internal/model"
)

type (
	CreationGuard            = creation.Guard
	CreationCanvasOp         = creation.CanvasOp
	CreationSubmissionOutput = creation.SubmissionOutput
	CreationDetail           = creation.Detail
)

type CreationRequest struct {
	CreationGuard
	ClientKey            string             `json:"clientKey"`
	CanvasID             string             `json:"canvasId"`
	Revision             int64              `json:"revision"`
	ExpectedEpoch        int64              `json:"expectedEpoch"`
	State                map[string]any     `json:"state"`
	Status               string             `json:"status"`
	ProposalVersion      int64              `json:"proposalVersion"`
	Proposal             json.RawMessage    `json:"proposal"`
	Ops                  []CreationCanvasOp `json:"ops"`
	ItemKey              string             `json:"itemKey"`
	Request              CreateTaskRequest  `json:"request"`
	SubmissionIDs        []string           `json:"submissionIds"`
	SubmissionID         string             `json:"submissionId"`
	ExpectedSnapshotHash string             `json:"expectedSnapshotHash"`
	Document             json.RawMessage    `json:"document"`
}

func creationConflict(message string) error                                                                    { return creation.Conflict(message) }
func (s *Service) CreateCreationRun(u string, req CreationRequest) (*CreationDetail, error)                    { s.storageMu.Lock(); defer s.storageMu.Unlock(); return s.creationDomain().CreateRun(u, toCreationCommand(req)) }
func (s *Service) ChangeCreationRun(u, id, action string, req CreationRequest) (any, error)                    { return s.creationDomain().Dispatch(u, id, action, toCreationCommand(req)) }
func (s *Service) PrepareCreationSubmission(u, id string, req CreationRequest) (*CreationSubmissionOutput, error) { s.storageMu.Lock(); defer s.storageMu.Unlock(); return s.creationDomain().Prepare(u, id, toCreationCommand(req)) }
func (s *Service) ApproveCreationSubmissions(u, id string, req CreationRequest) (map[string]any, error)        { return s.creationDomain().Approve(u, id, toCreationCommand(req)) }
func (s *Service) ExecuteCreationSubmission(u, id string, req CreationRequest) (*model.Task, error)            { return s.creationDomain().ExecuteSubmission(u, id, toCreationCommand(req)) }
func validateCreationSubmissionScope(run *model.CreationRun, v int64, req CreateTaskRequest) error             { return creation.ValidateSubmissionScope(run, v, toCreationTaskRequest(req)) }
