package generation

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/platform"
	"infinite-canvas/backend/internal/protocol"
	"infinite-canvas/backend/internal/repository"
)

type ChannelModelsRequest struct {
	BaseURL       string                    `json:"baseUrl"`
	APIKey        string                    `json:"apiKey"`
	APIFormat     string                    `json:"apiFormat"`
	Headers       []outbound.OutboundHeader `json:"headers"`
	ChannelID     string                    `json:"channelId"`
	CredentialRef string                    `json:"credentialRef"`
	// Protocol 是渠道默认的生成接口。它由插件 JS 实现时，模型列表交给插件，不请求 /models。
	Protocol string `json:"protocol,omitempty"`
}

func isImageRecoveryError(err error) bool {
	var recovery ImageRecoveryError
	return errors.As(err, &recovery)
}

func definiteImageThrottle(err error) bool {
	var upstream HTTPError
	return !isImageRecoveryError(err) && errors.As(err, &upstream) && upstream.StatusCode == 429 && ClassifyHTTP(upstream.StatusCode, "", upstream.Body).Category == CategoryThrottled
}

func definiteMidjourneyCountRejection(err error) bool {
	var upstream HTTPError
	if !errors.As(err, &upstream) || upstream.StatusCode < 400 {
		return false
	}
	var body struct {
		TaskID string `json:"task_id"`
		ID     string `json:"id"`
		Error  struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			TaskID  string `json:"task_id"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(upstream.Body), &body) != nil || body.TaskID != "" || body.ID != "" || body.Error.TaskID != "" {
		return false
	}
	return body.Error.Code == "invalid_request" && strings.HasPrefix(strings.ToLower(strings.TrimSpace(body.Error.Message)), "midjourney generates four images per request; n must be 4 or omitted")
}

func definiteVODImageParameterFailure(err error) bool {
	if isImageRecoveryError(err) {
		return false
	}
	var unknown SubmissionUnknownError
	if errors.As(err, &unknown) {
		return false
	}
	var upstream HTTPError
	if !errors.As(err, &upstream) || upstream.StatusCode != http.StatusBadRequest {
		return false
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(upstream.Body), &body) != nil {
		return false
	}
	return body.Error.Code == "vod_image_invalid_params" || body.Error.Code == "vod_image_invalid_media"
}

func definiteImageInputRejection(err error) bool {
	var unknown SubmissionUnknownError
	var pending StatePendingError
	var upstream HTTPError
	if isImageRecoveryError(err) || errors.As(err, &unknown) || errors.As(err, &pending) || !errors.As(err, &upstream) || upstream.IdempotencyReplayed {
		return false
	}
	if upstream.StatusCode != http.StatusBadRequest && upstream.StatusCode != http.StatusUnprocessableEntity {
		return false
	}
	failure := ClassifyHTTP(upstream.StatusCode, "", upstream.Body)
	if failure.Uncertain || failure.TaskID != "" || strings.Contains(upstream.Body, "upstream_task_id:") {
		return false
	}
	var body map[string]any
	if json.Unmarshal([]byte(upstream.Body), &body) == nil && imageRejectionHasJob(body, 0) {
		return false
	}
	switch failure.Category {
	case CategoryInvalidParams, CategoryModerationInput, CategoryModerationReference,
		CategoryInputTooLarge, CategoryInputInaccessible, CategoryContextTooLong:
		return true
	}
	return false
}

func imageRejectionHasJob(body map[string]any, depth int) bool {
	if depth > 8 {
		return true
	}
	for _, key := range []string{"id", "task_id", "taskId"} {
		if value := body[key]; value != nil && value != "" {
			return true
		}
	}
	for _, key := range []string{"data", "error", "output"} {
		if child, ok := body[key].(map[string]any); ok && imageRejectionHasJob(child, depth+1) {
			return true
		}
		if children, ok := body[key].([]any); ok && len(children) > 0 {
			return true
		}
	}
	return false
}

func managedFailureInfo(err error) (statusCode int, explicitRejection, terminalFailure bool) {
	var managedHTTP *beeftv.MediaHTTPError
	if errors.As(err, &managedHTTP) {
		statusCode = managedHTTP.StatusCode
		explicitRejection = beeftv.IsDefiniteMediaRejection(err)
	}
	var managedTask *beeftv.MediaTaskError
	if errors.As(err, &managedTask) && !managedTask.Pending() {
		if managedTask.Code == "media_submission_rejected" && strings.TrimSpace(managedTask.TaskID) == "" {
			explicitRejection = true
		} else {
			terminalFailure = true
		}
	}
	return statusCode, explicitRejection, terminalFailure
}

func RouteFailureInfo(err error) modelcatalog.FailureInfo {
	info := modelcatalog.FailureInfo{}
	if err == nil {
		return info
	}
	var unknown SubmissionUnknownError
	if errors.As(err, &unknown) {
		return info
	}
	if isImageRecoveryError(err) {
		info.ImageRecovery = true
	}
	if code, _ := platform.ChannelSlotFailureDetails(err); code != "" {
		info.SlotCode = code
	}
	var upstream HTTPError
	if errors.As(err, &upstream) {
		info.StatusCode = upstream.StatusCode
		info.RetryAfter = upstream.RetryAfter
	}
	if status, rejected, terminal := managedFailureInfo(err); status > 0 || rejected || terminal {
		if status > 0 {
			info.StatusCode = status
		}
		info.ExplicitRejection = info.ExplicitRejection || rejected
		info.TerminalProviderFailure = info.TerminalProviderFailure || terminal
	}
	info.ImageThrottle = definiteImageThrottle(err)
	var rejection SubmissionRejectedError
	info.ExplicitRejection = info.ExplicitRejection || definiteMidjourneyCountRejection(err) || errors.As(err, &rejection)
	if definiteVODImageParameterFailure(err) {
		info.TerminalProviderFailure = strings.Contains(upstream.Body, "upstream_task_id:")
		if !info.TerminalProviderFailure {
			info.ExplicitRejection = true
		}
	}
	var preparation RequestPreparationError
	info.PreparationFailed = errors.As(err, &preparation)
	info.Canceled = errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
	return info
}

func RouteFailureCode(err error) string {
	return modelcatalog.RouteFailureCode(RouteFailureInfo(err))
}

func SafeCatalogRouteRejection(err error) bool {
	return modelcatalog.SafeRouteRejection(RouteFailureInfo(err))
}

func CreateDirectTaskAttempt(repo *repository.Repository, task *model.Task) (*model.RouteAttempt, error) {
	if task.Attempts > 1 && task.ProviderRequestID == "" {
		return nil, modelcatalog.DispatchUncertainError{Message: "旧任务已尝试执行但缺少提交记录，为避免重复创建上游任务已停止自动重发"}
	}
	id, err := repo.NextPrefixedID("ATTEMPT")
	if err != nil {
		return nil, err
	}
	attempt := &model.RouteAttempt{ID: id, TaskID: task.ID, RouteRun: task.RouteRun, AttemptNumber: 1, ChannelModelID: task.ChannelModelID, Status: "selected", DispatchState: "not_sent", StartedAt: time.Now()}
	if task.ProviderRequestID != "" {
		attempt.ProviderRequestID, attempt.DispatchState = task.ProviderRequestID, "accepted"
	}
	if err := repo.CreateRouteAttempt(attempt); err != nil {
		return nil, err
	}
	return attempt, nil
}

func managedTaskConnection(task model.Task) bool {
	return beeftv.IsManagedTaskInput(task.InputJSON)
}

func BeginTaskRouteAttempt(
	repo *repository.Repository,
	router *modelcatalog.Router,
	store modelcatalog.RouteStore,
	codec modelcatalog.TaskInputCodec,
	hasManagedReceipt func(task model.Task, row *model.ImageSubmission) bool,
	retryRejectedImage func(task *model.Task, previous *model.RouteAttempt, taskErr error) (*model.RouteAttempt, error),
	task *model.Task,
) (*model.RouteAttempt, error) {
	if task == nil {
		return nil, nil
	}
	attempts, err := repo.RouteAttempts(task.ID, task.RouteRun)
	if err != nil {
		return nil, err
	}
	image := modelcatalog.ImageSubmissionView{}
	if len(attempts) > 0 {
		existing := &attempts[len(attempts)-1]
		if managedTaskConnection(*task) || existing.ChannelID == beeftv.ChannelID {
			managedReceipt := false
			if task.Type != "canvas_image" && existing.DispatchState != "not_sent" {
				if row, err := repo.ImageSubmission(existing.ID, task.ID, task.UserID); err == nil && hasManagedReceipt != nil {
					managedReceipt = hasManagedReceipt(*task, row)
				}
			}
			if task.Type == "canvas_image" && existing.DispatchState != "not_sent" {
				if _, err := repo.ImageSubmission(existing.ID, task.ID, task.UserID); err != nil {
					return nil, ImageRecoveryError{Cause: errors.New("原任务发送信息暂不可用，尚未确认结果")}
				}
			}
			if existing.DispatchState == "not_sent" || existing.ProviderRequestID != "" || managedReceipt || (task.Type == "canvas_image" && (existing.DispatchState == "accepted" || existing.DispatchState == "submission_unknown")) {
				if task.ProviderRequestID == "" && existing.ProviderRequestID != "" {
					task.ProviderRequestID = existing.ProviderRequestID
					if err := repo.UpdateTaskProviderState(task.ID, task.ProviderRequestID, task.PollStage, task.NextPollAt); err != nil {
						return nil, err
					}
				}
				return existing, nil
			}
			return nil, ImageRecoveryError{Cause: errors.New("原任务已提交，尚未确认结果")}
		}
		if task.Type == "canvas_image" && (existing.DispatchState == "submission_unknown" || existing.DispatchState == "accepted") {
			image = modelcatalog.ImageSubmissionViewFromRepo(repo, existing, task)
		}
	}
	decision := modelcatalog.DecideExistingAttempt(task, attempts, image)
	switch decision.Action {
	case modelcatalog.AttemptReuse:
		return decision.Attempt, nil
	case modelcatalog.AttemptReuseAccepted:
		if decision.SyncProviderRequest {
			task.ProviderRequestID = decision.Attempt.ProviderRequestID
			if err := repo.UpdateTaskProviderState(task.ID, task.ProviderRequestID, task.PollStage, task.NextPollAt); err != nil {
				return nil, err
			}
		}
		if decision.MarkAccepted {
			decision.Attempt.DispatchState = "accepted"
			if err := repo.SaveRouteAttempt(decision.Attempt); err != nil {
				return nil, err
			}
		}
		return decision.Attempt, nil
	case modelcatalog.AttemptUncertain, modelcatalog.AttemptFail:
		return nil, decision.Error
	case modelcatalog.AttemptRetryImage:
		if next, err := retryRejectedImage(task, decision.Attempt, HTTPError{StatusCode: 429, Body: `{"error":{"code":"rate_limit_exceeded"}}`}); next != nil || err != nil {
			return next, err
		}
		return nil, errors.New("上游已拒绝本次图片请求，请查看失败原因")
	case modelcatalog.AttemptSwitchRoute:
		return router.SwitchTaskToNextRoute(store, codec, task, attempts)
	case modelcatalog.AttemptCreateDirect:
		return CreateDirectTaskAttempt(repo, task)
	case modelcatalog.AttemptCreateSelected:
		routed, routeErr := router.RoutedModelForTaskSelection(store, task)
		if routeErr != nil {
			return router.SwitchTaskToNextRoute(store, codec, task, attempts)
		}
		return router.CreateRouteAttempt(store, task, routed, len(attempts)+1)
	default:
		if task.LogicalModelID == "" {
			return CreateDirectTaskAttempt(repo, task)
		}
		routed, routeErr := router.RoutedModelForTaskSelection(store, task)
		if routeErr != nil {
			return router.SwitchTaskToNextRoute(store, codec, task, attempts)
		}
		return router.CreateRouteAttempt(store, task, routed, len(attempts)+1)
	}
}

func NextRouteAttemptAfterFailure(
	repo *repository.Repository,
	router *modelcatalog.Router,
	store modelcatalog.RouteStore,
	codec modelcatalog.TaskInputCodec,
	resolveImageRecoveryConfig func(model.Task) (Config, bool),
	retryRejectedImage func(task *model.Task, previous *model.RouteAttempt, taskErr error) (*model.RouteAttempt, error),
	task *model.Task,
	attempt *model.RouteAttempt,
	taskErr error,
) (*model.RouteAttempt, error) {
	if task != nil && resolveImageRecoveryConfig != nil {
		if config, ok := resolveImageRecoveryConfig(*task); ok && config.CredentialRef == beeftv.CredentialRef {
			return nil, nil
		}
	}
	info := RouteFailureInfo(taskErr)
	if task != nil && task.Type == "canvas_image" && attempt != nil {
		if !modelcatalog.ShouldRetryImageThrottle(task, attempt, info) {
			return nil, nil
		}
		if _, err := repo.ImageSubmission(attempt.ID, task.ID, task.UserID); err != nil {
			return nil, nil
		}
		return retryRejectedImage(task, attempt, taskErr)
	}
	if !modelcatalog.ShouldSwitchRouteAfterFailure(task, attempt, info) {
		return nil, nil
	}
	router.BlockLogicalRouteForFailure(attempt, info)
	attempts, err := repo.RouteAttempts(task.ID, task.RouteRun)
	if err != nil {
		return nil, err
	}
	return router.SwitchTaskToNextRoute(store, codec, task, attempts)
}

func FinishTaskRouteAttempt(
	repo *repository.Repository,
	store modelcatalog.RouteStore,
	attempt *model.RouteAttempt,
	task *model.Task,
	taskErr error,
	failureMessage string,
) {
	image := modelcatalog.ImageSubmissionView{}
	info := RouteFailureInfo(taskErr)
	if task != nil && task.Type == "canvas_image" {
		image = modelcatalog.ImageSubmissionViewFromRepo(repo, attempt, task)
		info.ExplicitRejection = info.ExplicitRejection || definiteImageInputRejection(taskErr)
	}
	modelcatalog.FinishRouteAttempt(store, attempt, task, taskErr, failureMessage, info, image, time.Now)
}

func TestAdminChannelModel(
	ctx context.Context,
	requireAdmin func(*model.User) error,
	adminChannel func(string) (*model.ModelChannel, error),
	normalize func(*model.ModelChannel, modelcatalog.ChannelModelRequest) (string, string, string, model.ChannelInterfaceType, error),
	bindRuntime func(context.Context, CallMeta) context.Context,
	registry *protocol.Registry,
	actor *model.User,
	channelID string,
	req modelcatalog.ChannelModelRequest,
) (*modelcatalog.AdminChannelModelTestResult, error) {
	if err := requireAdmin(actor); err != nil {
		return nil, err
	}
	channel, err := adminChannel(channelID)
	if err != nil {
		return nil, err
	}
	modelKey, providerModelKey, capability, proto, err := normalize(channel, req)
	if err != nil {
		return nil, err
	}
	if capability == "text" || capability == "image" || capability == "video" {
		if _, err := modelcatalog.NormalizeModelCapabilityConfigForModel(capability, string(proto), providerModelKey, req.CapabilityConfig); err != nil {
			return nil, err
		}
	}
	if strings.TrimSpace(channel.BaseURL) == "" || strings.TrimSpace(channel.APIKey) == "" {
		return nil, kernel.BadAuthRequest("请先在渠道中配置 Base URL 和 API Key")
	}
	if _, err := outbound.ValidateOutboundURL(channel.BaseURL); err != nil {
		return nil, err
	}
	headers, err := outbound.ParseOutboundHeadersJSON(channel.HeadersJSON)
	if err != nil {
		return nil, err
	}

	prompt := map[string]string{
		"text":  "Reply with OK.",
		"image": "A simple gray circle on a white background.",
		"video": "A static gray circle on a white background.",
		"audio": "Model test.",
	}[capability]
	videoSeconds := "6"
	videoSecondsValue := 6
	if proto == model.ChannelInterfaceVolcengineJiMengVideo {
		videoSeconds = "5"
		videoSecondsValue = 5
	}
	imageSize, imageQuality := "", ""
	var imageProfile *modelcatalog.ImageCapabilityConfig
	videoRatio, videoResolution := modelcatalog.VideoTestDefaults(nil)
	var videoProfile *modelcatalog.VideoCapabilityConfig
	switch capability {
	case "image":
		profile, normalizeErr := modelcatalog.NormalizeModelCapabilityConfigForModel(capability, string(proto), providerModelKey, req.CapabilityConfig)
		if normalizeErr != nil {
			return nil, normalizeErr
		}
		imageProfile = profile.Image
		imageSize, imageQuality = modelcatalog.ImageTestDefaults(imageProfile)
	case "video":
		profile, normalizeErr := modelcatalog.NormalizeModelCapabilityConfigForModel(capability, string(proto), providerModelKey, req.CapabilityConfig)
		if normalizeErr != nil {
			return nil, normalizeErr
		}
		videoProfile = profile.Video
		videoRatio, videoResolution = modelcatalog.VideoTestDefaults(videoProfile)
	}
	input := Input{
		Mode:   capability,
		Prompt: prompt,
		Config: Config{
			ChannelID:          channel.ID,
			APIFormat:          channel.APIFormat,
			InterfaceType:      string(proto),
			BaseURL:            channel.BaseURL,
			APIKey:             channel.APIKey,
			SecretKey:          channel.SecretKey,
			Headers:            headers,
			Model:              providerModelKey,
			ChannelModelKey:    modelKey,
			Size:               map[string]string{"image": imageSize, "video": videoRatio}[capability],
			Quality:            imageQuality,
			Count:              "1",
			VideoSeconds:       videoSeconds,
			VQuality:           videoResolution,
			VideoGenerateAudio: "false",
			VideoWatermark:     "false",
			AudioVoice:         "alloy",
			AudioFormat:        "mp3",
			AudioSpeed:         "1",
		},
		Metadata: map[string]interface{}{},
	}
	if capability == "image" {
		input.ImageCapability = imageProfile
	}
	if capability == "video" {
		input.VideoCapability = videoProfile
	}

	testCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	meta := CallMeta{
		UserID: actor.ID, ChannelID: channel.ID, Capability: capability,
		Operation: "admin_model_test", Model: modelKey, VideoSeconds: videoSecondsValue,
	}
	if bindRuntime != nil {
		testCtx = bindRuntime(testCtx, meta)
	}
	testCtx = context.WithValue(testCtx, AnalyticsKey{}, AnalyticsContext{
		UserID: actor.ID, ChannelID: channel.ID, Capability: capability,
		Operation: "admin_model_test", Model: modelKey, VideoSeconds: videoSecondsValue,
	})
	testCtx = WithProtocolRegistry(testCtx, registry)
	startedAt := time.Now()
	switch capability {
	case "text":
		_, err = RunTextTask(testCtx, input)
	case "image":
		_, err = RunImageTask(testCtx, input)
	case "video":
		_, err = RunVideoTask(testCtx, input)
	case "audio":
		_, err = RunAudioTask(testCtx, input)
	}
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
		}
		return nil, kernel.WrapAppError(status, "模型测试失败："+PersistableTaskFailureMessage(err), err)
	}
	return &modelcatalog.AdminChannelModelTestResult{DurationMs: time.Since(startedAt).Milliseconds()}, nil
}

func FetchChannelModelCatalog(
	ctx context.Context,
	actor *model.User,
	input ChannelModelsRequest,
	resolveReq func(*ChannelModelsRequest) error,
	fetchBytes func(context.Context, string, string, string, []modelcatalog.ChannelHeader) ([]byte, error),
	extra modelcatalog.CatalogExtraSource,
	resolveProtocol func(string) (protocol.Adapter, bool),
) ([]modelcatalog.ChannelModelCatalogItem, error) {
	if actor == nil || strings.TrimSpace(actor.ID) == "" {
		return nil, kernel.Unauthorized("请先登录")
	}
	if resolveReq != nil {
		if err := resolveReq(&input); err != nil {
			return nil, err
		}
	}
	if id := strings.TrimSpace(input.Protocol); id != "" && resolveProtocol != nil {
		if adapter, ok := resolveProtocol(id); ok {
			if provider, ok := adapter.(protocol.ModuleProvider); ok {
				return ListModuleProviderModels(ctx, provider, strings.TrimSpace(input.BaseURL), strings.TrimSpace(input.APIKey))
			}
		}
	}
	headers, err := outbound.NormalizeOutboundHeaders(input.Headers)
	if err != nil {
		return nil, err
	}
	catalog, err := modelcatalog.LoadChannelModelCatalog(ctx, fetchBytes, input.BaseURL, input.APIFormat, input.APIKey, headers, extra)
	if err != nil {
		return nil, MapChannelModelCatalogError(err)
	}
	return catalog, nil
}

func FetchChannelModelCatalogBytes(ctx context.Context, baseURL, apiFormat, apiKey string, headers []modelcatalog.ChannelHeader) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	target := ChannelCatalogURL(baseURL, apiFormat)
	if _, err := outbound.ValidateOutboundURL(target); err != nil {
		return nil, CatalogError(http.StatusBadRequest, "catalog_address_invalid", err.Error(), err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, kernel.BadAuthRequest("模型服务地址无效")
	}
	if apiFormat == "gemini" {
		request.Header.Set("x-goog-api-key", apiKey)
	} else {
		request.Header.Set("Authorization", "Bearer "+apiKey)
	}
	outbound.ApplyOutboundHeaders(request, headers)
	data, _, err := DoBinary(request)
	if err != nil {
		var httpErr HTTPError
		if errors.As(err, &httpErr) {
			return nil, modelcatalog.CatalogFetchError{StatusCode: httpErr.StatusCode, Cause: err}
		}
		return nil, modelcatalog.CatalogFetchError{Cause: err}
	}
	return data, nil
}

func MapChannelModelCatalogError(err error) error {
	if err == nil {
		return nil
	}
	var fetchErr modelcatalog.CatalogFetchError
	if errors.As(err, &fetchErr) {
		return ChannelModelsUpstreamError(fetchErr.Cause)
	}
	var jsonErr modelcatalog.CatalogJSONError
	if errors.As(err, &jsonErr) {
		return CatalogError(http.StatusBadGateway, "catalog_response_invalid", "模型目录响应格式不兼容，需要 OpenAI data 数组或 Gemini models 数组", jsonErr.Cause)
	}
	var rejected modelcatalog.CatalogUpstreamRejectedError
	if errors.As(err, &rejected) {
		return CatalogError(http.StatusBadGateway, "catalog_upstream_rejected", rejected.Error(), err)
	}
	return err
}

func ChannelModelsUpstreamError(err error) error {
	var network net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &network) && network.Timeout()) {
		return CatalogError(http.StatusGatewayTimeout, "catalog_timeout", "读取模型目录超时，请检查渠道地址和网络后重试", err)
	}
	var authErr *kernel.AppError
	if errors.As(err, &authErr) {
		return authErr
	}
	var httpErr HTTPError
	if !errors.As(err, &httpErr) {
		return CatalogError(http.StatusBadGateway, "catalog_network_failed", "连接模型服务失败，请检查渠道地址和网络", err)
	}
	switch httpErr.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return CatalogError(http.StatusBadGateway, "catalog_auth_failed", "模型服务鉴权失败，请检查 API Key 或服务商访问权限", err)
	case http.StatusNotFound:
		return CatalogError(http.StatusBadGateway, "catalog_unsupported", "模型服务未提供此模型目录接口，请核对地址或手动添加模型", err)
	case http.StatusMethodNotAllowed, http.StatusNotImplemented:
		return CatalogError(http.StatusBadGateway, "catalog_unsupported", "模型服务不支持读取模型目录，请手动添加模型", err)
	case http.StatusTooManyRequests:
		return CatalogError(http.StatusBadGateway, "catalog_rate_limited", "模型服务请求过于频繁或额度不足", err)
	default:
		return CatalogError(http.StatusBadGateway, "catalog_upstream_failed", httpErr.Error(), err)
	}
}

func CatalogError(status int, reason kernel.ErrorReason, message string, cause error) *kernel.AppError {
	err := kernel.WrapAppError(status, message, cause)
	err.Reason = reason
	return err
}

func ValidateTaskCapability(
	input map[string]any,
	resolveVideoCapability func(context.Context, *Input) error,
	lookup modelcatalog.ChannelModelLookup,
) error {
	encoded, err := json.Marshal(input)
	if err != nil {
		return kernel.BadAuthRequest("任务输入格式无效")
	}
	var taskInput Input
	if err := json.Unmarshal(encoded, &taskInput); err != nil {
		return kernel.BadAuthRequest("任务参数格式无效，请检查模型设置后重新提交")
	}
	if taskInput.Mode != "image" && taskInput.Mode != "video" && taskInput.Mode != "audio" {
		return nil
	}
	if taskInput.Config.CredentialRef == beeftv.CredentialRef {
		if config, ok := input["config"].(map[string]any); ok {
			config["mediaProtocolVersion"] = beeftv.MediaProtocolVersion
		}
	}
	if taskInput.Mode == "video" && taskInput.Config.CredentialRef == beeftv.CredentialRef {
		if resolveVideoCapability != nil {
			if err := resolveVideoCapability(context.Background(), &taskInput); err != nil {
				return err
			}
		}
		if config, ok := input["config"].(map[string]any); ok {
			config["capabilityConfig"] = taskInput.Config.CapabilityConfig
			config["videoCapabilitiesVersion"] = taskInput.Config.VideoCapabilitiesVersion
		}
	}
	validated, err := modelcatalog.ValidateConfiguredTask(TaskInputFromCanvas(taskInput), lookup)
	if err != nil {
		return err
	}
	if config, ok := input["config"].(map[string]any); ok {
		config["vquality"] = validated.Config.VQuality
	}
	return nil
}
