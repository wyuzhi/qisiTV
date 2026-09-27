package app

import (
	"encoding/json"
	"errors"
	stdlog "log"
	"qisitv/backend/internal/kernel"
	"strings"
	"time"

	"qisitv/backend/internal/model"

	"gorm.io/gorm"
)

type AdminListQuery struct {
	Keyword string
	Status  string
	Type    string
	Page    int
	Limit   int
}

type AdminChannelPage struct {
	Channels []PublicModelChannel `json:"channels"`
	Total    int64                `json:"total"`
	Page     int                  `json:"page"`
	Limit    int                  `json:"pageSize"`
}

type AdminChannelReference struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Enabled bool     `json:"enabled"`
	Models  []string `json:"models"`
}

type ChannelRequest struct {
	Name                 string           `json:"name"`
	PublicAlias          *string          `json:"publicAlias"`
	SortOrder            *int             `json:"sortOrder"`
	BaseURL              string           `json:"baseUrl"`
	APIKey               string           `json:"apiKey"`
	SecretKey            string           `json:"secretKey"`
	ConcurrencyLimit     *int             `json:"concurrencyLimit"`
	UseGlobalConcurrency *bool            `json:"useGlobalConcurrency"`
	Models               []string         `json:"models"`
	Headers              []OutboundHeader `json:"headers"`
	Enabled              *bool            `json:"enabled"`
}

type PublicModelChannel struct {
	ID               string                      `json:"id"`
	UserID           string                      `json:"userId"`
	Scope            model.ChannelScope          `json:"scope"`
	Enabled          bool                        `json:"enabled"`
	Name             string                      `json:"name"`
	PublicAlias      string                      `json:"publicAlias,omitempty"`
	SortOrder        int                         `json:"sortOrder"`
	BaseURL          string                      `json:"baseUrl"`
	APIKey           string                      `json:"apiKey"`
	APIFormat        string                      `json:"apiFormat"`
	ConcurrencyLimit int                         `json:"concurrencyLimit"`
	Models           []string                    `json:"models"`
	ModelProfiles    []PublicChannelModelProfile `json:"modelProfiles"`
	Headers          []OutboundHeader            `json:"headers,omitempty"`
	HasAPIKey        bool                        `json:"hasApiKey"`
	HasSecretKey     bool                        `json:"hasSecretKey"`
	CreatedAt        time.Time                   `json:"createdAt"`
	UpdatedAt        time.Time                   `json:"updatedAt"`
}

type PublicChannelModelProfile struct {
	Model            string                     `json:"model"`
	DisplayName      string                     `json:"displayName"`
	Icon             string                     `json:"icon"`
	Capability       string                     `json:"capability"`
	Protocol         model.ChannelInterfaceType `json:"protocol"`
	CapabilityConfig *ModelCapabilityConfig     `json:"capabilityConfig,omitempty"`
}

func (s *Service) RequireAdmin(user *model.User) error {
	if user == nil {
		return Unauthorized("请先登录")
	}
	if user.Role != model.UserRoleAdmin {
		return Forbidden("需要管理员权限")
	}
	return nil
}

func (s *Service) PublicSystemChannels() ([]PublicModelChannel, error) {
	channels, err := s.repo.SystemChannels(false)
	if err != nil {
		return nil, err
	}
	result := make([]PublicModelChannel, 0, len(channels))
	for _, channel := range channels {
		items, itemErr := s.repo.ChannelModels(channel.ID, false)
		if itemErr != nil {
			return nil, itemErr
		}
		result = append(result, publicChannel(channel, false, items))
	}
	return result, nil
}

func (s *Service) SystemChannel(id string) (*model.ModelChannel, error) {
	channel, err := s.repo.SystemChannel(id)
	if err != nil {
		return nil, err
	}
	if err := s.decryptSystemChannelSecrets(channel); err != nil {
		return nil, err
	}
	return channel, nil
}

func (s *Service) adminSystemChannel(id string) (*model.ModelChannel, error) {
	channel, err := s.repo.AdminSystemChannel(id)
	if err != nil {
		return nil, err
	}
	if err := s.decryptSystemChannelSecrets(channel); err != nil {
		return nil, err
	}
	return channel, nil
}

func (s *Service) AdminSystemChannelPage(actor *model.User, query AdminListQuery) (*AdminChannelPage, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	page, limit := normalizeAdminPage(query.Page, query.Limit)
	channels, total, err := s.repo.AdminSystemChannels(query.Keyword, query.Status, limit, (page-1)*limit)
	if err != nil {
		return nil, err
	}
	result := make([]PublicModelChannel, 0, len(channels))
	for _, channel := range channels {
		items, itemErr := s.repo.ChannelModels(channel.ID, true)
		if itemErr != nil {
			return nil, itemErr
		}
		result = append(result, publicChannel(channel, true, items))
	}
	return &AdminChannelPage{Channels: result, Total: total, Page: page, Limit: limit}, nil
}

func normalizeAdminPage(page int, limit int) (int, int) {
	if page <= 0 {
		page = 1
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	return page, limit
}

func (s *Service) CreateSystemChannel(actor *model.User, req ChannelRequest) (*PublicModelChannel, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	channelID, err := s.repo.NextPrefixedID("CHANNEL")
	if err != nil {
		return nil, err
	}
	channel, err := s.channelFromRequest(req, model.ModelChannel{ID: channelID, UserID: actor.ID, Scope: model.ChannelScopeSystem, Enabled: true})
	if err != nil {
		return nil, err
	}
	if err := s.encryptSystemChannelSecrets(&channel); err != nil {
		return nil, err
	}
	if err := s.repo.Create(&channel); err != nil {
		return nil, err
	}
	if err := s.syncInitialChannelModels(&channel, req.Models); err != nil {
		return nil, err
	}
	s.invalidateRouteCatalog()
	items, err := s.repo.ChannelModels(channel.ID, true)
	if err != nil {
		return nil, err
	}
	public := publicChannel(channel, true, items)
	return &public, nil
}

func (s *Service) DuplicateSystemChannel(actor *model.User, id string) (*PublicModelChannel, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	source, err := s.adminSystemChannel(id)
	if err != nil {
		return nil, err
	}
	sourceModels, err := s.repo.ChannelModels(source.ID, true)
	if err != nil {
		return nil, err
	}
	if len(sourceModels) == 0 {
		for _, name := range channelModelNames(*source) {
			sourceModels = append(sourceModels, model.ChannelModel{ModelKey: name, ProviderModelKey: name, DisplayName: name, Enabled: false})
		}
	}
	channelID, err := s.repo.NextPrefixedID("CHANNEL")
	if err != nil {
		return nil, err
	}
	channel := *source
	channel.ID = channelID
	channel.UserID = actor.ID
	channel.Scope = model.ChannelScopeSystem
	channel.Name = duplicateChannelName(source.Name)
	channel.CreatedAt = time.Time{}
	channel.UpdatedAt = time.Time{}
	channel.DeletedAt = gorm.DeletedAt{}
	if err := s.encryptSystemChannelSecrets(&channel); err != nil {
		return nil, err
	}

	channelModels := make([]model.ChannelModel, 0, len(sourceModels))
	variants := make([]model.ChannelModelVariant, 0)
	for _, sourceModel := range sourceModels {
		modelID, idErr := s.repo.NextPrefixedID("MODEL")
		if idErr != nil {
			return nil, idErr
		}
		channelModel := sourceModel
		channelModel.ID = modelID
		channelModel.ChannelID = channel.ID
		channelModel.CreatedAt = time.Time{}
		channelModel.UpdatedAt = time.Time{}
		channelModel.DeletedAt = gorm.DeletedAt{}
		channelModel.Variants = nil
		channelModels = append(channelModels, channelModel)
		for _, sourceTier := range sourceModel.Variants {
			tierID, tierErr := s.repo.NextPrefixedID("PTIER")
			if tierErr != nil {
				return nil, tierErr
			}
			variant := sourceTier
			variant.ID = tierID
			variant.ChannelModelID = channelModel.ID
			variant.Selector = nil
			variant.CreatedAt = time.Time{}
			variant.UpdatedAt = time.Time{}
			variant.DeletedAt = gorm.DeletedAt{}
			variants = append(variants, variant)
		}
	}
	if err := s.repo.CreateDuplicatedSystemChannel(&channel, channelModels, variants); err != nil {
		return nil, err
	}
	s.invalidateRouteCatalog()
	items, err := s.repo.ChannelModels(channel.ID, true)
	if err != nil {
		return nil, err
	}
	public := publicChannel(channel, true, items)
	return &public, nil
}

func duplicateChannelName(name string) string {
	const suffix = " - 副本"
	base := []rune(strings.TrimSpace(name))
	if len(base) == 0 {
		base = []rune("系统渠道")
	}
	if len(base)+len([]rune(suffix)) > 80 {
		base = base[:80-len([]rune(suffix))]
	}
	return string(base) + suffix
}

func (s *Service) UpdateSystemChannel(actor *model.User, id string, req ChannelRequest) (*PublicModelChannel, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	if req.presentationOnly() {
		return s.updateChannelPresentation(id, req)
	}
	updateModels := req.Models != nil
	channel, err := s.repo.AdminSystemChannel(id)
	if err != nil {
		return nil, err
	}
	if err := s.decryptSystemChannelSecrets(channel); err != nil {
		return nil, err
	}
	req = mergeChannelRequest(req, *channel)
	next, err := s.channelFromRequest(req, *channel)
	if err != nil {
		return nil, err
	}
	next.ID = channel.ID
	next.UserID = channel.UserID
	next.Scope = model.ChannelScopeSystem
	next.CreatedAt = channel.CreatedAt
	if req.APIKey == "" {
		next.APIKey = channel.APIKey
	}
	if req.SecretKey == "" {
		next.SecretKey = channel.SecretKey
	}
	if err := s.encryptSystemChannelSecrets(&next); err != nil {
		return nil, err
	}
	if err := s.repo.Save(&next); err != nil {
		return nil, err
	}
	if updateModels {
		if err := s.syncInitialChannelModels(&next, req.Models); err != nil {
			return nil, err
		}
	}
	s.invalidateRouteCatalog()
	items, err := s.repo.ChannelModels(next.ID, true)
	if err != nil {
		return nil, err
	}
	public := publicChannel(next, true, items)
	return &public, nil
}

func (s *Service) encryptSystemChannelSecrets(channel *model.ModelChannel) error {
	apiKey, err := s.encryptSettingSecret(channel.APIKey)
	if err != nil {
		return err
	}
	secretKey, err := s.encryptSettingSecret(channel.SecretKey)
	if err != nil {
		return err
	}
	channel.APIKey = apiKey
	channel.SecretKey = secretKey
	return nil
}

func (s *Service) decryptSystemChannelSecrets(channel *model.ModelChannel) error {
	apiKey, err := s.decryptSettingSecret(channel.APIKey)
	if err != nil {
		return err
	}
	secretKey, err := s.decryptSettingSecret(channel.SecretKey)
	if err != nil {
		return err
	}
	channel.APIKey = apiKey
	channel.SecretKey = secretKey
	return nil
}

func (s *Service) DeleteSystemChannel(actor *model.User, id string) error {
	if err := s.RequireAdmin(actor); err != nil {
		return err
	}
	channel, err := s.repo.AdminSystemChannel(id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return BadAuthRequest("系统渠道不存在或已删除")
		}
		return err
	}
	// 保留主体供历史账单和调用日志关联，但从所有业务查询中隐藏并清除密钥。
	err = s.repo.DeleteSystemChannel(channel.ID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return BadAuthRequest("系统渠道不存在或已删除")
	}
	if err == nil {
		s.invalidateRouteCatalog()
	}
	return err
}

func (s *Service) LogAPICall(log model.ApiCallLog) error {
	if log.ID == "" {
		log.ID = newID()
	}
	if log.CreatedAt.IsZero() {
		log.CreatedAt = time.Now()
	}
	if log.StartedAt.IsZero() {
		log.StartedAt = log.CreatedAt.Add(-time.Duration(log.DurationMs) * time.Millisecond)
	}
	if log.TaskID != "" {
		stage := log.RequestKind
		var nextPollAt *time.Time
		if stage == "create" && log.Status == model.ApiCallStatusSucceeded && log.ProviderRequestID != "" {
			stage = "accepted"
			delay := 2 * time.Second
			if log.Capability == "video" {
				delay = defaultVideoPollInterval
			}
			next := time.Now().Add(delay)
			nextPollAt = &next
		} else if stage == "poll" {
			delay := 5 * time.Second
			if log.Capability == "video" {
				delay = defaultVideoPollInterval
			}
			next := time.Now().Add(delay)
			nextPollAt = &next
		}
		if err := s.repo.UpdateTaskProviderState(log.TaskID, log.ProviderRequestID, stage, nextPollAt); err != nil {
			// 请求日志本身仍需保留；任务状态可由后续任务收尾或恢复流程
			// 重建，不能让一次状态写失败掩盖真实的上游调用。
			stdlog.Printf("provider task state update failed: task_id=%s provider_request_id=%s error=%v", log.TaskID, log.ProviderRequestID, err)
		}
	}
	if merged, err := s.mergeVideoAPICallLog(log); err != nil {
		return err
	} else if merged {
		return nil
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	usage, err := s.repo.UserStorageUsage(log.UserID)
	if err != nil {
		return err
	}
	incomingBytes := int64(len(log.Path) + len(log.Model) + len(log.ProviderRequestID) + len(log.ErrorCode) + len(log.Error) + len(log.UpstreamURL) + len(log.RequestContentType) + len(log.RequestBody) + len(log.ResponseBody))
	if err := validateAPICallLogQuotaWithPolicy(usage, incomingBytes, policy.Resource); err != nil {
		return err
	}
	return s.repo.Create(&log)
}

func (s *Service) mergeVideoAPICallLog(log model.ApiCallLog) (bool, error) {
	if log.Capability != "video" || (log.RequestKind != "poll" && log.RequestKind != "download") {
		return false, nil
	}
	if log.TaskID == "" && log.ProviderRequestID == "" {
		return false, nil
	}
	root, err := s.repo.VideoAPICallRoot(log)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if log.RequestKind == "poll" {
		root.PollCount++
		if log.ResponseBody != "" {
			root.ResponseBody = log.ResponseBody
		}
	}
	if log.ProviderRequestID != "" {
		root.ProviderRequestID = log.ProviderRequestID
	}
	if log.ProviderStatus != "" {
		root.ProviderStatus = log.ProviderStatus
	}
	startedAt := root.StartedAt
	if startedAt.IsZero() {
		startedAt = root.CreatedAt.Add(-time.Duration(root.DurationMs) * time.Millisecond)
		root.StartedAt = startedAt
	}
	root.DurationMs = max(root.DurationMs, log.CreatedAt.Sub(startedAt).Milliseconds())
	root.StatusCode = log.StatusCode
	root.ConcurrencyLimit = log.ConcurrencyLimit
	if log.Status == model.ApiCallStatusFailed {
		root.Status = log.Status
		root.ErrorCode = log.ErrorCode
		root.Error = log.Error
	} else {
		root.Status = model.ApiCallStatusSucceeded
		root.ErrorCode = ""
		root.Error = ""
	}
	if log.UsageAvailable {
		root.UsageAvailable = true
		root.InputTokens = log.InputTokens
		root.OutputTokens = log.OutputTokens
		root.CachedTokens = log.CachedTokens
	}
	return true, s.repo.Save(root)
}

func (s *Service) APICallLogs(actor *model.User, limit int) ([]model.ApiCallLog, error) {
	if actor == nil {
		return nil, Unauthorized("请先登录")
	}
	return s.repo.ApiCallLogs(actor.ID, actor.Role == model.UserRoleAdmin, limit)
}

func channelFromRequest(req ChannelRequest, channel model.ModelChannel) (model.ModelChannel, error) {
	return (&Service{}).channelFromRequest(req, channel)
}

func (s *Service) channelFromRequest(req ChannelRequest, channel model.ModelChannel) (model.ModelChannel, error) {
	name := strings.TrimSpace(req.Name)
	baseURL := strings.TrimSpace(req.BaseURL)
	if name == "" {
		return channel, BadAuthRequest("请填写渠道名称")
	}
	if baseURL == "" {
		return channel, BadAuthRequest("请填写 Base URL")
	}
	// 启用/停用或只修改模型配置时，不应要求上游域名当前可解析。
	// 只有 Base URL 实际变化时才做出站地址校验。
	connectionChanged := strings.TrimRight(baseURL, "/") != strings.TrimRight(channel.BaseURL, "/")
	if connectionChanged {
		if _, err := ValidateOutboundURL(baseURL); err != nil {
			return channel, err
		}
	}
	models := uniqueNonEmpty(req.Models)
	modelsJSON, _ := json.Marshal(models)
	headersJSON, err := EncodeOutboundHeadersJSON(req.Headers)
	if err != nil {
		return channel, err
	}
	channel.Name = name
	if req.PublicAlias != nil {
		alias := strings.TrimSpace(*req.PublicAlias)
		if len([]rune(alias)) > 80 {
			return channel, BadAuthRequest("前台显示别名不能超过 80 个字符")
		}
		channel.PublicAlias = alias
	}
	if req.SortOrder != nil {
		if err := validateChannelSortOrder(*req.SortOrder); err != nil {
			return channel, err
		}
		channel.SortOrder = *req.SortOrder
	}
	channel.BaseURL = strings.TrimRight(baseURL, "/")
	if req.APIKey != "" {
		channel.APIKey = req.APIKey
	}
	if req.SecretKey != "" {
		channel.SecretKey = req.SecretKey
	}
	// 系统渠道只保存地址与凭证；实际协议和鉴权方式由所选模型决定。
	channel.APIFormat = "openai"
	if req.UseGlobalConcurrency != nil && *req.UseGlobalConcurrency {
		channel.ConcurrencyLimit = 0
	} else if req.ConcurrencyLimit != nil {
		if *req.ConcurrencyLimit < minChannelConcurrencyLimit || *req.ConcurrencyLimit > maxChannelConcurrencyLimit {
			return channel, BadAuthRequest("最大并发数必须是 1-999 的整数")
		}
		channel.ConcurrencyLimit = *req.ConcurrencyLimit
	} else if req.UseGlobalConcurrency != nil {
		return channel, BadAuthRequest("请填写渠道最大并发数")
	}
	channel.ModelsJSON = string(modelsJSON)
	channel.HeadersJSON = headersJSON
	if req.Enabled != nil {
		channel.Enabled = *req.Enabled
	}
	return channel, nil
}

func mergeChannelRequest(req ChannelRequest, channel model.ModelChannel) ChannelRequest {
	if strings.TrimSpace(req.Name) == "" {
		req.Name = channel.Name
	}
	if strings.TrimSpace(req.BaseURL) == "" {
		req.BaseURL = channel.BaseURL
	}
	if req.Models == nil {
		req.Models = channelModelNames(channel)
	}
	if req.Headers == nil {
		req.Headers, _ = ParseOutboundHeadersJSON(channel.HeadersJSON)
	}
	return req
}

func publicChannel(channel model.ModelChannel, admin bool, channelModels []model.ChannelModel) PublicModelChannel {
	models := make([]string, 0, len(channelModels))
	modelProfiles := make([]PublicChannelModelProfile, 0, len(channelModels))
	for _, item := range channelModels {
		if !item.Enabled {
			continue
		}
		models = append(models, item.ModelKey)
		if item.Enabled {
			capabilityConfig, decodeErr := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
			if decodeErr == nil && capabilityConfig != nil {
				if normalized, normalizeErr := NormalizeModelCapabilityConfigForModel(item.Capability, string(item.Protocol), firstNonEmpty(item.ProviderModelKey, item.ModelKey), capabilityConfig); normalizeErr == nil {
					capabilityConfig = normalized
				}
			}
			modelProfiles = append(modelProfiles, PublicChannelModelProfile{Model: item.ModelKey, DisplayName: item.DisplayName, Icon: item.Icon, Capability: item.Capability, Protocol: item.Protocol, CapabilityConfig: capabilityConfig})
		}
	}
	if len(models) == 0 {
		_ = json.Unmarshal([]byte(channel.ModelsJSON), &models)
	}
	apiKey := ""
	baseURL := channel.BaseURL
	var headers []OutboundHeader
	if channel.Scope == model.ChannelScopeSystem {
		if !admin {
			apiKey = "system"
			baseURL = "/api/ai/system/" + channel.ID
		}
		if admin {
			headers, _ = ParseOutboundHeadersJSON(channel.HeadersJSON)
		}
	} else if admin {
		apiKey = channel.APIKey
	}
	name, alias := channel.PublicName(), ""
	if admin {
		name, alias = channel.Name, channel.PublicAlias
	}
	return PublicModelChannel{
		ID:               channel.ID,
		UserID:           channel.UserID,
		Scope:            channel.Scope,
		Enabled:          channel.Enabled,
		Name:             name,
		PublicAlias:      alias,
		SortOrder:        channel.SortOrder,
		BaseURL:          baseURL,
		APIKey:           apiKey,
		APIFormat:        channel.APIFormat,
		ConcurrencyLimit: channel.ConcurrencyLimit,
		Models:           models,
		ModelProfiles:    modelProfiles,
		Headers:          headers,
		HasAPIKey:        strings.TrimSpace(channel.APIKey) != "",
		HasSecretKey:     strings.TrimSpace(channel.SecretKey) != "",
		CreatedAt:        channel.CreatedAt,
		UpdatedAt:        channel.UpdatedAt,
	}
}

func uniqueNonEmpty(values []string) []string {
	return kernel.UniqueNonEmpty(values)
}
