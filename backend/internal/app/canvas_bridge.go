package app

import (
	"encoding/json"
	"errors"
	"time"

	"qisitv/backend/internal/assets"
	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
)

type (
	AssetsSyncRequest       = canvas.AssetsSyncRequest
	CanvasHistoryList       = canvas.CanvasHistoryList
	UserDataSummary         = canvas.UserDataSummary
	UserDataSnapshot        = canvas.UserDataSnapshot
	CanvasLibrarySummary    = canvas.CanvasLibrarySummary
	CanvasLibraryPage       = canvas.CanvasLibraryPage
	CanvasOperationsRequest = canvas.CanvasOperationsRequest
	CanvasInteraction       = canvas.CanvasInteraction
)

type canvasHost struct {
	encryptSecret              func(string) (string, error)
	decryptSecret              func(string) (string, error)
	openResourceRange          func(string, *model.Resource, string) (*assets.ResourceStream, error)
	prepareResourceDelivery    func(string, *model.Resource, assets.ResourceDeliveryOptions) (*assets.ResourceDelivery, error)
	withStorageLock            func(func() error) error
	structuredQuota            func(string, string, bool, int64) error
	structuredReplacementQuota func(string, string, int, int64) error
	deleteAsset                func(string, string) error
	recordActivity             func(string, string, int)
}

func (h canvasHost) EncryptSecret(value string) (string, error) {
	if h.encryptSecret == nil {
		return value, nil
	}
	return h.encryptSecret(value)
}

func (h canvasHost) DecryptSecret(value string) (string, error) {
	if h.decryptSecret == nil {
		return value, nil
	}
	return h.decryptSecret(value)
}

func (h canvasHost) OpenResourceRange(userID string, resource *model.Resource, rangeHeader string) (*assets.ResourceStream, error) {
	if h.openResourceRange == nil {
		return nil, nil
	}
	return h.openResourceRange(userID, resource, rangeHeader)
}

func (h canvasHost) PrepareResourceDelivery(userID string, resource *model.Resource, options assets.ResourceDeliveryOptions) (*assets.ResourceDelivery, error) {
	if h.prepareResourceDelivery == nil {
		return nil, nil
	}
	return h.prepareResourceDelivery(userID, resource, options)
}

func (h canvasHost) WithStorageLock(fn func() error) error {
	if h.withStorageLock == nil {
		if fn == nil {
			return nil
		}
		return fn()
	}
	return h.withStorageLock(fn)
}

func (h canvasHost) StructuredQuota(userID, kind string, creating bool, deltaBytes int64) error {
	if h.structuredQuota == nil {
		return nil
	}
	return h.structuredQuota(userID, kind, creating, deltaBytes)
}

func (h canvasHost) StructuredReplacementQuota(userID, kind string, count int, bytes int64) error {
	if h.structuredReplacementQuota == nil {
		return nil
	}
	return h.structuredReplacementQuota(userID, kind, count, bytes)
}

func (h canvasHost) DeleteUserAssetWithResources(userID, assetID string) error {
	if h.deleteAsset == nil {
		return nil
	}
	return h.deleteAsset(userID, assetID)
}

func (h canvasHost) RecordActivity(userID, event string, count int) {
	if h.recordActivity == nil {
		return
	}
	h.recordActivity(userID, event, count)
}

func newCanvasHost(service *Service) canvasHost {
	if service == nil {
		return canvasHost{}
	}
	return canvasHost{
		encryptSecret: service.encryptSettingSecret, decryptSecret: service.decryptSettingSecret,
		openResourceRange: service.openResourceRange, prepareResourceDelivery: service.prepareResourceDelivery,
		withStorageLock: func(fn func() error) error {
			service.storageMu.Lock()
			defer service.storageMu.Unlock()
			return fn()
		},
		structuredQuota: func(userID, kind string, creating bool, deltaBytes int64) error {
			policy, err := service.RuntimePolicy()
			if err != nil {
				return err
			}
			usage, err := service.repo.UserStorageUsage(userID)
			if err != nil {
				return err
			}
			return validateStructuredStorageQuotaWithPolicy(usage, kind, creating, deltaBytes, policy.Resource)
		},
		structuredReplacementQuota: func(userID, kind string, count int, bytes int64) error {
			policy, err := service.RuntimePolicy()
			if err != nil {
				return err
			}
			usage, err := service.repo.UserStorageUsage(userID)
			if err != nil {
				return err
			}
			return validateStructuredReplacementQuotaWithPolicy(usage, kind, count, bytes, policy.Resource)
		},
		deleteAsset: service.deleteUserAssetWithResources, recordActivity: service.recordActivity,
	}
}

func (s *Service) canvasDomain() *canvas.Service {
	if s == nil {
		return canvas.New(nil, nil)
	}
	if s.canvas != nil {
		return s.canvas
	}
	return canvas.New(s.repo, newCanvasHost(s))
}

func (s *Service) validateCanvasMediaAssets(userID string, raw json.RawMessage) error {
	return s.canvasDomain().ValidateCanvasMediaAssets(userID, raw)
}

func (s *Service) validateAssetCanvasReferences(userID string, asset model.Asset) error {
	return s.canvasDomain().ValidateAssetCanvasReferences(userID, asset)
}

func (s *Service) validateAssetReplacementCanvasReferences(userID string, replacement []model.Asset) error {
	return s.canvasDomain().ValidateAssetReplacementCanvasReferences(userID, replacement)
}

func (s *Service) UserDataSnapshot(userID string) (UserDataSnapshot, error) {
	return s.canvasDomain().UserDataSnapshot(userID)
}

func (s *Service) UserAssetSummaries(userID string) ([]UserDataSummary, error) {
	return s.canvasDomain().UserAssetSummaries(userID)
}

func (s *Service) UserAsset(userID string, id string) (json.RawMessage, error) {
	return s.canvasDomain().UserAsset(userID, id)
}

func (s *Service) UpsertUserAsset(userID string, raw json.RawMessage) (UserDataSummary, error) {
	return s.canvasDomain().UpsertUserAsset(userID, raw)
}

func (s *Service) DeleteUserAsset(userID string, id string) error {
	return s.canvasDomain().DeleteUserAsset(userID, id)
}

func (s *Service) UserAssets(userID string) ([]json.RawMessage, error) {
	return s.canvasDomain().UserAssets(userID)
}

func (s *Service) ReplaceUserAssets(userID string, req AssetsSyncRequest) ([]json.RawMessage, error) {
	return s.canvasDomain().ReplaceUserAssets(userID, req)
}

func (s *Service) UserCanvasProjects(userID string) ([]json.RawMessage, error) {
	return s.canvasDomain().UserCanvasProjects(userID)
}

func (s *Service) UserCanvasProjectSummaries(userID string) ([]UserDataSummary, error) {
	return s.canvasDomain().UserCanvasProjectSummaries(userID)
}

func (s *Service) UserCanvasProject(userID string, id string) (json.RawMessage, error) {
	return s.canvasDomain().UserCanvasProject(userID, id)
}

func (s *Service) ApplyCanvasOperations(userID, canvasID string, req CanvasOperationsRequest) (json.RawMessage, error) {
	return s.canvasDomain().ApplyCanvasOperations(userID, canvasID, req)
}

func (s *Service) PutCanvasInteraction(userID, canvasID string, value CanvasInteraction) (*CanvasInteraction, error) {
	return s.canvasDomain().PutCanvasInteraction(userID, canvasID, value)
}

func (s *Service) GetCanvasInteraction(userID, canvasID, tabID string) (*CanvasInteraction, error) {
	return s.canvasDomain().GetCanvasInteraction(userID, canvasID, tabID)
}

func (s *Service) UpsertUserCanvasProject(userID string, raw json.RawMessage) (UserDataSummary, error) {
	return s.canvasDomain().UpsertUserCanvasProject(userID, raw)
}

func (s *Service) CommitUserCanvasProjectAssets(userID string, raw json.RawMessage, assets []json.RawMessage) (UserDataSummary, error) {
	return s.canvasDomain().CommitUserCanvasProjectAssets(userID, raw, assets)
}

func (s *Service) DeleteUserCanvasNode(userID, canvasID, nodeID string) (UserDataSummary, error) {
	return s.canvasDomain().DeleteUserCanvasNode(userID, canvasID, nodeID)
}

func (s *Service) UpdateUserCanvasNode(userID, canvasID, nodeID string, patch map[string]json.RawMessage) (UserDataSummary, error) {
	return s.canvasDomain().UpdateUserCanvasNode(userID, canvasID, nodeID, patch)
}

func (s *Service) ConnectUserCanvasNodes(userID, canvasID, fromNodeID, toNodeID string, connection map[string]json.RawMessage) (UserDataSummary, error) {
	return s.canvasDomain().ConnectUserCanvasNodes(userID, canvasID, fromNodeID, toNodeID, connection)
}

func (s *Service) DeleteUserCanvasProject(userID string, id string) error {
	return s.canvasDomain().DeleteUserCanvasProject(userID, id)
}

func (s *Service) CanvasHistory(userID, canvasID string) (CanvasHistoryList, error) {
	return s.canvasDomain().CanvasHistory(userID, canvasID)
}

func (s *Service) CanvasHistorySnapshot(userID, canvasID, snapshotID string) (*model.CanvasSnapshot, error) {
	return s.canvasDomain().CanvasHistorySnapshot(userID, canvasID, snapshotID)
}

func (s *Service) RestoreCanvasHistory(userID, canvasID, snapshotID string, revision *int64) (UserDataSummary, error) {
	return s.canvasDomain().RestoreCanvasHistory(userID, canvasID, snapshotID, revision)
}

func saveCreationCanvasWithHistory(repo *repository.Repository, project *model.CanvasProject, previous string) error {
	before, err := repo.CanvasProjectForUser(project.UserID, project.ID)
	if err != nil {
		return err
	}
	if before.PayloadJSON != previous || before.Revision != project.Revision {
		return repository.ErrCreationConflict
	}
	project.UpdatedAt = time.Now().UTC()
	err = canvas.SaveDocumentWithHistory(repo, before, project, "automatic")
	if errors.Is(err, repository.ErrCanvasRevisionConflict) {
		return repository.ErrCreationConflict
	}
	return err
}

func (s *Service) UserAssetsByIDs(userID string, ids []string) ([]json.RawMessage, error) {
	return s.canvasDomain().UserAssetsByIDs(userID, ids)
}

func (s *Service) UserCanvasProjectsPage(userID string, page int, pageSize int, projectID string, search string, sort string) (CanvasLibraryPage, error) {
	return s.canvasDomain().UserCanvasProjectsPage(userID, page, pageSize, projectID, search, sort)
}

func clientAssetPayload(asset model.Asset) json.RawMessage {
	return canvas.ClientAssetPayload(asset)
}

func validateSyncedPayload(raw json.RawMessage, label string) error {
	return canvas.ValidateSyncedPayload(raw, label)
}

func containsInlineMediaDataURL(value interface{}) bool {
	return canvas.ContainsInlineMediaDataURL(value)
}

func assetFromJSON(userID string, raw json.RawMessage) (model.Asset, error) {
	return canvas.AssetFromJSON(userID, raw)
}
