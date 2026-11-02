package app

import (
	"context"
	"encoding/json"

	"gorm.io/gorm"

	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/operations"
	"qisitv/backend/internal/repository"
	localtask "qisitv/backend/internal/task"
	"qisitv/backend/internal/taskbinding"
)

type (
	AssetsSyncRequest    = canvas.AssetsSyncRequest
	CanvasHistoryList    = canvas.CanvasHistoryList
	UserDataSummary      = canvas.UserDataSummary
	UserDataSnapshot     = canvas.UserDataSnapshot
	CanvasLibrarySummary = canvas.CanvasLibrarySummary
	CanvasLibraryPage    = canvas.CanvasLibraryPage
	UserAssetPage        = canvas.UserAssetPage
	UserAssetPageFilter  = canvas.UserAssetPageFilter
)

func newCanvasHost(service *Service) canvas.Host {
	if service == nil {
		return canvas.NewHost(canvas.HostConfig{})
	}
	return newCanvasHostWithRepo(service, service.repo)
}

func repoHoldsTransaction(repo *repository.Repository) bool { return repo.HoldsTransaction() }

func newCanvasHostWithRepo(service *Service, repo *repository.Repository) canvas.Host {
	if service == nil {
		return canvas.NewHost(canvas.HostConfig{})
	}
	return canvas.NewHost(canvas.HostConfig{
		Repo: repo, EncryptSecret: service.encryptSettingSecret, DecryptSecret: service.decryptSettingSecret,
		OpenResourceRange: service.openResourceRange, PrepareResourceDelivery: service.prepareResourceDelivery,
		LockStorage: func(fn func() error) error { service.storageMu.Lock(); defer service.storageMu.Unlock(); return fn() },
		ResourcePolicy: func(r *repository.Repository) (RuntimeResourcePolicy, error) { p, err := service.runtimePolicyWithRepo(r); return p.Resource, err },
		DeleteUserAssetWithResource: service.deleteUserAssetWithResources, RecordActivity: service.recordActivity,
	})
}

func (s *Service) CanvasService() *canvas.Service { return s.canvasDomain() }
func (s *Service) canvasDomain() *canvas.Service {
	if s == nil {
		return canvas.New(nil, nil)
	}
	if s.canvas != nil {
		return s.canvas
	}
	return canvas.New(s.repo, newCanvasHost(s))
}
func (s *Service) canvasDomainWithTx(tx *gorm.DB) *canvas.Service {
	repo := s.repo.WithTx(tx)
	return s.canvasDomain().WithRepository(repo).WithHost(newCanvasHostWithRepo(s, repo))
}
func (s *Service) validateCanvasMediaAssets(u string, raw json.RawMessage) error                           { return s.canvasDomain().ValidateCanvasMediaAssets(u, raw) }
func (s *Service) UserAssets(u string) ([]json.RawMessage, error)                                          { return s.canvasDomain().UserAssets(u) }
func (s *Service) ReplaceUserAssets(u string, req AssetsSyncRequest) ([]json.RawMessage, error)            { return s.canvasDomain().ReplaceUserAssets(u, req) }
func (s *Service) UserCanvasProjects(u string) ([]json.RawMessage, error)                                  { return s.canvasDomain().UserCanvasProjects(u) }
func (s *Service) Database() *gorm.DB                                                                      { if s == nil || s.repo == nil { return nil }; return s.repo.DB() }
func (s *Service) DataDir() string                                                                         { if s == nil { return "" }; return s.dataDir }
func (s *Service) UpsertUserCanvasFolder(u, id string, raw json.RawMessage) (model.CanvasLibraryFolder, error) { return s.canvasDomain().UpsertUserCanvasFolder(u, id, raw) }
func (s *Service) DeleteUserCanvasFolder(u, id string) error                                               { return s.canvasDomain().DeleteUserCanvasFolder(u, id) }
func (s *Service) UpsertUserCanvasDrawing(u, cid, did string, raw json.RawMessage) (canvas.CanvasDrawingDocument, error) { return s.canvasDomain().UpsertUserCanvasDrawing(u, cid, did, raw) }
func (s *Service) DeleteUserCanvasDrawing(u, cid, did string) error                                        { return s.canvasDomain().DeleteUserCanvasDrawing(u, cid, did) }
func (s *Service) UpdateUserCanvasNodeFieldsWithTx(tx *gorm.DB, u, cid, nid string, p map[string]any, rev int64) (UserDataSummary, error) { return s.canvasDomainWithTx(tx).UpdateUserCanvasNodeFields(u, cid, nid, p, rev) }
func (s *Service) DeleteUserAsset(u, id string, expectedStatus ...string) error                            { return s.canvasDomain().DeleteUserAsset(u, id, expectedStatus...) }
func (s *Service) UpsertUserAsset(u string, raw json.RawMessage) (UserDataSummary, error)                  { return s.canvasDomain().UpsertUserAsset(u, raw) }
func (s *Service) UpsertUserCanvasProject(u string, raw json.RawMessage) (UserDataSummary, error)          { return s.canvasDomain().UpsertUserCanvasProject(u, raw) }
func (s *Service) UserAsset(u, id string) (json.RawMessage, error)                                         { return s.canvasDomain().UserAsset(u, id) }
func (s *Service) UserCanvasProject(u, id string) (json.RawMessage, error)                                 { return s.canvasDomain().UserCanvasProject(u, id) }
func validateSyncedPayload(raw json.RawMessage, label string) error                                        { return canvas.ValidateSyncedPayload(raw, label) }
func containsInlineMediaDataURL(value interface{}) bool                                                    { return canvas.ContainsInlineMediaDataURL(value) }
func assetFromJSON(userID string, raw json.RawMessage) (model.Asset, error)                                { return canvas.AssetFromJSON(userID, raw) }

func (s *Service) BindDomain(tx *gorm.DB) operations.Domain {
	if tx == nil {
		return &operationSession{canvas: s.canvasDomain(), service: s, repo: s.repo}
	}
	return &operationSession{canvas: s.canvasDomainWithTx(tx), service: s, repo: s.repo.WithTx(tx), tx: tx}
}

type operationSession struct {
	canvas  *canvas.Service
	service *Service
	repo    *repository.Repository
	tx      *gorm.DB
}

func (s *operationSession) UserCanvasProject(u, id string) (json.RawMessage, error)                                      { return s.canvas.UserCanvasProject(u, id) }
func (s *operationSession) UserCanvasProjectsPage(u string, p, sz int, pid, q, sort string) (canvas.CanvasLibraryPage, error) { return s.canvas.UserCanvasProjectsPage(u, p, sz, pid, q, sort) }
func (s *operationSession) UserAssetsPage(u string, p, sz int, f canvas.UserAssetPageFilter) (canvas.UserAssetPage, error) { return s.canvas.UserAssetsPage(u, p, sz, f) }
func (s *operationSession) UserAsset(u, id string) (json.RawMessage, error)                                              { return s.canvas.UserAsset(u, id) }
func (s *operationSession) Task(u, id string) (*model.Task, error)                                                       { return s.service.Task(u, id) }
func (s *operationSession) ResolveAssistantGenerationModel(kind, selectedModel string) (operations.AssistantGenerationModel, error) {
	display, modelKey, revision, kindMismatch, err := s.service.ResolveAssistantGenerationModel(kind, selectedModel)
	return operations.AssistantGenerationModel{Display: display, ModelKey: modelKey, Revision: revision, KindMismatch: kindMismatch}, err
}
func (s *operationSession) CreateUserCanvasNodes(u, cid string, d []canvas.NodeDraft, rev int64) (canvas.UserDataSummary, []canvas.CreatedNode, error) { return s.canvas.CreateUserCanvasNodes(u, cid, d, rev) }
func (s *operationSession) PrepareUserCanvasStoryboard(u, cid, nid string, in canvas.StoryboardPreparation, rev int64) (canvas.UserDataSummary, canvas.StoryboardPreparationResult, error) { return s.canvas.PrepareUserCanvasStoryboard(u, cid, nid, in, rev) }
func (s *operationSession) UpdateUserCanvasNodeFields(u, cid, nid string, p map[string]any, rev int64) (canvas.UserDataSummary, error) { return s.canvas.UpdateUserCanvasNodeFields(u, cid, nid, p, rev) }
func (s *operationSession) ConnectUserCanvasNodesAtRevision(u, cid, from, to string, rev int64) (canvas.UserDataSummary, error) { return s.canvas.ConnectUserCanvasNodesAtRevision(u, cid, from, to, rev) }
func (s *operationSession) AppendUserCanvasStoryboardRows(u, cid, nid string, d []canvas.StoryboardRowDraft, rev int64) (canvas.UserDataSummary, []canvas.StoryboardRowIdentity, error) { return s.canvas.AppendUserCanvasStoryboardRows(u, cid, nid, d, rev) }
func (s *operationSession) UpdateUserCanvasStoryboardRows(u, cid, nid string, p []canvas.StoryboardRowPatch, rev int64) (canvas.UserDataSummary, canvas.StoryboardRowUpdate, error) { return s.canvas.UpdateUserCanvasStoryboardRows(u, cid, nid, p, rev) }
func (s *operationSession) RemoveUserCanvasStoryboardRows(u, cid, nid string, ids []string, rev int64) (canvas.UserDataSummary, int, error) { return s.canvas.RemoveUserCanvasStoryboardRows(u, cid, nid, ids, rev) }
func (s *operationSession) CommitUserCanvasDocument(u, cid string, rev int64, doc json.RawMessage) (canvas.UserDataSummary, json.RawMessage, error) { return s.canvas.CommitUserCanvasDocument(u, cid, rev, doc) }
func (s *operationSession) WorkspaceTask(u, id string) (*model.Task, error)                                              { return operations.WorkspaceTask(s.repo, u, id) }
func (s *operationSession) GenerationOutputs(taskID string) ([]localtask.CanonicalOutput, error)                         { return operations.GenerationOutputs(s.repo, taskID) }
func (s *operationSession) OwnedReadyResource(u, rid string) (*model.Resource, error)                                    { return operations.OwnedReadyResource(s.repo, u, rid) }
func (s *operationSession) OwnedAsset(u, aid string) (*model.Asset, error)                                               { return operations.OwnedAsset(s.repo, u, aid) }
func (s *operationSession) BindExistingCanvasNode(userID string, patch canvas.TaskOutputBind) (result canvas.TaskOutputBindResult, err error) {
	patch, task, err := operations.PrepareCanvasNodeBind(s.repo, userID, patch)
	if err != nil {
		return canvas.TaskOutputBindResult{}, err
	}
	if task != nil {
		fields := taskSupportFields(*task)
		fields.NodeID, fields.CanvasID = patch.NodeID, patch.CanvasID
		_, finishTrace := s.service.SupportTrace().Start(taskSupportContext(context.Background(), *task), "canvas.bind", fields)
		defer func() { finishTrace(supportFailureReason(err)) }()
	}
	return s.canvas.BindTaskOutputToExistingNode(userID, patch)
}
func (s *operationSession) UserConversation(u, cid string) (taskbinding.ConversationView, error)                         { return operations.UserConversation(s.repo, s.tx, u, cid) }
func (s *operationSession) AttachConversationMessage(u string, in taskbinding.MessageAttachInput) (taskbinding.ConversationView, error) { return operations.AttachConversationMessage(s.repo, s.tx, u, in) }
func mapConversationAttachError(err error) error                                                                         { return operations.MapConversationAttachError(err) }

var (
	_ operations.DomainBinder = (*Service)(nil)
	_ operations.Domain       = (*operationSession)(nil)
)
