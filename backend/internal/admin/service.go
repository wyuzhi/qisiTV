package admin

import (
	"errors"
	stdlog "log"
	"sync"
	"time"

	"gorm.io/gorm"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
	"qisitv/backend/internal/platform"
	"qisitv/backend/internal/repository"
	"qisitv/backend/internal/resource"
)

type ListQuery struct {
	Keyword string
	Status  string
	Type    string
	Page    int
	Limit   int
}

type ChannelReference struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Enabled bool     `json:"enabled"`
	Models  []string `json:"models"`
}

type Host struct {
	Repo               *repository.Repository
	EncryptSecret      func(string) (string, error)
	DecryptSecret      func(string) (string, error)
	SyncInitialModels  func(channel *model.ModelChannel, models []string) error
	UpdatePresentation func(id string, req modelcatalog.ChannelRequest) (*modelcatalog.PublicModelChannel, error)
	InvalidateRoutes   func()
}

func RequireAdmin(user *model.User) error {
	if user == nil {
		return kernel.Unauthorized("请先登录")
	}
	if user.Role != model.UserRoleAdmin {
		return kernel.Forbidden("需要管理员权限")
	}
	return nil
}

func PublicSystemChannels(repo *repository.Repository) ([]modelcatalog.PublicModelChannel, error) {
	channels, err := repo.SystemChannels(false)
	if err != nil {
		return nil, err
	}
	result := make([]modelcatalog.PublicModelChannel, 0, len(channels))
	for _, channel := range channels {
		items, itemErr := repo.ChannelModels(channel.ID, false)
		if itemErr != nil {
			return nil, itemErr
		}
		result = append(result, modelcatalog.PublicChannel(channel, false, items))
	}
	return result, nil
}

func SystemChannel(repo *repository.Repository, decrypt func(string) (string, error), id string) (*model.ModelChannel, error) {
	channel, err := repo.SystemChannel(id)
	if err != nil {
		return nil, err
	}
	if err := DecryptSystemChannelSecrets(decrypt, channel); err != nil {
		return nil, err
	}
	return channel, nil
}

func AdminSystemChannel(repo *repository.Repository, decrypt func(string) (string, error), id string) (*model.ModelChannel, error) {
	channel, err := repo.AdminSystemChannel(id)
	if err != nil {
		return nil, err
	}
	if err := DecryptSystemChannelSecrets(decrypt, channel); err != nil {
		return nil, err
	}
	return channel, nil
}

func AdminSystemChannelPage(repo *repository.Repository, actor *model.User, query ListQuery) (*modelcatalog.AdminChannelPage, error) {
	if err := RequireAdmin(actor); err != nil {
		return nil, err
	}
	page, limit := modelcatalog.NormalizeAdminPage(query.Page, query.Limit)
	channels, total, err := repo.AdminSystemChannels(query.Keyword, query.Status, limit, (page-1)*limit)
	if err != nil {
		return nil, err
	}
	result := make([]modelcatalog.PublicModelChannel, 0, len(channels))
	for _, channel := range channels {
		items, itemErr := repo.ChannelModels(channel.ID, true)
		if itemErr != nil {
			return nil, itemErr
		}
		result = append(result, modelcatalog.PublicChannel(channel, true, items))
	}
	return &modelcatalog.AdminChannelPage{Channels: result, Total: total, Page: page, Limit: limit}, nil
}

func CreateSystemChannel(h Host, actor *model.User, req modelcatalog.ChannelRequest) (*modelcatalog.PublicModelChannel, error) {
	if err := RequireAdmin(actor); err != nil {
		return nil, err
	}
	channelID, err := h.Repo.NextPrefixedID("CHANNEL")
	if err != nil {
		return nil, err
	}
	channel, err := modelcatalog.ApplyChannelRequest(req, model.ModelChannel{ID: channelID, UserID: actor.ID, Scope: model.ChannelScopeSystem, Enabled: true})
	if err != nil {
		return nil, err
	}
	if err := EncryptSystemChannelSecrets(h.EncryptSecret, &channel); err != nil {
		return nil, err
	}
	if err := h.Repo.Create(&channel); err != nil {
		return nil, err
	}
	if err := h.SyncInitialModels(&channel, req.Models); err != nil {
		return nil, err
	}
	if h.InvalidateRoutes != nil {
		h.InvalidateRoutes()
	}
	items, err := h.Repo.ChannelModels(channel.ID, true)
	if err != nil {
		return nil, err
	}
	public := modelcatalog.PublicChannel(channel, true, items)
	return &public, nil
}

func DuplicateSystemChannel(h Host, actor *model.User, id string) (*modelcatalog.PublicModelChannel, error) {
	if err := RequireAdmin(actor); err != nil {
		return nil, err
	}
	source, err := AdminSystemChannel(h.Repo, h.DecryptSecret, id)
	if err != nil {
		return nil, err
	}
	sourceModels, err := h.Repo.ChannelModels(source.ID, true)
	if err != nil {
		return nil, err
	}
	channelID, err := h.Repo.NextPrefixedID("CHANNEL")
	if err != nil {
		return nil, err
	}
	channel, channelModels, variants, err := modelcatalog.DuplicateSystemChannelModels(*source, sourceModels, actor.ID, channelID, h.Repo.NextPrefixedID)
	if err != nil {
		return nil, err
	}
	if err := EncryptSystemChannelSecrets(h.EncryptSecret, &channel); err != nil {
		return nil, err
	}
	if err := h.Repo.CreateDuplicatedSystemChannel(&channel, channelModels, variants); err != nil {
		return nil, err
	}
	if h.InvalidateRoutes != nil {
		h.InvalidateRoutes()
	}
	items, err := h.Repo.ChannelModels(channel.ID, true)
	if err != nil {
		return nil, err
	}
	public := modelcatalog.PublicChannel(channel, true, items)
	return &public, nil
}

func UpdateSystemChannel(h Host, actor *model.User, id string, req modelcatalog.ChannelRequest) (*modelcatalog.PublicModelChannel, error) {
	if err := RequireAdmin(actor); err != nil {
		return nil, err
	}
	if req.PresentationOnly() {
		return h.UpdatePresentation(id, req)
	}
	updateModels := req.Models != nil
	channel, err := h.Repo.AdminSystemChannel(id)
	if err != nil {
		return nil, err
	}
	if err := DecryptSystemChannelSecrets(h.DecryptSecret, channel); err != nil {
		return nil, err
	}
	req = modelcatalog.MergeChannelRequest(req, *channel)
	next, err := modelcatalog.ApplyChannelRequest(req, *channel)
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
	if err := EncryptSystemChannelSecrets(h.EncryptSecret, &next); err != nil {
		return nil, err
	}
	if err := h.Repo.Save(&next); err != nil {
		return nil, err
	}
	if updateModels {
		if err := h.SyncInitialModels(&next, req.Models); err != nil {
			return nil, err
		}
	}
	if h.InvalidateRoutes != nil {
		h.InvalidateRoutes()
	}
	items, err := h.Repo.ChannelModels(next.ID, true)
	if err != nil {
		return nil, err
	}
	public := modelcatalog.PublicChannel(next, true, items)
	return &public, nil
}

func EncryptSystemChannelSecrets(encrypt func(string) (string, error), channel *model.ModelChannel) error {
	apiKey, err := encrypt(channel.APIKey)
	if err != nil {
		return err
	}
	secretKey, err := encrypt(channel.SecretKey)
	if err != nil {
		return err
	}
	channel.APIKey = apiKey
	channel.SecretKey = secretKey
	return nil
}

func DecryptSystemChannelSecrets(decrypt func(string) (string, error), channel *model.ModelChannel) error {
	apiKey, err := decrypt(channel.APIKey)
	if err != nil {
		return err
	}
	secretKey, err := decrypt(channel.SecretKey)
	if err != nil {
		return err
	}
	channel.APIKey = apiKey
	channel.SecretKey = secretKey
	return nil
}

func DeleteSystemChannel(repo *repository.Repository, invalidateRoutes func(), actor *model.User, id string) error {
	if err := RequireAdmin(actor); err != nil {
		return err
	}
	channel, err := repo.AdminSystemChannel(id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return kernel.BadAuthRequest("系统渠道不存在或已删除")
		}
		return err
	}
	err = repo.DeleteSystemChannel(channel.ID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return kernel.BadAuthRequest("系统渠道不存在或已删除")
	}
	if err == nil && invalidateRoutes != nil {
		invalidateRoutes()
	}
	return err
}

func LogAPICall(
	repo *repository.Repository,
	lock *sync.Mutex,
	policy func() (platform.RuntimePolicySetting, error),
	videoPollInterval time.Duration,
	log model.ApiCallLog,
) error {
	if log.ID == "" {
		log.ID = kernel.NewID()
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
				delay = videoPollInterval
			}
			next := time.Now().Add(delay)
			nextPollAt = &next
		} else if stage == "poll" {
			delay := 5 * time.Second
			if log.Capability == "video" {
				delay = videoPollInterval
			}
			next := time.Now().Add(delay)
			nextPollAt = &next
		}
		if err := repo.UpdateTaskProviderState(log.TaskID, log.ProviderRequestID, stage, nextPollAt); err != nil {
			stdlog.Printf("provider task state update failed: task_id=%s provider_request_id=%s error=%v", log.TaskID, log.ProviderRequestID, err)
		}
	}
	if merged, err := MergeVideoAPICallLog(repo, log); err != nil {
		return err
	} else if merged {
		return nil
	}
	currentPolicy, err := policy()
	if err != nil {
		return err
	}
	if lock != nil {
		lock.Lock()
		defer lock.Unlock()
	}
	usage, err := repo.UserStorageUsage(log.UserID)
	if err != nil {
		return err
	}
	incomingBytes := int64(len(log.Path) + len(log.Model) + len(log.ProviderRequestID) + len(log.ErrorCode) + len(log.Error) + len(log.UpstreamURL) + len(log.RequestContentType) + len(log.RequestBody) + len(log.ResponseBody))
	if err := resource.ValidateAPICallLogQuota(usage, incomingBytes, currentPolicy.Resource); err != nil {
		return err
	}
	return repo.Create(&log)
}

func MergeVideoAPICallLog(repo *repository.Repository, log model.ApiCallLog) (bool, error) {
	if log.Capability != "video" || (log.RequestKind != "poll" && log.RequestKind != "download") {
		return false, nil
	}
	if log.TaskID == "" && log.ProviderRequestID == "" {
		return false, nil
	}
	root, err := repo.VideoAPICallRoot(log)
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
	return true, repo.Save(root)
}

func APICallLogs(repo *repository.Repository, actor *model.User, limit int) ([]model.ApiCallLog, error) {
	if actor == nil {
		return nil, kernel.Unauthorized("请先登录")
	}
	return repo.ApiCallLogs(actor.ID, actor.Role == model.UserRoleAdmin, limit)
}
