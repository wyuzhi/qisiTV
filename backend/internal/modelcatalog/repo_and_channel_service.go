package modelcatalog

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/provider"
	"qisitv/backend/internal/provider/bailian"
	"qisitv/backend/internal/repository"

	"gorm.io/gorm"
)

type repoCatalogLoader struct {
	repo *repository.Repository
}

func NewRepoCatalogLoader(repo *repository.Repository) CatalogLoader {
	return repoCatalogLoader{repo: repo}
}

func (l repoCatalogLoader) Load(ctx context.Context) ([]model.LogicalModel, map[string]LogicalModelGraph, []model.ModelChannel, error) {
	if l.repo == nil {
		return nil, nil, nil, errors.New("repository unavailable")
	}
	repo := l.repo.WithContext(ctx)
	items, err := repo.LogicalModels(false)
	if err != nil {
		return nil, nil, nil, err
	}
	graphs, err := repo.LogicalModelGraphs(items, false)
	if err != nil {
		return nil, nil, nil, err
	}
	systemChannelIDs := make([]string, 0)
	converted := make(map[string]LogicalModelGraph, len(graphs))
	for id, graph := range graphs {
		if graph == nil {
			continue
		}
		converted[id] = CatalogGraphFromRepo(graph)
		for _, channelModel := range graph.ChannelModels {
			systemChannelIDs = append(systemChannelIDs, channelModel.ChannelID)
		}
	}
	systemChannels, err := repo.SystemChannelsByIDs(systemChannelIDs, false)
	if err != nil {
		return nil, nil, nil, err
	}
	return items, converted, systemChannels, nil
}

func CatalogGraphFromRepo(graph *repository.LogicalModelGraph) LogicalModelGraph {
	if graph == nil {
		return LogicalModelGraph{}
	}
	return LogicalModelGraph{Model: graph.Model, Revision: graph.Revision, Routes: graph.Routes, ChannelModels: graph.ChannelModels}
}

type repoRouteStore struct {
	repo *repository.Repository
}

func NewRepoRouteStore(repo *repository.Repository) RouteStore {
	return repoRouteStore{repo: repo}
}

func (s repoRouteStore) NextPrefixedID(prefix string) (string, error) {
	return s.repo.NextPrefixedID(prefix)
}
func (s repoRouteStore) CreateRouteAttempt(item *model.RouteAttempt) error {
	return s.repo.CreateRouteAttempt(item)
}
func (s repoRouteStore) SaveRouteAttempt(item *model.RouteAttempt) error {
	return s.repo.SaveRouteAttempt(item)
}
func (s repoRouteStore) MarkRouteAttemptDispatching(id string) error {
	return s.repo.MarkRouteAttemptDispatching(id)
}
func (s repoRouteStore) RouteAttempts(taskID string, routeRun int) ([]model.RouteAttempt, error) {
	return s.repo.RouteAttempts(taskID, routeRun)
}
func (s repoRouteStore) ChannelModelByID(channelID, id string) (*model.ChannelModel, error) {
	return s.repo.ChannelModelByID(channelID, id)
}
func (s repoRouteStore) ChannelModel(id string) (*model.ChannelModel, error) {
	return s.repo.ChannelModel(id)
}
func (s repoRouteStore) LogicalModel(id string) (*model.LogicalModel, error) {
	return s.repo.LogicalModel(id)
}
func (s repoRouteStore) LogicalModelRevision(id string) (*model.LogicalModelRevision, error) {
	return s.repo.LogicalModelRevision(id)
}
func (s repoRouteStore) LogicalModelRoute(id string) (*model.LogicalModelRoute, error) {
	return s.repo.LogicalModelRoute(id)
}
func (s repoRouteStore) LogicalModelRoutes(revisionID string, includeDisabled bool) ([]model.LogicalModelRoute, error) {
	return s.repo.LogicalModelRoutes(revisionID, includeDisabled)
}
func (s repoRouteStore) ChannelModelsByIDs(ids []string) ([]model.ChannelModel, error) {
	return s.repo.ChannelModelsByIDs(ids)
}
func (s repoRouteStore) SystemChannel(id string) (*model.ModelChannel, error) {
	return s.repo.SystemChannel(id)
}
func (s repoRouteStore) SystemChannelsByIDs(ids []string, includeDisabled bool) ([]model.ModelChannel, error) {
	return s.repo.SystemChannelsByIDs(ids, includeDisabled)
}
func (s repoRouteStore) SwitchTaskLogicalRoute(taskID, expectedRouteID, routeID, inputJSON, channelModelID string) error {
	return s.repo.SwitchTaskLogicalRoute(taskID, expectedRouteID, routeID, inputJSON, channelModelID)
}
func (s repoRouteStore) UpdateTaskProviderState(taskID, providerRequestID, pollStage string, nextPollAt *time.Time) error {
	return s.repo.UpdateTaskProviderState(taskID, providerRequestID, pollStage, nextPollAt)
}

func ImageSubmissionViewFromRepo(repo *repository.Repository, attempt *model.RouteAttempt, task *model.Task) ImageSubmissionView {
	if repo == nil || attempt == nil || task == nil {
		return ImageSubmissionView{}
	}
	row, err := repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if err == nil {
		return ImageSubmissionView{Found: true, Accepted: row.ResponseAccepted}
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ImageSubmissionView{}
	}
	return ImageSubmissionView{Err: err}
}

var pluginsInitOnce sync.Once

func InitModelCatalogPlugins() {
	pluginsInitOnce.Do(func() {
		provider.Register(bailian.New())
	})
}

func ExtraChannelModelCatalogItems(baseURL, apiFormat string, headers []ChannelHeader) []ChannelModelCatalogItem {
	InitModelCatalogPlugins()
	discovery := provider.MatchProvider(baseURL, OutboundHeadersMap(headers))
	if discovery == nil {
		return nil
	}
	extra := discovery.AdditionalModels(provider.DiscoveryConfig{
		BaseURL:   baseURL,
		APIFormat: apiFormat,
		Headers:   OutboundHeadersMap(headers),
		Region:    ModelCatalogRegion(baseURL),
	})
	if len(extra) == 0 {
		return nil
	}
	items := make([]ChannelModelCatalogItem, 0, len(extra))
	for _, modelItem := range extra {
		item := ProviderCatalogItem(modelItem)
		if item.ID == "" {
			continue
		}
		items = append(items, item)
	}
	return items
}

func ProviderCatalogItem(item provider.Model) ChannelModelCatalogItem {
	modelType := ""
	for _, capability := range item.Capability {
		if normalized := NormalizeCatalogModelType(capability); normalized != "" {
			modelType = normalized
			break
		}
	}
	return ChannelModelCatalogItem{
		ID:                     strings.TrimPrefix(strings.TrimSpace(item.ID), "models/"),
		DisplayName:            strings.TrimSpace(item.DisplayName),
		ModelType:              modelType,
		SupportedEndpointTypes: NormalizeCatalogEndpointTypes(item.SupportedEndpointTypes),
	}
}

func OutboundHeadersMap(headers []ChannelHeader) map[string]string {
	result := make(map[string]string, len(headers))
	for _, header := range headers {
		result[header.Name] = header.Value
	}
	return result
}

func ModelCatalogRegion(baseURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	if strings.Contains(host, "dashscope-us") {
		return "us-east-1"
	}
	if strings.Contains(host, "ap-southeast-1") {
		return "ap-southeast-1"
	}
	return "cn-beijing"
}

func IsPluginEnabled() bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv("ENABLE_PROVIDER_PLUGINS")))
	return value == "true" || value == "1"
}

type ChannelOrderItem struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

type ChannelOrderRequest struct {
	IDs         []string `json:"ids"`
	ExpectedIDs []string `json:"expectedIds"`
}

func AdminChannelOrder(repo *repository.Repository, requireAdmin func(*model.User) error, actor *model.User, channelID string) ([]ChannelOrderItem, error) {
	if err := requireAdmin(actor); err != nil {
		return nil, err
	}
	result := []ChannelOrderItem{}
	if channelID == "" {
		rows, err := repo.SystemChannels(true)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			result = append(result, ChannelOrderItem{row.ID, row.Name, row.Enabled})
		}
	} else {
		if _, err := repo.AdminSystemChannel(channelID); err != nil {
			return nil, err
		}
		rows, err := repo.ChannelModels(channelID, true)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			result = append(result, ChannelOrderItem{row.ID, kernel.FirstNonEmpty(row.DisplayName, row.ModelKey), row.Enabled})
		}
	}
	return result, nil
}

func SaveAdminChannelOrder(repo *repository.Repository, requireAdmin func(*model.User) error, actor *model.User, channelID string, req ChannelOrderRequest, invalidate func()) error {
	if err := requireAdmin(actor); err != nil {
		return err
	}
	if req.IDs == nil || req.ExpectedIDs == nil || len(req.IDs) > 10000 {
		return kernel.BadAuthRequest("请重新加载完整排序列表")
	}
	err := repo.SaveChannelOrder(channelID, req.IDs, req.ExpectedIDs)
	if errors.Is(err, repository.ErrChannelOrderChanged) {
		return kernel.NewAppError(http.StatusConflict, err.Error())
	}
	if err == nil && invalidate != nil {
		invalidate()
	}
	return err
}

type ChannelModelSortRequest struct {
	SortOrder *int `json:"sortOrder"`
}

func UpdateChannelPresentation(repo *repository.Repository, id string, req ChannelRequest, invalidate func()) (*PublicModelChannel, error) {
	if err := ApplyChannelPresentation(req); err != nil {
		return nil, err
	}
	if req.PublicAlias != nil {
		alias := strings.TrimSpace(*req.PublicAlias)
		req.PublicAlias = &alias
	}
	if err := repo.UpdateSystemChannelPresentation(id, req.PublicAlias, req.SortOrder, time.Now()); err != nil {
		return nil, err
	}
	if invalidate != nil {
		invalidate()
	}
	channel, err := repo.AdminSystemChannel(id)
	if err != nil {
		return nil, err
	}
	items, err := repo.ChannelModels(id, true)
	if err != nil {
		return nil, err
	}
	public := PublicChannel(*channel, true, items)
	return &public, nil
}

func UpdateAdminChannelModelSort(repo *repository.Repository, requireAdmin func(*model.User) error, actor *model.User, channelID, modelID string, req ChannelModelSortRequest, invalidate func()) error {
	if err := requireAdmin(actor); err != nil {
		return err
	}
	if req.SortOrder == nil {
		return kernel.BadAuthRequest("请填写排序值")
	}
	if err := ValidateChannelSortOrder(*req.SortOrder); err != nil {
		return err
	}
	if _, err := repo.AdminSystemChannel(channelID); err != nil {
		return err
	}
	if err := repo.UpdateChannelModelSort(channelID, modelID, *req.SortOrder, time.Now()); err != nil {
		return err
	}
	if invalidate != nil {
		invalidate()
	}
	return nil
}

func BuildModelCatalogResponse(frontendEnabled bool, publicLogical func(*ModelRequestIntent) ([]PublicLogicalModel, error), publicSystem func(*ModelRequestIntent) ([]PublicChannelCatalog, error), intent *ModelRequestIntent) (*CatalogResponse, error) {
	if frontendEnabled {
		models, err := publicLogical(intent)
		if err != nil {
			return nil, err
		}
		response := NewCatalogResponse(CatalogSourceFrontend, models, nil)
		return &response, nil
	}
	channels, err := publicSystem(intent)
	if err != nil {
		return nil, err
	}
	response := NewCatalogResponse(CatalogSourceSystem, nil, channels)
	return &response, nil
}

func PublicSystemChannelCatalogFromRepo(repo *repository.Repository, intent *ModelRequestIntent) ([]PublicChannelCatalog, error) {
	channels, err := repo.SystemChannels(true)
	if err != nil {
		return nil, err
	}
	return PublicSystemChannelCatalog(channels, func(channelID string) ([]model.ChannelModel, error) {
		return repo.ChannelModels(channelID, false)
	}, intent)
}

func AdminLogicalModelsFromRepo(repo *repository.Repository, requireAdmin func(*model.User) error, actor *model.User) ([]AdminLogicalModel, error) {
	if err := requireAdmin(actor); err != nil {
		return nil, err
	}
	items, err := repo.LogicalModels(true)
	if err != nil {
		return nil, err
	}
	graphs, err := repo.LogicalModelGraphs(items, true)
	if err != nil {
		return nil, err
	}
	systemChannelIDs := make([]string, 0)
	for _, graph := range graphs {
		if graph == nil {
			continue
		}
		for _, channelModel := range graph.ChannelModels {
			systemChannelIDs = append(systemChannelIDs, channelModel.ChannelID)
		}
	}
	systemChannels, err := repo.SystemChannelsByIDs(systemChannelIDs, true)
	if err != nil {
		return nil, err
	}
	systemChannelByID := make(map[string]model.ModelChannel, len(systemChannels))
	for _, channel := range systemChannels {
		systemChannelByID[channel.ID] = channel
	}
	result := make([]AdminLogicalModel, 0, len(items))
	for _, item := range items {
		graph := graphs[item.ID]
		if graph == nil || graph.Revision == nil {
			continue
		}
		admin, buildErr := BuildAdminLogicalModel(item, CatalogGraphFromRepo(graph), systemChannelByID)
		if buildErr != nil {
			return nil, buildErr
		}
		result = append(result, *admin)
	}
	return result, nil
}

func LogicalModelBundleFromRepo(repo *repository.Repository, actor *model.User, id string, req LogicalModelRequest) (*model.LogicalModel, *model.LogicalModelRevision, []model.LogicalModelRoute, bool, error) {
	actorID := ""
	if actor != nil {
		actorID = actor.ID
	}
	return PrepareLogicalModelBundle(id, req, LogicalBundleDeps{
		ChannelModel:       repo.ChannelModel,
		SystemChannel:      repo.SystemChannel,
		AdminSystemChannel: repo.AdminSystemChannel,
		LogicalModel:       repo.LogicalModel,
		NextID:             repo.NextPrefixedID,
		Now:                time.Now(),
		ActorID:            actorID,
	})
}

func SaveAdminLogicalModelInRepo(
	repo *repository.Repository,
	requireAdmin func(*model.User) error,
	actor *model.User,
	id string,
	req LogicalModelRequest,
	invalidate func(),
	appendAudit func(actor *model.User, action, targetType, targetID, summary string, detail any) error,
) (*AdminLogicalModel, error) {
	if err := requireAdmin(actor); err != nil {
		return nil, err
	}
	item, revision, routes, creating, err := LogicalModelBundleFromRepo(repo, actor, id, req)
	if err != nil {
		return nil, err
	}
	if err := repo.SaveLogicalModelBundle(item, revision, routes, creating); err != nil {
		return nil, err
	}
	if invalidate != nil {
		invalidate()
	}
	if appendAudit != nil {
		if err := appendAudit(actor, map[bool]string{true: "logical_model.create", false: "logical_model.update"}[creating], "logical_model", item.ID, "保存前台模型及供应线路", map[string]any{"revisionId": revision.ID, "routeCount": len(routes)}); err != nil {
			return nil, err
		}
	}
	graph, err := repo.LogicalModelGraph(item.ID, true)
	if err != nil {
		return nil, err
	}
	channelIDs := make([]string, 0, len(graph.ChannelModels))
	for _, channelModel := range graph.ChannelModels {
		channelIDs = append(channelIDs, channelModel.ChannelID)
	}
	systemChannels, err := repo.SystemChannelsByIDs(channelIDs, true)
	if err != nil {
		return nil, err
	}
	systemChannelByID := make(map[string]model.ModelChannel, len(systemChannels))
	for _, channel := range systemChannels {
		systemChannelByID[channel.ID] = channel
	}
	return BuildAdminLogicalModel(*item, CatalogGraphFromRepo(graph), systemChannelByID)
}

func DeleteAdminLogicalModelInRepo(
	repo *repository.Repository,
	requireAdmin func(*model.User) error,
	actor *model.User,
	id string,
	newAudit func(actor *model.User, action, targetType, targetID, summary string, detail any) (*model.AdminAuditEvent, error),
	invalidate func(),
) error {
	if err := requireAdmin(actor); err != nil {
		return err
	}
	item, err := repo.LogicalModel(strings.TrimSpace(id))
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return kernel.BadAuthRequest("前台模型不存在或已删除")
	}
	if err != nil {
		return err
	}
	if err := ArchiveLogicalModelGuard(item); err != nil {
		return err
	}
	audit, err := newAudit(actor, "logical_model.archive", "logical_model", item.ID, "归档前台模型", map[string]any{"code": item.Code, "name": item.Name})
	if err != nil {
		return err
	}
	if err := repo.ArchiveLogicalModel(item.ID, audit, time.Now()); err != nil {
		if errors.Is(err, repository.ErrLogicalModelInUse) {
			return kernel.BadAuthRequest("前台模型仍被排队中或进行中任务使用，请等待任务结束后再归档")
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return kernel.BadAuthRequest("前台模型不存在或已删除")
		}
		return err
	}
	if invalidate != nil {
		invalidate()
	}
	return nil
}

type AdminChannelModelImportRequest struct {
	Models []string `json:"models"`
}

type AdminChannelModelTestResult struct {
	DurationMs int64 `json:"durationMs"`
}

func SyncInitialChannelModelsInRepo(repo *repository.Repository, channel *model.ModelChannel, names []string) error {
	existing, err := repo.ChannelModels(channel.ID, true)
	if err != nil {
		return err
	}
	plan, err := PlanInitialChannelModelSync(*channel, names, existing, repo.NextPrefixedID)
	if err != nil {
		return err
	}
	for index := range plan.Create {
		if err := repo.SaveChannelModel(&plan.Create[index]); err != nil {
			return err
		}
	}
	for index := range plan.Disable {
		if err := repo.SaveChannelModel(&plan.Disable[index]); err != nil {
			return err
		}
	}
	return nil
}

func EnsureChannelModelsInRepo(repo *repository.Repository, channelID string, includeDisabled bool) ([]model.ChannelModel, error) {
	items, err := repo.ChannelModels(channelID, includeDisabled)
	if err != nil || len(items) > 0 {
		return items, err
	}
	channel, err := repo.AdminSystemChannel(channelID)
	if err != nil {
		return nil, err
	}
	if err := SyncInitialChannelModelsInRepo(repo, channel, ChannelModelNames(*channel)); err != nil {
		return nil, err
	}
	return repo.ChannelModels(channelID, includeDisabled)
}

func EnsureSystemChannelModelsInRepo(repo *repository.Repository) error {
	channels, err := repo.SystemChannels(true)
	if err != nil {
		return err
	}
	for index := range channels {
		items, err := repo.ChannelModels(channels[index].ID, true)
		if err != nil {
			return err
		}
		if len(items) == 0 {
			if err := SyncInitialChannelModelsInRepo(repo, &channels[index], ChannelModelNames(channels[index])); err != nil {
				return err
			}
		}
	}
	return nil
}

func AdminChannelModelsFromRepo(repo *repository.Repository, requireAdmin func(*model.User) error, adminChannel func(string) (*model.ModelChannel, error), actor *model.User, channelID string) ([]model.ChannelModel, error) {
	if err := requireAdmin(actor); err != nil {
		return nil, err
	}
	if _, err := adminChannel(channelID); err != nil {
		return nil, err
	}
	items, err := EnsureChannelModelsInRepo(repo, channelID, true)
	if err != nil {
		return nil, err
	}
	return HydrateChannelModelCapabilityConfig(items), nil
}

func SystemChannelHasProtocolInRepo(repo *repository.Repository, channelID string, protocol model.ChannelInterfaceType) (bool, error) {
	items, err := repo.ChannelModels(channelID, false)
	if err != nil {
		return false, err
	}
	for _, item := range items {
		if item.Protocol == protocol {
			return true, nil
		}
	}
	return false, nil
}

func FetchAdminChannelModelsInRepo(
	ctx context.Context,
	repo *repository.Repository,
	requireAdmin func(*model.User) error,
	adminChannel func(string) (*model.ModelChannel, error),
	fetchModels func(context.Context, *model.User, *model.ModelChannel) ([]string, error),
	invalidate func(),
	actor *model.User,
	channelID string,
) (*AdminChannelModelFetchResult, error) {
	if err := requireAdmin(actor); err != nil {
		return nil, err
	}
	channel, err := adminChannel(channelID)
	if err != nil {
		return nil, err
	}
	models, err := fetchModels(ctx, actor, channel)
	if err != nil {
		return nil, err
	}
	existing, err := repo.ChannelModels(channelID, true)
	if err != nil {
		return nil, err
	}
	missing, err := MissingFetchedChannelModels(channelID, models, existing, RetiredChannelModelKeys(channel.RetiredModelsJSON), repo.NextPrefixedID)
	if err != nil {
		return nil, err
	}
	added, err := repo.CreateMissingChannelModels(missing)
	if err != nil {
		return nil, err
	}
	if added > 0 && invalidate != nil {
		invalidate()
	}
	return &AdminChannelModelFetchResult{Models: models, Added: added}, nil
}

func ImportAdminChannelModelsInRepo(
	ctx context.Context,
	repo *repository.Repository,
	requireAdmin func(*model.User) error,
	adminChannel func(string) (*model.ModelChannel, error),
	fetchCatalog func(context.Context, *model.User, string) ([]string, error),
	invalidate func(),
	actor *model.User,
	channelID string,
	selected []string,
) (*AdminChannelModelFetchResult, error) {
	if err := requireAdmin(actor); err != nil {
		return nil, err
	}
	channel, err := adminChannel(channelID)
	if err != nil {
		return nil, err
	}
	models, err := fetchCatalog(ctx, actor, channelID)
	if err != nil {
		return nil, err
	}
	chosen, err := SelectCatalogModels(selected, models)
	if err != nil {
		return nil, err
	}
	existing, err := repo.ChannelModels(channelID, true)
	if err != nil {
		return nil, err
	}
	missing, err := MissingImportedChannelModels(channelID, chosen, existing, RetiredChannelModelKeys(channel.RetiredModelsJSON), repo.NextPrefixedID)
	if err != nil {
		return nil, err
	}
	added, err := repo.CreateMissingChannelModels(missing)
	if err != nil {
		return nil, err
	}
	if added > 0 && invalidate != nil {
		invalidate()
	}
	return &AdminChannelModelFetchResult{Models: chosen, Added: added}, nil
}

func SaveAdminChannelModelInRepo(
	repo *repository.Repository,
	requireAdmin func(*model.User) error,
	actor *model.User,
	channelID string,
	id string,
	req ChannelModelRequest,
	normalize func(*model.ModelChannel, ChannelModelRequest) (string, string, string, model.ChannelInterfaceType, error),
	invalidate func(),
) (*model.ChannelModel, error) {
	if err := requireAdmin(actor); err != nil {
		return nil, err
	}
	channel, err := repo.AdminSystemChannel(channelID)
	if err != nil {
		return nil, err
	}
	modelKey, providerModelKey, capability, protocol, err := normalize(channel, req)
	if err != nil {
		return nil, err
	}
	conflict, conflictErr := repo.ChannelModelByKeyIncludingDisabled(channelID, modelKey)
	if conflictErr != nil && !errors.Is(conflictErr, gorm.ErrRecordNotFound) {
		return nil, conflictErr
	}
	if conflict != nil && conflict.ID != strings.TrimSpace(id) {
		return nil, kernel.BadAuthRequest("该渠道已存在模型 " + modelKey + "，请直接编辑已有模型")
	}
	var existing *model.ChannelModel
	if strings.TrimSpace(id) != "" {
		existing, err = repo.ChannelModelByID(channelID, id)
		if err != nil {
			return nil, err
		}
	}
	item, tiers, err := PrepareChannelModelSave(channelID, id, req, modelKey, providerModelKey, capability, protocol, existing, repo.NextPrefixedID)
	if err != nil {
		return nil, err
	}
	if err := repo.SaveChannelModelWithVariants(item, tiers); err != nil {
		return nil, err
	}
	item.Variants = tiers
	if invalidate != nil {
		invalidate()
	}
	if err := repo.SyncChannelModelNames(channel.ID, time.Now()); err != nil {
		return nil, err
	}
	if invalidate != nil {
		invalidate()
	}
	return item, nil
}

func DeleteAdminChannelModelsInRepo(
	repo *repository.Repository,
	requireAdmin func(*model.User) error,
	actor *model.User,
	channelID string,
	ids []string,
	invalidate func(),
) (int64, error) {
	if err := requireAdmin(actor); err != nil {
		return 0, err
	}
	if _, err := repo.AdminSystemChannel(channelID); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, kernel.BadAuthRequest("系统渠道不存在或已删除")
		}
		return 0, err
	}
	modelIDs, err := NormalizeAdminChannelModelDeleteIDs(ids)
	if err != nil {
		return 0, err
	}
	items, err := repo.ChannelModels(channelID, true)
	if err != nil {
		return 0, err
	}
	if err := ValidateChannelModelDeleteSelection(modelIDs, items); err != nil {
		return 0, err
	}
	deleted, err := repo.DeleteChannelModels(channelID, modelIDs, time.Now())
	if errors.Is(err, repository.ErrChannelModelInUse) {
		return 0, kernel.BadAuthRequest("所选渠道模型中有模型仍被前台模型供应线路或进行中任务使用，本次未删除任何模型")
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, kernel.BadAuthRequest("所选渠道模型中存在已删除或不属于当前渠道的记录，请刷新后重试")
	}
	if err == nil && invalidate != nil {
		invalidate()
	}
	return deleted, err
}

func LocalChannelModelListItems(models []LocalChannelModel, intent *ModelRequestIntent, beefChannelID, managedBeefRef string) []map[string]any {
	items := []map[string]any{}
	for _, item := range FilterLocalChannelModels(models, intent) {
		selection := map[string]any{"channelId": item.ChannelID, "channelModelKey": item.Model}
		if item.ChannelID == beefChannelID {
			selection["credentialRef"] = managedBeefRef
		}
		entry := map[string]any{"name": item.DisplayName, "capability": item.Capability, "selection": selection}
		if item.CapabilityConfig != nil {
			entry["options"] = item.CapabilityConfig
		}
		items = append(items, entry)
	}
	return items
}

func CatalogModelName(raw any) string {
	item, _ := raw.(map[string]any)
	if item == nil {
		return ""
	}
	if name, _ := item["name"].(string); name != "" {
		return name
	}
	return ""
}

func CoerceCatalogModels(value any) []map[string]any {
	switch typed := value.(type) {
	case []map[string]any:
		return append([]map[string]any{}, typed...)
	case []any:
		items := make([]map[string]any, 0, len(typed))
		for _, raw := range typed {
			item, _ := raw.(map[string]any)
			if item == nil {
				continue
			}
			items = append(items, item)
		}
		return items
	default:
		return []map[string]any{}
	}
}
