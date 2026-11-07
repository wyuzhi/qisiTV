package canvas

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

const (
	DefaultCanvasDocumentLimitMB  int64 = 64
	MaxCanvasDocumentLimitMB      int64 = 512
	HardRequestMaxBodyBytes       int64 = (MaxCanvasDocumentLimitMB << 20) + (4 << 20)
	canvasDocumentLimitSettingKey       = "canvas_document_limit_mb"
)

var (
	effectiveCanvasDocumentLimitMB atomic.Int64
	canvasDocumentLimitGeneration  atomic.Uint64
)

func init() {
	effectiveCanvasDocumentLimitMB.Store(DefaultCanvasDocumentLimitMB)
}

func EffectiveCanvasDocumentLimitMB() int64 {
	return effectiveCanvasDocumentLimitMB.Load()
}

func SetEffectiveCanvasDocumentLimitMB(limitMB int64) {
	if limitMB < 0 {
		limitMB = DefaultCanvasDocumentLimitMB
	}
	if limitMB > MaxCanvasDocumentLimitMB {
		limitMB = MaxCanvasDocumentLimitMB
	}
	canvasDocumentLimitGeneration.Add(1)
	effectiveCanvasDocumentLimitMB.Store(limitMB)
}

func EffectiveRequestMaxBodyBytes() int64 {
	limitMB := EffectiveCanvasDocumentLimitMB()
	if limitMB <= 0 {
		return HardRequestMaxBodyBytes
	}
	return min(HardRequestMaxBodyBytes, (max(limitMB, DefaultCanvasDocumentLimitMB)<<20)+(4<<20))
}

func (s *Service) hasSystemSettingsTable() bool {
	return s != nil && s.repo != nil && s.repo.DB() != nil && s.repo.DB().Migrator().HasTable(&model.SystemSetting{})
}

func (s *Service) hydrateCanvasDocumentLimitFromDB() {
	if !s.hasSystemSettingsTable() {
		return
	}
	gen := canvasDocumentLimitGeneration.Load()
	if setting, err := s.repo.SystemSetting(canvasDocumentLimitSettingKey); err == nil && setting != nil {
		if parsed, parseErr := strconv.ParseInt(strings.TrimSpace(setting.ValueJSON), 10, 64); parseErr == nil && parsed >= 0 && parsed <= MaxCanvasDocumentLimitMB {
			if canvasDocumentLimitGeneration.Load() == gen {
				effectiveCanvasDocumentLimitMB.Store(parsed)
			}
		}
	}
}

func (s *Service) CanvasDocumentLimitMB() int64 {
	if s.hasSystemSettingsTable() {
		gen := canvasDocumentLimitGeneration.Load()
		if setting, err := s.repo.SystemSetting(canvasDocumentLimitSettingKey); err == nil && setting != nil {
			if parsed, parseErr := strconv.ParseInt(strings.TrimSpace(setting.ValueJSON), 10, 64); parseErr == nil && parsed >= 0 && parsed <= MaxCanvasDocumentLimitMB {
				if canvasDocumentLimitGeneration.Load() == gen {
					effectiveCanvasDocumentLimitMB.Store(parsed)
				}
				return parsed
			}
		}
	}
	return EffectiveCanvasDocumentLimitMB()
}

func (s *Service) UpdateCanvasDocumentLimitMB(limitMB int64) (int64, error) {
	return s.UpdateCanvasDocumentLimitMBBy("owner", limitMB)
}

func (s *Service) UpdateCanvasDocumentLimitMBBy(actorID string, limitMB int64) (int64, error) {
	if limitMB < 0 || limitMB > MaxCanvasDocumentLimitMB {
		return 0, kernel.BadAuthRequest("单画布容量上限必须是 0-512 MB 的整数（0 表示不限制）")
	}
	if strings.TrimSpace(actorID) == "" {
		actorID = "owner"
	}
	if s != nil && s.repo != nil && s.repo.DB() != nil {
		if !s.hasSystemSettingsTable() {
			if err := s.repo.DB().AutoMigrate(&model.SystemSetting{}); err != nil {
				return 0, err
			}
		}
		setting := model.SystemSetting{
			Key:       canvasDocumentLimitSettingKey,
			ValueJSON: strconv.FormatInt(limitMB, 10),
			UpdatedBy: actorID,
		}
		if existing, err := s.repo.SystemSetting(canvasDocumentLimitSettingKey); err == nil && existing != nil {
			setting.CreatedAt = existing.CreatedAt
		}
		if err := s.repo.SaveSystemSetting(&setting); err != nil {
			return 0, err
		}
	}
	canvasDocumentLimitGeneration.Add(1)
	effectiveCanvasDocumentLimitMB.Store(limitMB)
	return limitMB, nil
}

func (s *Service) RequestMaxBodyBytes() int64 {
	limitMB := s.CanvasDocumentLimitMB()
	if limitMB <= 0 {
		return HardRequestMaxBodyBytes
	}
	return min(HardRequestMaxBodyBytes, (max(limitMB, DefaultCanvasDocumentLimitMB)<<20)+(4<<20))
}

type AssetsSyncRequest = asset.AssetsSyncRequest

type UserDataSummary struct {
	ID        string           `json:"id"`
	FolderID  string           `json:"folderId,omitempty"`
	Kind      string           `json:"kind,omitempty"`
	Category  string           `json:"category,omitempty"`
	Status    string           `json:"status,omitempty"`
	Title     string           `json:"title"`
	CreatedAt time.Time        `json:"createdAt"`
	UpdatedAt time.Time        `json:"updatedAt"`
	Revision  int64            `json:"revision,omitempty"`
	SaveAudit *CanvasSaveAudit `json:"-"`
}

type CanvasSaveAudit struct {
	NodesBefore int
	NodesAfter  int
}

func canvasNodeCount(payload string) int {
	var document struct {
		Nodes []json.RawMessage `json:"nodes"`
	}
	_ = json.Unmarshal([]byte(payload), &document)
	return len(document.Nodes)
}

func rawJSONSliceCount(raw json.RawMessage) int {
	if len(raw) == 0 {
		return 0
	}
	var items []json.RawMessage
	_ = json.Unmarshal(raw, &items)
	return len(items)
}

func ensureCanvasGraphArrays(payload map[string]json.RawMessage) {
	for _, key := range []string{"nodes", "connections"} {
		var items []json.RawMessage
		if json.Unmarshal(payload[key], &items) != nil || items == nil {
			payload[key] = json.RawMessage("[]")
		}
	}
}

type UserDataSnapshot struct {
	Assets   []json.RawMessage `json:"assets"`
	Projects []json.RawMessage `json:"projects"`
}

func (s *Service) UserDataSnapshot(userID string) (UserDataSnapshot, error) {
	items, err := s.UserAssets(userID)
	if err != nil {
		return UserDataSnapshot{}, err
	}
	projects, err := s.UserCanvasProjects(userID)
	if err != nil {
		return UserDataSnapshot{}, err
	}
	return UserDataSnapshot{Assets: items, Projects: projects}, nil
}

func (s *Service) UserAssetSummaries(userID string) ([]UserDataSummary, error) {
	items, err := s.Library().UserAssetSummaries(userID)
	if err != nil {
		return nil, err
	}
	result := make([]UserDataSummary, 0, len(items))
	for _, item := range items {
		result = append(result, userDataSummaryFromAsset(item))
	}
	return result, nil
}

func (s *Service) UserAsset(userID string, id string) (json.RawMessage, error) {
	return s.Library().UserAsset(userID, id)
}

func (s *Service) UpsertUserAsset(userID string, raw json.RawMessage) (UserDataSummary, error) {
	item, err := s.Library().UpsertUserAsset(userID, raw)
	if err != nil {
		return UserDataSummary{}, err
	}
	return userDataSummaryFromAsset(item), nil
}

func (s *Service) DeleteUserAsset(userID string, id string, expectedStatus ...string) error {
	return s.Library().DeleteUserAsset(userID, id, expectedStatus...)
}

func (s *Service) UserAssets(userID string) ([]json.RawMessage, error) {
	return s.Library().UserAssets(userID)
}

func (s *Service) ReplaceUserAssets(userID string, req AssetsSyncRequest) ([]json.RawMessage, error) {
	return s.Library().ReplaceUserAssets(userID, req)
}

func (s *Service) UserCanvasProjects(userID string) ([]json.RawMessage, error) {
	projects, err := s.repo.CanvasProjects(userID)
	if err != nil {
		return nil, err
	}
	result := make([]json.RawMessage, 0, len(projects))
	for _, project := range projects {
		if strings.TrimSpace(project.PayloadJSON) != "" {
			payload, err := canvasProjectPayload(project)
			if err != nil {
				return nil, err
			}
			result = append(result, payload)
		}
	}
	return result, nil
}

func (s *Service) UserCanvasProjectSummaries(userID string) ([]UserDataSummary, error) {
	projects, err := s.repo.CanvasProjectSummaries(userID)
	if err != nil {
		return nil, err
	}
	result := make([]UserDataSummary, 0, len(projects))
	for _, project := range projects {
		result = append(result, UserDataSummary{ID: project.ID, FolderID: project.LibraryFolderID, Title: project.Title, CreatedAt: project.CreatedAt, UpdatedAt: project.UpdatedAt, Revision: project.Revision})
	}
	return result, nil
}

func (s *Service) UserCanvasProject(userID string, id string) (json.RawMessage, error) {
	project, err := s.repo.CanvasProjectForUser(userID, id)
	if err != nil {
		return nil, err
	}
	return canvasProjectPayload(*project)
}

func (s *Service) UpsertUserCanvasProject(userID string, raw json.RawMessage) (UserDataSummary, error) {
	return s.upsertUserCanvasProjectWithHistory(userID, raw, "automatic")
}

func (s *Service) upsertUserCanvasProjectWithHistory(userID string, raw json.RawMessage, reason string) (UserDataSummary, error) {
	return s.upsertUserCanvasProjectWithAssets(userID, raw, nil, reason)
}

func (s *Service) upsertUserCanvasProjectWithAssets(userID string, raw json.RawMessage, candidateAssets []model.Asset, reason string) (UserDataSummary, error) {
	summary, _, err := s.upsertUserCanvasProjectAndPayload(userID, raw, candidateAssets, reason, false)
	return summary, err
}

func (s *Service) upsertUserCanvasProjectAndPayload(userID string, raw json.RawMessage, candidateAssets []model.Asset, reason string, includePayload bool) (UserDataSummary, json.RawMessage, error) {
	var version struct {
		Revision *int64 `json:"revision"`
	}
	if err := json.Unmarshal(raw, &version); err != nil {
		return UserDataSummary{}, nil, kernel.BadAuthRequest("画布版本格式错误")
	}
	if version.Revision == nil {
		return UserDataSummary{}, nil, kernel.NewAppError(http.StatusPreconditionRequired, "缺少画布版本，请保留本地草稿后重新加载画布")
	}
	if *version.Revision < 0 || *version.Revision >= 9007199254740991 {
		return UserDataSummary{}, nil, kernel.BadAuthRequest("画布版本无效")
	}
	_ = s.CanvasDocumentLimitMB()
	project, err := canvasProjectFromJSON(userID, raw)
	if err != nil {
		return UserDataSummary{}, nil, err
	}
	var audit CanvasSaveAudit
	var payload map[string]json.RawMessage
	var afterPayload json.RawMessage
	createdAssets := 0
	err = s.host.WithStorageLock(func() error {
		existing, existingErr := s.repo.CanvasProjectForUser(userID, project.ID)
		if existingErr != nil && !errors.Is(existingErr, gorm.ErrRecordNotFound) {
			return existingErr
		}
		if err := s.validateCanvasMediaAssetsWithBaseline(userID, raw, existing, candidateAssets); err != nil {
			return err
		}
		if len(candidateAssets) > 0 {
			created, err := s.Library().PrepareAssetWrites(userID, candidateAssets)
			if err != nil {
				return err
			}
			createdAssets = created
		}
		if err := s.requireCanvasLibraryFolder(userID, project.LibraryFolderID); err != nil {
			return err
		}
		existingBytes := int64(0)
		project.Revision = *version.Revision
		project.UpdatedAt = time.Now().UTC()
		if existing != nil {
			existingBytes = int64(len([]byte(existing.PayloadJSON)))
			project.CreatedAt = existing.CreatedAt
		}
		if (existing == nil && project.Revision != 0) || (existing != nil && project.Revision != existing.Revision) {
			return canvasRevisionConflict()
		}
		payload = nil
		if err := json.Unmarshal(raw, &payload); err != nil {
			return err
		}
		delete(payload, "revision")
		delete(payload, "remoteContentHash")
		ensureCanvasGraphArrays(payload)
		payload["viewport"] = json.RawMessage(`{"x":0,"y":0,"k":1}`)
		var previous map[string]json.RawMessage
		if existing != nil {
			if json.Unmarshal([]byte(existing.PayloadJSON), &previous) == nil && previous["viewport"] != nil {
				payload["viewport"] = previous["viewport"]
			}
		}
		payload["createdAt"], _ = json.Marshal(project.CreatedAt)
		payload["updatedAt"], _ = json.Marshal(project.UpdatedAt)
		cleaned, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		project.PayloadJSON = string(cleaned)
		if err := s.host.StructuredQuota(userID, "canvas", errors.Is(existingErr, gorm.ErrRecordNotFound), int64(len(cleaned))-existingBytes); err != nil {
			return err
		}
		nodesAfter := rawJSONSliceCount(payload["nodes"])
		nodesBefore := 0
		if existing != nil {
			nodesBefore = rawJSONSliceCount(previous["nodes"])
		}
		if err := s.repo.Transaction(func(tx *repository.Repository) error {
			if len(candidateAssets) > 0 {
				if _, err := s.Library().WithRepository(tx).PersistPreparedAssets(userID, candidateAssets); err != nil {
					return err
				}
			}
			if err := SaveDocumentWithHistory(tx, existing, &project, reason); err != nil {
				if errors.Is(err, repository.ErrCanvasRevisionConflict) {
					return canvasRevisionConflict()
				}
				if errors.Is(err, repository.ErrCanvasHistoryResourceMissing) {
					return kernel.NewAppError(http.StatusConflict, "画布引用的素材已变化，当前内容未被覆盖，请保留草稿并重新加载")
				}
				if errors.Is(err, repository.ErrCanvasLibraryFolderMissing) {
					return kernel.BadAuthRequest("画布文件夹不存在")
				}
				return err
			}
			audit.NodesAfter = nodesAfter
			audit.NodesBefore = nodesBefore
			if existingErr != nil || existing.PayloadJSON != project.PayloadJSON || existing.Title != project.Title {
				s.host.RecordActivity(userID, "canvas", 1)
			}
			return nil
		}); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return UserDataSummary{}, nil, err
	}
	if includePayload {
		for key, value := range map[string]any{"id": project.ID, "title": project.Title, "projectId": project.ProjectID, "folderId": project.LibraryFolderID, "revision": project.Revision, "createdAt": project.CreatedAt, "updatedAt": project.UpdatedAt} {
			encoded, err := json.Marshal(value)
			if err != nil {
				return UserDataSummary{}, nil, err
			}
			payload[key] = encoded
		}
		afterPayload, err = json.Marshal(payload)
		if err != nil {
			return UserDataSummary{}, nil, err
		}
	}
	if createdAssets > 0 {
		s.host.RecordActivity(userID, "asset", createdAssets)
	}
	return UserDataSummary{ID: project.ID, Title: project.Title, CreatedAt: project.CreatedAt, UpdatedAt: project.UpdatedAt, Revision: project.Revision, SaveAudit: &audit}, afterPayload, nil
}

func (s *Service) DeleteUserCanvasProject(userID string, id string) error {
	return s.repo.DeleteCanvasProject(userID, id)
}

func AssetFromJSON(userID string, raw json.RawMessage) (model.Asset, error) {
	return asset.AssetFromJSON(userID, raw)
}

func userDataSummaryFromAsset(item asset.Summary) UserDataSummary {
	return UserDataSummary{
		ID: item.ID, FolderID: item.FolderID, Kind: item.Kind, Category: item.Category,
		Status: item.Status, Title: item.Title, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt,
	}
}

func canvasProjectFromJSON(userID string, raw json.RawMessage) (model.CanvasProject, error) {
	if err := ValidateSyncedPayload(raw, "画布"); err != nil {
		return model.CanvasProject{}, err
	}
	var payload struct {
		ID        string `json:"id"`
		Title     string `json:"title"`
		ProjectID string `json:"projectId"`
		FolderID  string `json:"folderId"`
		CreatedAt string `json:"createdAt"`
		UpdatedAt string `json:"updatedAt"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return model.CanvasProject{}, kernel.BadAuthRequest("画布数据格式错误")
	}
	now := time.Now()
	createdAt := parseClientTime(payload.CreatedAt, now)
	updatedAt := parseClientTime(payload.UpdatedAt, createdAt)
	id := strings.TrimSpace(payload.ID)
	if id == "" {
		id = kernel.NewID()
	}
	return model.CanvasProject{
		ID:              id,
		UserID:          userID,
		ProjectID:       strings.TrimSpace(payload.ProjectID),
		LibraryFolderID: strings.TrimSpace(payload.FolderID),
		Title:           strings.TrimSpace(payload.Title),
		PayloadJSON:     string(raw),
		CreatedAt:       createdAt,
		UpdatedAt:       updatedAt,
	}, nil
}

func ValidateSyncedPayload(raw json.RawMessage, label string) error {
	return asset.ValidateSyncedPayloadWithLimit(raw, label, int(EffectiveCanvasDocumentLimitMB()))
}

func ContainsInlineMediaDataURL(value interface{}) bool {
	return asset.ContainsInlineMediaDataURL(value)
}

func parseClientTime(value string, fallback time.Time) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed
	}
	return fallback
}
