package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"strings"
	"time"

	"qisitv/backend/internal/beefapi"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
	"qisitv/backend/internal/outbound"
	"qisitv/backend/internal/repository"
	"qisitv/backend/internal/workspace"
)

const (
	ProviderCancellationLeaseDuration = time.Minute
	ProviderCancellationMaxAttempts   = 41
)

type ProviderCancellationOutcome string

type geminiOperation map[string]any

const (
	ProviderCancellationPending   ProviderCancellationOutcome = "pending"
	ProviderCancellationConfirmed ProviderCancellationOutcome = "confirmed"
	ProviderCancellationSucceeded ProviderCancellationOutcome = "succeeded"
	ProviderCancellationFailed    ProviderCancellationOutcome = "failed"
)

func StartProviderCancellationReconciliation(ctx context.Context, runLoop func(func(context.Context)) bool, repo *repository.Repository, workerID string, reconcile func(context.Context, *model.Task) error, logTask func(userID, taskID, level, msg, payload string) error) {
	_ = runLoop(func(ctx context.Context) {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				task, err := repo.ClaimNextTaskProviderCancellation("provider-cancel:"+workerID, ProviderCancellationLeaseDuration)
				if err != nil || task == nil {
					continue
				}
				reconcileCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
				if err := reconcile(reconcileCtx, task); err != nil && logTask != nil {
					_ = logTask(task.UserID, task.ID, "error", "上游取消状态对账失败", err.Error())
				}
				cancel()
			}
		}
	})
}

func RequestProviderCancellation(ctx context.Context, repo *repository.Repository, task *model.Task, hydrateID func(*model.Task), decryptInput func(string) (string, error), resolveConfig func(Config) (Config, error), bindTaskCtx func(context.Context, model.Task) context.Context, logTask func(userID, taskID, level, msg, payload string) error) error {
	if task == nil || task.ID == "" {
		return errors.New("任务取消状态无效")
	}
	if hydrateID != nil {
		hydrateID(task)
	}
	if task.ProviderRequestID != "" {
		if err := repo.UpdateTaskProviderState(task.ID, task.ProviderRequestID, task.PollStage, task.NextPollAt); err != nil {
			return err
		}
	}
	if err := repo.ClaimTaskProviderCancellation(task.UserID, task.ID, time.Now()); err != nil {
		if errors.Is(err, repository.ErrTaskProviderCancellationConflict) {
			return nil
		}
		return err
	}
	if task.ProviderRequestID == "" {
		return MarkProviderCancellationUncertain(repo, task, providerCancellationUncertainMessage("上游未返回任务 ID，无法发送取消请求"), logTask)
	}
	input, err := ProviderCancellationInput(task, decryptInput, resolveConfig)
	if err != nil {
		return MarkProviderCancellationUncertain(repo, task, providerCancellationUncertainMessage("读取上游取消配置失败")+"："+err.Error(), logTask)
	}
	if !SupportsProviderCancellation(input.Config.InterfaceType) && UpscaleMediaType(input.Config.Model) == "" {
		return MarkProviderCancellationUncertain(repo, task, providerCancellationUncertainMessage("当前上游协议不支持取消"), logTask)
	}
	requestCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	requestTask := *task
	data, _ := json.Marshal(input)
	requestTask.InputJSON = string(data)
	if bindTaskCtx != nil {
		requestCtx = bindTaskCtx(requestCtx, requestTask)
	}
	requestCtx = WithProviderRequestKind(requestCtx, "cancel")
	if err := CancelProviderTask(requestCtx, input.Config, task.ProviderRequestID); err != nil {
		return MarkProviderCancellationUncertain(repo, task, providerCancellationUncertainMessage("上游取消请求结果不明确")+"："+SafeProviderLogError(err), logTask)
	}
	if logTask != nil {
		_ = logTask(task.UserID, task.ID, "info", "已请求上游取消，等待供应商确认", task.ProviderRequestID)
	}
	return nil
}

func ReconcileProviderCancellation(ctx context.Context, repo *repository.Repository, task *model.Task, decryptInput func(string) (string, error), resolveConfig func(Config) (Config, error), bindTaskCtx func(context.Context, model.Task) context.Context, logTask func(userID, taskID, level, msg, payload string) error) error {
	if task.ProviderCancelAttempts >= ProviderCancellationMaxAttempts {
		return MarkProviderCancellationUncertain(repo, task, providerCancellationUncertainMessage("上游取消状态长时间未确认"), logTask)
	}
	input, err := ProviderCancellationInput(task, decryptInput, resolveConfig)
	if err != nil {
		return MarkProviderCancellationUncertain(repo, task, providerCancellationUncertainMessage("读取上游对账配置失败")+"："+err.Error(), logTask)
	}
	queryTask := *task
	data, _ := json.Marshal(input)
	queryTask.InputJSON = string(data)
	queryCtx := ctx
	if bindTaskCtx != nil {
		queryCtx = bindTaskCtx(queryCtx, queryTask)
	}
	queryCtx = WithProviderRequestKind(queryCtx, "cancel-query")
	outcome, providerStatus, err := QueryProviderCancellation(queryCtx, input.Config, task.ProviderRequestID)
	if err != nil {
		if task.ProviderCancelAttempts >= ProviderCancellationMaxAttempts-1 {
			return MarkProviderCancellationUncertain(repo, task, providerCancellationUncertainMessage("连续查询上游取消状态失败")+"："+SafeProviderLogError(err), logTask)
		}
		next := time.Now().Add(30 * time.Second)
		return repo.UpdateTaskProviderCancellation(task.ID, model.ProviderCancelStatusRequested, model.ProviderCancelStatusRequested, SafeProviderLogError(err), &next, nil)
	}
	switch outcome {
	case ProviderCancellationConfirmed:
		now := time.Now()
		if err := repo.UpdateTaskProviderCancellation(task.ID, model.ProviderCancelStatusRequested, model.ProviderCancelStatusConfirmed, "", nil, &now); err != nil {
			return err
		}
		if logTask != nil {
			_ = logTask(task.UserID, task.ID, "info", "上游已确认取消", providerStatus)
		}
	case ProviderCancellationSucceeded:
		errorText := "取消请求发出前上游已完成"
		if err := repo.UpdateTaskProviderCancellation(task.ID, model.ProviderCancelStatusRequested, model.ProviderCancelStatusUncertain, errorText, nil, nil); err != nil {
			return err
		}
		if logTask != nil {
			_ = logTask(task.UserID, task.ID, "warn", "上游任务在取消确认前已完成", providerStatus)
		}
	case ProviderCancellationFailed:
		errorText := "上游任务已失败，取消状态无法确认"
		if err := repo.UpdateTaskProviderCancellation(task.ID, model.ProviderCancelStatusRequested, model.ProviderCancelStatusUncertain, errorText, nil, nil); err != nil {
			return err
		}
		if logTask != nil {
			_ = logTask(task.UserID, task.ID, "warn", errorText, providerStatus)
		}
	default:
		next := time.Now().Add(15 * time.Second)
		return repo.UpdateTaskProviderCancellation(task.ID, model.ProviderCancelStatusRequested, model.ProviderCancelStatusRequested, "", &next, nil)
	}
	return nil
}

func ProviderCancellationUncertainMessage(base string) string {
	return providerCancellationUncertainMessage(base)
}

func providerCancellationUncertainMessage(base string) string {
	return base + "，取消状态待确认"
}

func DeferProviderCancellation(repo *repository.Repository, task *model.Task, errorText string) error {
	next := time.Now().Add(30 * time.Second)
	return repo.UpdateTaskProviderCancellation(task.ID, model.ProviderCancelStatusRequested, model.ProviderCancelStatusRequested, truncateRunes(errorText, 1000), &next, nil)
}

func MarkProviderCancellationUncertain(repo *repository.Repository, task *model.Task, errorText string, logTask func(userID, taskID, level, msg, payload string) error) error {
	message := truncateRunes(errorText, 1000)
	if err := repo.UpdateTaskProviderCancellation(task.ID, model.ProviderCancelStatusRequested, model.ProviderCancelStatusUncertain, message, nil, nil); err != nil {
		return err
	}
	if logTask != nil {
		_ = logTask(task.UserID, task.ID, "warn", "上游取消无法确认", message)
	}
	return nil
}

func ProviderCancellationInput(task *model.Task, decryptInput func(string) (string, error), resolveConfig func(Config) (Config, error)) (Input, error) {
	decrypted, err := decryptInput(task.InputJSON)
	if err != nil {
		return Input{}, err
	}
	var input Input
	if err := json.Unmarshal([]byte(decrypted), &input); err != nil {
		return Input{}, err
	}
	config, err := resolveConfig(input.Config)
	if err != nil {
		return Input{}, err
	}
	input.Config = config
	return input, nil
}

func SupportsProviderCancellation(interfaceType string) bool {
	return interfaceType == string(model.ChannelInterfaceGeminiVeo) || model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(interfaceType))
}

func CancelProviderTask(ctx context.Context, config Config, providerRequestID string) error {
	if IsLikeAIUpscaleModel(config.Model) {
		return errors.New("LikeAI 未声明上游取消接口；停止本机等待不代表退款")
	}
	if UpscaleMediaType(config.Model) != "" {
		return CancelUpscale(ctx, config, providerRequestID)
	}
	switch {
	case config.InterfaceType == string(model.ChannelInterfaceGeminiVeo):
		path := "/" + strings.TrimLeft(providerRequestID, "/") + ":cancel"
		return PostGeminiJSON(ctx, config, path, map[string]any{}, &map[string]any{})
	case model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(config.InterfaceType)):
		path := "/contents/generations/tasks/" + url.PathEscape(providerRequestID)
		return DeleteProviderTask(ctx, config, path)
	default:
		return errors.New("当前上游协议不支持取消")
	}
}

func DeleteProviderTask(ctx context.Context, config Config, path string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, APIURL(config.BaseURL, path), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	outbound.ApplyOutboundHeaders(req, config.Headers)
	data, _, err := DoBinary(req)
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(data)) > 0 && !json.Valid(data) {
		return errors.New("上游取消接口返回了无法识别的内容")
	}
	return nil
}

func QueryProviderCancellation(ctx context.Context, config Config, providerRequestID string) (ProviderCancellationOutcome, string, error) {
	if IsLikeAIUpscaleModel(config.Model) {
		return "", "", errors.New("LikeAI 未声明上游取消接口")
	}
	if UpscaleMediaType(config.Model) != "" {
		status, err := QueryUpscaleStatus(ctx, config, providerRequestID)
		if err != nil {
			return "", "", err
		}
		switch status {
		case "cancelled":
			return ProviderCancellationConfirmed, status, nil
		case "completed":
			return ProviderCancellationSucceeded, status, nil
		case "failed":
			return ProviderCancellationFailed, status, nil
		default:
			return ProviderCancellationPending, status, nil
		}
	}
	switch {
	case config.InterfaceType == string(model.ChannelInterfaceGeminiVeo):
		var operation geminiOperation
		if err := GetGeminiJSON(ctx, config, "/"+strings.TrimLeft(providerRequestID, "/"), &operation); err != nil {
			return "", "", err
		}
		if done, _ := operation["done"].(bool); !done {
			return ProviderCancellationPending, "running", nil
		}
		if errorValue, ok := operation["error"].(map[string]any); ok {
			code := strings.TrimSpace(fmt.Sprint(errorValue["code"]))
			message := strings.ToLower(stringField(errorValue, "message"))
			if code == "1" || code == "1.0" || strings.Contains(message, "cancel") {
				return ProviderCancellationConfirmed, "cancelled", nil
			}
			return ProviderCancellationFailed, firstNonEmpty(message, "failed"), nil
		}
		return ProviderCancellationSucceeded, "succeeded", nil
	case model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(config.InterfaceType)):
		var state map[string]any
		if err := GetJSON(ctx, config, "/contents/generations/tasks/"+url.PathEscape(providerRequestID), &state); err != nil {
			return "", "", err
		}
		if data, ok := state["data"].(map[string]any); ok {
			state = data
		}
		status := strings.ToLower(strings.TrimSpace(stringField(state, "status")))
		switch status {
		case "cancelled", "canceled":
			return ProviderCancellationConfirmed, status, nil
		case "succeeded", "completed":
			return ProviderCancellationSucceeded, status, nil
		case "failed", "expired":
			return ProviderCancellationFailed, status, nil
		case "queued", "running", "processing", "pending":
			return ProviderCancellationPending, status, nil
		default:
			return ProviderCancellationPending, firstNonEmpty(status, "unknown"), nil
		}
	default:
		return "", "", errors.New("当前上游协议不支持取消状态查询")
	}
}

func stringAnyValue(value any) string {
	switch current := value.(type) {
	case nil:
		return ""
	case string:
		return current
	case fmt.Stringer:
		return current.String()
	default:
		return fmt.Sprint(current)
	}
}

func ResolveManagedBeefAPISecrets(input map[string]any, beef *beefapi.Service, readLocalConfig func() ([]byte, error)) (map[string]any, error) {
	if input == nil {
		return input, nil
	}
	config, ok := input["config"].(map[string]any)
	if !ok {
		return input, nil
	}
	channelID := strings.TrimSpace(stringAnyValue(config["channelId"]))
	credentialRef := strings.TrimSpace(stringAnyValue(config["credentialRef"]))
	baseURL := strings.TrimSpace(stringAnyValue(config["baseUrl"]))
	if !beefapi.IsManagedChannel(channelID, credentialRef, baseURL) && !HasLegacyBeefAPIKey(channelID, baseURL, beef, readLocalConfig) {
		return input, nil
	}
	apiKey, resolvedBase, accountID, tokenID, err := LookupBeefAPICredential(beef, readLocalConfig)
	if err != nil {
		var structured *kernel.AppError
		if errors.As(err, &structured) && structured.Reason == "local_credential_failed" {
			copied := *structured
			copied.Message = "尚未提交生成。" + structured.Message
			return nil, &copied
		}
		return nil, err
	}
	if apiKey == "" {
		return input, nil
	}
	next := make(map[string]any, len(config)+4)
	for key, value := range config {
		switch key {
		case "apiKey", "credentialRef":
			continue
		default:
			next[key] = value
		}
	}
	if channelID == beefapi.ChannelID {
		delete(next, "channelId")
	}
	next["apiKey"] = apiKey
	if strings.TrimSpace(stringAnyValue(next["baseUrl"])) == "" || beefapi.IsEnterpriseBaseURL(baseURL) || channelID == beefapi.ChannelID || credentialRef == beefapi.CredentialRef {
		next["baseUrl"] = resolvedBase
	}
	next["credentialRef"] = beefapi.CredentialRef
	if accountID != "" {
		next["managedAccountId"] = accountID
	}
	if tokenID != "" {
		next["managedTokenId"] = tokenID
	}
	input["config"] = next
	return input, nil
}

func LookupBeefAPICredential(beef *beefapi.Service, readLocalConfig func() ([]byte, error)) (apiKey, baseURL, accountID, tokenID string, err error) {
	if beef != nil {
		if beef.HasManagedCredential() {
			cred, resolveErr := beef.Resolve()
			if resolveErr != nil {
				var structured *kernel.AppError
				if errors.As(resolveErr, &structured) {
					return "", "", "", "", structured
				}
				return "", "", "", "", BadAuthRequest(resolveErr.Error())
			}
			return cred.APIKey, cred.BaseURL, cred.AccountID, cred.TokenID, nil
		}
	}
	if readLocalConfig == nil {
		return "", "", "", "", nil
	}
	body, readErr := readLocalConfig()
	if readErr != nil || len(body) == 0 {
		return "", "", "", "", nil
	}
	var config struct {
		Channels []struct {
			ID      string `json:"id"`
			APIKey  string `json:"apiKey"`
			BaseURL string `json:"baseUrl"`
		} `json:"channels"`
	}
	if json.Unmarshal(body, &config) != nil {
		return "", "", "", "", nil
	}
	for _, channel := range config.Channels {
		if channel.ID == beefapi.ChannelID && strings.TrimSpace(channel.APIKey) != "" {
			base := strings.TrimSpace(channel.BaseURL)
			if base == "" {
				base = beefapi.LegacyOrigin
			}
			return channel.APIKey, base, "", "", nil
		}
	}
	return "", "", "", "", nil
}

func HasLegacyBeefAPIKey(channelID, baseURL string, beef *beefapi.Service, readLocalConfig func() ([]byte, error)) bool {
	if channelID != beefapi.ChannelID && !beefapi.IsEnterpriseBaseURL(baseURL) {
		return false
	}
	apiKey, _, _, _, err := LookupBeefAPICredential(beef, readLocalConfig)
	return err == nil && apiKey != ""
}

func ResolveChannelModelsRequest(input *ChannelModelsRequest, beef *beefapi.Service, readLocalConfig func() ([]byte, error)) error {
	if input == nil {
		return nil
	}
	if !beefapi.IsManagedChannel(input.ChannelID, input.CredentialRef, input.BaseURL) && input.ChannelID != beefapi.ChannelID {
		return nil
	}
	apiKey, baseURL, _, _, err := LookupBeefAPICredential(beef, readLocalConfig)
	if err != nil {
		return err
	}
	if apiKey == "" {
		return nil
	}
	input.APIKey = apiKey
	input.BaseURL = baseURL
	input.CredentialRef = beefapi.CredentialRef
	return nil
}

func ResolveCustomRelayKey(targetURL, incoming string, beef *beefapi.Service, readLocalConfig func() ([]byte, error)) (string, error) {
	if beef != nil && beef.HasManagedCredential() && !SameCredentialOrigin(targetURL, beef.Origin()) {
		return incoming, nil
	}
	apiKey, baseURL, _, _, err := LookupBeefAPICredential(beef, readLocalConfig)
	if err != nil {
		return "", err
	}
	if apiKey == "" || !SameCredentialOrigin(targetURL, baseURL) {
		return incoming, nil
	}
	return apiKey, nil
}

func SameCredentialOrigin(targetURL, baseURL string) bool {
	target, targetErr := url.Parse(strings.TrimSpace(targetURL))
	base, baseErr := url.Parse(strings.TrimSpace(baseURL))
	if targetErr != nil || baseErr != nil || target.User != nil || base.User != nil || target.Host == "" || base.Host == "" {
		return false
	}
	if target.Scheme != "https" && target.Scheme != "http" {
		return false
	}
	return strings.EqualFold(target.Scheme, base.Scheme) && strings.EqualFold(target.Host, base.Host)
}

func NoteBeefAPIProviderError(beef *beefapi.Service, message string) {
	if beef == nil {
		return
	}
	normalized := strings.ToLower(message)
	if strings.Contains(normalized, "unauthorized") || strings.Contains(message, "连接已失效") {
		beef.MarkRevoked()
	}
	if strings.Contains(message, "额度不足") || strings.Contains(normalized, "insufficient") || strings.Contains(message, "余额不足") {
		beef.MarkZeroBalance()
	}
}

func PortraitModel(id string) bool {
	return id == "seedance-2.0-portrait" || id == "seedance-2.5-portrait"
}

func ValidatePortraitTaskQuote(dataDir string, input map[string]any, lookupCred func() (string, string, string, string, error)) error {
	config, _ := input["config"].(map[string]any)
	modelID := strings.TrimSpace(stringAnyValue(config["model"]))
	modelKey := strings.TrimSpace(stringAnyValue(config["channelModelKey"]))
	if !PortraitModel(modelID) && !PortraitModel(modelKey) {
		return nil
	}
	unavailable := func() error {
		return BadAuthRequest("真人素材版当前模型或所选分辨率报价不可用，请刷新模型列表后重新选择")
	}
	if !PortraitModel(modelID) || (modelKey != "" && modelKey != modelID) {
		return unavailable()
	}
	var request Config
	body, err := json.Marshal(config)
	if err != nil || json.Unmarshal(body, &request) != nil {
		return unavailable()
	}
	store, err := workspace.NewProviderConfig(dataDir)
	if err != nil {
		return unavailable()
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		return unavailable()
	}
	var snapshot struct {
		Channels []struct {
			ID            string                    `json:"id"`
			Enabled       bool                      `json:"enabled"`
			BaseURL       string                    `json:"baseUrl"`
			APIKey        string                    `json:"apiKey"`
			SecretKey     string                    `json:"secretKey"`
			Headers       []outbound.OutboundHeader `json:"headers"`
			Models        []string                  `json:"models"`
			ModelProfiles []struct {
				Model        string          `json:"model"`
				VideoPricing json.RawMessage `json:"videoPricing"`
			} `json:"modelProfiles"`
		} `json:"channels"`
	}
	body, err = json.Marshal(effective.Config)
	if err != nil || json.Unmarshal(body, &snapshot) != nil {
		return unavailable()
	}
	managed := strings.TrimSpace(stringAnyValue(config["credentialRef"])) == beefapi.CredentialRef
	resolution := strings.ToLower(strings.TrimSpace(request.VQuality))
	if resolution != "" {
		resolution = modelcatalog.NormalizeVideoResolution(resolution)
	}
	if resolution == "2160p" {
		resolution = "4k"
	}
	matches, quoted := 0, false
	for _, channel := range snapshot.Channels {
		if !channel.Enabled || (managed && channel.ID != beefapi.ChannelID) {
			continue
		}
		base, key := channel.BaseURL, channel.APIKey
		if channel.ID == beefapi.ChannelID && lookupCred != nil {
			resolvedKey, resolvedBase, _, _, lookupErr := lookupCred()
			if lookupErr != nil {
				continue
			}
			base, key = resolvedBase, resolvedKey
		}
		if strings.TrimSpace(key) == "" || strings.TrimRight(strings.TrimSpace(base), "/") != strings.TrimRight(strings.TrimSpace(request.BaseURL), "/") || key != request.APIKey || channel.SecretKey != request.SecretKey || !PortraitHeadersEqual(channel.Headers, request.Headers) {
			continue
		}
		matches++
		present := false
		for _, id := range channel.Models {
			present = present || id == modelID
		}
		if !present {
			continue
		}
		for _, profile := range channel.ModelProfiles {
			if profile.Model != modelID {
				continue
			}
			pricing, valid := beefapi.NormalizeCatalogVideoPricing(profile.VideoPricing)
			if valid && pricing["mode"] == "tokens" {
				rates := pricing["rates"].(map[string]any)
				_, quoted = rates[resolution]
			}
			break
		}
	}
	if matches != 1 || !quoted {
		return unavailable()
	}
	return nil
}

func PortraitHeadersEqual(left, right []outbound.OutboundHeader) bool {
	a, errA := outbound.NormalizeOutboundHeaders(left)
	b, errB := outbound.NormalizeOutboundHeaders(right)
	if errA != nil || errB != nil {
		return false
	}
	values := func(headers []outbound.OutboundHeader) map[string]string {
		result := make(map[string]string, len(headers))
		for _, header := range headers {
			result[header.Name] = header.Value
		}
		return result
	}
	return maps.Equal(values(a), values(b))
}
