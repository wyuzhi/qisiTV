package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/protocol"
	"infinite-canvas/backend/internal/provider/workflow"
	"infinite-canvas/backend/internal/repository"
)

type ProviderTaskQueryResult struct {
	Task           *model.Task `json:"task"`
	ProviderStatus string      `json:"providerStatus"`
	Recovered      bool        `json:"recovered"`
}

func StartVideoRecoveryPass(
	ctx context.Context,
	active *atomic.Bool,
	runTask func(func()) bool,
	isDraining func() bool,
	recoverBatch func(context.Context, int) error,
	logFn func(userID, taskID, level, msg, payload string) error,
) {
	if !active.CompareAndSwap(false, true) {
		return
	}
	started := runTask(func() {
		defer active.Store(false)
		if ctx.Err() != nil || (isDraining != nil && isDraining()) {
			return
		}
		bounded, cancel := context.WithTimeout(ctx, VideoRecoveryPassTimeout)
		defer cancel()
		if err := recoverBatch(bounded, VideoRecoveryBatch); err != nil && logFn != nil {
			_ = logFn("", "", "warn", "视频与超分自动取回暂缓，将稍后再试", "")
		}
	})
	if !started {
		active.Store(false)
	}
}

func RecoverFailedVideos(
	ctx context.Context,
	repo *repository.Repository,
	afterID *string,
	isDraining func() bool,
	recoverOne func(context.Context, model.Task) error,
	limit int,
) error {
	if limit <= 0 {
		limit = VideoRecoveryBatch
	}
	tasks, err := repo.FailedVideosForRecovery(*afterID, limit)
	if err != nil {
		return err
	}
	if len(tasks) == 0 && *afterID != "" {
		tasks, err = repo.FailedVideosForRecovery("", limit)
		if err != nil {
			return err
		}
	}
	var last error
	for _, candidate := range tasks {
		if ctx.Err() != nil || (isDraining != nil && isDraining()) {
			return ctx.Err()
		}
		*afterID = candidate.ID
		if err := recoverOne(ctx, candidate); err != nil && !errors.Is(err, repository.ErrTaskProviderRecoveryConflict) {
			last = err
		}
	}
	if len(tasks) < limit {
		*afterID = ""
	}
	return last
}

func VideoSettlementNeedsPolling(task model.Task) bool { return task.MediaSettlementPending() }

func VideoRecoveryNeedsPolling(task model.Task) bool {
	return task.RecoveryOutcome == nil || *task.RecoveryOutcome == "" || VideoSettlementNeedsPolling(task)
}

func VideoRecoveryPollBackoff(task model.Task, anchor time.Time) time.Duration {
	if anchor.IsZero() {
		return VideoRecoveryDefaultBackoff
	}
	switch age := time.Since(anchor); {
	case age < 10*time.Minute:
		return 15 * time.Second
	case age < time.Hour:
		return 30 * time.Second
	default:
		return 2 * time.Minute
	}
}

func WithFailedVideoRecoveryLease(
	repo *repository.Repository,
	newID func() string,
	task *model.Task,
	claimUserID string,
	fn func(*model.Task) error,
) error {
	if task == nil || task.ID == "" {
		return nil
	}
	owner := "manual-recovery:" + newID()
	if err := repo.ClaimFailedTaskProviderRecovery(task.ID, claimUserID, owner, ProviderTaskRecoveryLeaseDuration); err != nil {
		return err
	}
	defer func() { _ = repo.ReleaseTaskProviderRecovery(task.ID, owner) }()
	current, err := repo.Task(task.ID)
	if err != nil || current.LeaseOwner != owner || current.Status != model.TaskStatusFailed || !VideoRecoveryNeedsPolling(*current) {
		return err
	}
	if task.ProviderRequestID != "" && current.ProviderRequestID == "" {
		current.ProviderRequestID = task.ProviderRequestID
	}
	return fn(current)
}

func RecordFailedVideoRecoveryOutcome(
	repo *repository.Repository,
	newID func() string,
	beefOwnsConclusion func(model.Task, time.Time) bool,
	backoff func(model.Task) time.Duration,
	task *model.Task,
	claimUserID, outcome string,
) {
	if task == nil {
		return
	}
	if beefOwnsConclusion != nil && beefOwnsConclusion(*task, time.Now()) {
		DeferManagedVideoQuery(repo, newID, backoff, task, claimUserID)
		return
	}
	_ = WithFailedVideoRecoveryLease(repo, newID, task, claimUserID, func(leased *model.Task) error {
		return repo.FinishFailedVideoRecovery(*leased, &outcome, nil)
	})
	task.RecoveryOutcome = &outcome
}

func RecordMissingVideoReceiptOutcome(
	repo *repository.Repository,
	newID func() string,
	beefOwnsConclusion func(model.Task, time.Time) bool,
	backoff func(model.Task) time.Duration,
	task *model.Task,
	claimUserID string,
) {
	outcome := RecoveryUnrecoverable
	if task != nil {
		if attempt, err := repo.LatestRouteAttempt(task.ID); err == nil && attempt != nil && attempt.RouteRun == task.RouteRun && (attempt.DispatchState == "not_sent" || attempt.DispatchState == "rejected_no_job") {
			outcome = RecoveryNoResult
		}
	}
	RecordFailedVideoRecoveryOutcome(repo, newID, beefOwnsConclusion, backoff, task, claimUserID, outcome)
}

func DeferManagedVideoQuery(
	repo *repository.Repository,
	newID func() string,
	backoff func(model.Task) time.Duration,
	task *model.Task,
	user string,
) {
	next := time.Now().Add(backoff(*task))
	_ = WithFailedVideoRecoveryLease(repo, newID, task, user, func(leased *model.Task) error {
		return repo.FinishFailedVideoRecovery(*leased, nil, &next)
	})
	task.NextPollAt = &next
}

func RecoverFailedVideo(
	ctx context.Context,
	repo *repository.Repository,
	hydrateReqID func(*model.Task),
	managedQuery func(context.Context, model.Task) (bool, error),
	pastRetention func(model.Task, time.Time) bool,
	recordMissing func(*model.Task, string),
	recordUnrecoverable func(*model.Task, string),
	queryTask func(context.Context, *model.Task, string) (*ProviderTaskQueryResult, error),
	backoff func(model.Task) time.Duration,
	withLease func(*model.Task, string, func(*model.Task) error) error,
	candidate model.Task,
) error {
	task, err := repo.TaskForUser(candidate.UserID, candidate.ID)
	if err != nil {
		return err
	}
	if task.Status != model.TaskStatusFailed || !VideoRecoveryNeedsPolling(*task) {
		return nil
	}
	hydrateReqID(task)
	if strings.TrimSpace(task.ProviderRequestID) == "" {
		managed, queryErr := managedQuery(ctx, *task)
		if queryErr != nil {
			return queryErr
		}
		if !managed {
			recordMissing(task, task.UserID)
			return nil
		}
	}
	if pastRetention(*task, time.Now()) {
		recordUnrecoverable(task, task.UserID)
		return nil
	}
	res, queryErr := queryTask(ctx, task, task.UserID)
	if queryErr == nil && res != nil && res.Recovered {
		return nil
	}
	latest, loadErr := repo.TaskForUser(task.UserID, task.ID)
	if loadErr != nil {
		return loadErr
	}
	if latest.Status != model.TaskStatusFailed || !VideoRecoveryNeedsPolling(*latest) {
		return queryErr
	}
	next := time.Now().Add(backoff(*latest))
	_ = withLease(latest, latest.UserID, func(leased *model.Task) error {
		return repo.FinishFailedVideoRecovery(*leased, leased.RecoveryOutcome, &next)
	})
	return queryErr
}

func ResumeTaskDeliveryForUser(
	repo *repository.Repository,
	isPaused func(string) bool,
	resumeDownload func(model.Task) (*model.Task, error),
	deliver func(model.Task) error,
	userID, taskID string,
) (*model.Task, error) {
	task, err := repo.TaskForUser(userID, taskID)
	if err != nil {
		return nil, err
	}
	if isPaused(task.Stage) {
		resumed, err := resumeDownload(*task)
		if err != nil {
			return nil, err
		}
		task = resumed
	}
	if err := deliver(*task); err != nil {
		return nil, err
	}
	return repo.TaskForUser(userID, taskID)
}

func RecoverFailedImageForUser(
	ctx context.Context,
	repo *repository.Repository,
	deliver func(model.Task) error,
	needsPoll func(model.Task) bool,
	needsRecheck func(model.Task) bool,
	recoverImg func(context.Context, model.Task) error,
	userID, taskID string,
) (*model.Task, error) {
	task, err := repo.TaskForUser(userID, taskID)
	if err != nil {
		return nil, err
	}
	if task.Status == model.TaskStatusSucceeded {
		_ = deliver(*task)
		return repo.TaskForUser(userID, taskID)
	}
	if !needsPoll(*task) && !needsRecheck(*task) {
		return task, nil
	}
	_ = recoverImg(ctx, *task)
	updated, err := repo.TaskForUser(userID, taskID)
	if err != nil {
		return nil, err
	}
	if updated.Status == model.TaskStatusSucceeded {
		_ = deliver(*updated)
		return repo.TaskForUser(userID, taskID)
	}
	return updated, nil
}

func RecoverFailedVideoOrUpscaleForUser(
	ctx context.Context,
	repo *repository.Repository,
	deliver func(model.Task) error,
	recoverVid func(context.Context, model.Task) error,
	userID, taskID string,
) (*model.Task, error) {
	task, err := repo.TaskForUser(userID, taskID)
	if err != nil {
		return nil, err
	}
	if task.Status == model.TaskStatusSucceeded {
		_ = deliver(*task)
		return repo.TaskForUser(userID, taskID)
	}
	if !VideoRecoveryNeedsPolling(*task) {
		return task, nil
	}
	_ = recoverVid(ctx, *task)
	return repo.TaskForUser(userID, taskID)
}

type VideoTaskRecoveryDeps struct {
	Repo                  *repository.Repository
	Registry              *protocol.Registry
	NewID                 func() string
	HydrateReqID          func(*model.Task)
	DecryptTaskInput      func(string) (string, error)
	ResolveProviderConfig func(generation.Config) (generation.Config, error)
	EnsureOfficialAdapter func(context.Context, string) context.Context
	DeclarativeAdapter    func(context.Context, string) (protocol.Adapter, bool)
	BindAnalytics         func(context.Context, model.Task) context.Context
	ManagedQuery          func(ctx context.Context, task *model.Task) (unified bool, kind string, execute func(queryCtx context.Context) (result map[string]interface{}, providerStatus string, earlyResult *ProviderTaskQueryResult, err error), err error)
	QueryWorkflowVideo    func(ctx context.Context, config generation.Config, providerRequestID string) (map[string]interface{}, string, error)
	RecordMissing         func(*model.Task, string)
	RecordUnrecoverable   func(*model.Task, string)
	ClassifyOutcome       func(model.Task, string, error) string
	Backoff               func(model.Task) time.Duration
	PastRetention         func(model.Task, time.Time) bool
	AttachDelivery        func(*model.Task)
	PersistGeneratedMedia func(model.Task, map[string]interface{}) (map[string]interface{}, error)
	SaveTaskCompletion    func(*model.Task, []byte, []byte, bool) error
	RegisterOutput        func(model.Task) error
	AttachRecovered       func(*model.Task) *model.Task
	Log                   func(userID, taskID, level, msg, payload string) error
}

func QueryFailedVideoTaskWithDeps(ctx context.Context, deps VideoTaskRecoveryDeps, task *model.Task, claimUserID string) (*ProviderTaskQueryResult, error) {
	ctx = generation.WithProtocolRegistry(ctx, deps.Registry)
	if task == nil || task.ID == "" {
		return nil, kernel.BadAuthRequest("任务不存在")
	}
	if task.Status != model.TaskStatusFailed {
		return nil, kernel.BadAuthRequest("只能人工查询状态为失败的任务")
	}
	unified, managedKind, execManaged, queryErr := deps.ManagedQuery(ctx, task)
	if queryErr != nil {
		return nil, queryErr
	}
	if unified && managedKind != "video" && managedKind != "upscale" && managedKind != "audio" {
		return nil, kernel.BadAuthRequest("原任务不是视频或超分任务")
	}
	upscale := task.IsUpscale() || (unified && managedKind == "upscale")
	if !strings.HasPrefix(task.Type, "canvas_video") && !strings.HasPrefix(task.Type, "video_") && !upscale && !(unified && task.Type == "canvas_audio" && managedKind == "audio") {
		return nil, kernel.BadAuthRequest("该任务不是视频生成任务")
	}

	deps.HydrateReqID(task)
	providerRequestID := strings.TrimSpace(task.ProviderRequestID)
	if providerRequestID == "" && !unified {
		deps.RecordMissing(task, claimUserID)
		return nil, kernel.BadAuthRequest("该任务没有可恢复的上游任务 ID")
	}
	var input generation.Input
	var adapter protocol.Adapter
	var declarative, beefVideo, workflowVideo, legacyVideo bool
	var err error
	if !unified {
		decryptedInput, err := deps.DecryptTaskInput(task.InputJSON)
		if err != nil {
			return nil, fmt.Errorf("读取任务配置失败：%w", err)
		}
		if err := json.Unmarshal([]byte(decryptedInput), &input); err != nil {
			deps.RecordUnrecoverable(task, claimUserID)
			return nil, fmt.Errorf("任务输入解析失败：%w", err)
		}
		config, err := deps.ResolveProviderConfig(input.Config)
		if err != nil {
			return nil, err
		}
		ctx = deps.EnsureOfficialAdapter(ctx, config.InterfaceType)
		adapter, declarative = deps.DeclarativeAdapter(ctx, config.InterfaceType)
		beefVideo = generation.IsBeefAPIVideoConfig(ctx, config)
		workflowVideo = workflow.IsProviderInterface(config.InterfaceType)
		_, officialVideo := generation.OfficialDeclarativeVideoInterface(config.InterfaceType)
		legacyVideo = !officialVideo && (strings.TrimSpace(config.InterfaceType) == "" || generation.IsArkPlanVideoConfig(config))
		if !declarative && !beefVideo && !workflowVideo && !legacyVideo && !upscale {
			deps.RecordUnrecoverable(task, claimUserID)
			return nil, kernel.BadAuthRequest("该任务的请求协议不支持安全查询上游状态")
		}
		input.Config = config
		task.InputJSON = decryptedInput
		task.ProviderRequestID = providerRequestID
		if err := deps.Repo.UpdateTaskProviderState(task.ID, providerRequestID, task.PollStage, task.NextPollAt); err != nil {
			return nil, err
		}
	}

	owner := "manual-recovery:" + deps.NewID()
	if err := deps.Repo.ClaimFailedTaskProviderRecovery(task.ID, claimUserID, owner, ProviderTaskRecoveryLeaseDuration); err != nil {
		if errors.Is(err, repository.ErrTaskProviderRecoveryConflict) {
			return nil, &kernel.AppError{Status: 409, Message: "该任务正在查询上游状态，请稍后再试"}
		}
		return nil, err
	}
	task.LeaseOwner = owner
	defer func() {
		if releaseErr := deps.Repo.ReleaseTaskProviderRecovery(task.ID, owner); releaseErr != nil {
			_ = deps.Log(task.UserID, task.ID, "error", "人工查询租约释放失败", releaseErr.Error())
		}
	}()

	recoveryCtx, cancelRecovery := ProviderTaskRecoveryContext(ctx)
	defer cancelRecovery()
	queryCtx := deps.BindAnalytics(recoveryCtx, *task)
	var result map[string]interface{}
	var providerStatus string
	var settlement generation.BeefAPIVideoSettlement
	if unified {
		var early *ProviderTaskQueryResult
		result, providerStatus, early, err = execManaged(queryCtx)
		if early != nil {
			return early, err
		}
	} else if upscale {
		result, providerStatus, err = generation.RecoverUpscaleResult(queryCtx, input, providerRequestID)
	} else if beefVideo {
		result, providerStatus, settlement, err = generation.QueryManagedLegacyVideo(queryCtx, input, providerRequestID)
		if settlement.UsageState != nil {
			normalized := strings.ToLower(strings.TrimSpace(*settlement.UsageState))
			task.BeefUsageState = &normalized
		}
		if settlement.ReconcileDeadline != nil {
			task.BeefReconcileDeadline = nil
			if trimmed := strings.TrimSpace(*settlement.ReconcileDeadline); trimmed != "" {
				task.BeefReconcileDeadline = &trimmed
			}
		} else if settlement.UsageState != nil && !strings.EqualFold(strings.TrimSpace(*settlement.UsageState), "pending") {
			task.BeefReconcileDeadline = nil
		}
		if settlement.UsageState != nil || settlement.ReconcileDeadline != nil {
			_ = deps.Repo.UpdateTaskBeefVideoSettlement(task.ID, task.BeefUsageState, task.BeefReconcileDeadline)
		}
	} else if workflowVideo {
		result, providerStatus, err = deps.QueryWorkflowVideo(queryCtx, input.Config, providerRequestID)
	} else if !declarative && legacyVideo {
		result, providerStatus, err = generation.QueryHandwrittenVideoTask(queryCtx, input, providerRequestID)
	} else {
		result, providerStatus, err = generation.QueryProtocolAdapterVideoTask(queryCtx, input, adapter, providerRequestID)
	}
	if err != nil {
		if outcome := deps.ClassifyOutcome(*task, providerStatus, err); outcome != "" {
			var next *time.Time
			if VideoSettlementNeedsPolling(*task) {
				at := time.Now().Add(deps.Backoff(*task))
				next = &at
			}
			_ = deps.Repo.FinishFailedVideoRecovery(*task, &outcome, next)
			task.RecoveryOutcome = &outcome
			task.NextPollAt = next
		}
		_ = deps.Log(task.UserID, task.ID, "error", "人工查询上游视频任务失败", err.Error())
		return nil, err
	}
	if result == nil {
		var next *time.Time
		if VideoSettlementNeedsPolling(*task) {
			at := time.Now().Add(deps.Backoff(*task))
			next = &at
		}
		if deps.PastRetention(*task, time.Now()) {
			outcome := RecoveryUnrecoverable
			_ = deps.Repo.FinishFailedVideoRecovery(*task, &outcome, next)
			task.RecoveryOutcome = &outcome
			task.NextPollAt = next
		} else if settlement.UsageState != nil || settlement.ReconcileDeadline != nil {
			_ = deps.Repo.FinishFailedVideoRecovery(*task, task.RecoveryOutcome, next)
			task.NextPollAt = next
		}
		projected := TaskForOutput(*task)
		deps.AttachDelivery(projected)
		_ = deps.Log(task.UserID, task.ID, "info", "人工查询完成，上游任务仍在处理", providerStatus)
		return &ProviderTaskQueryResult{Task: projected, ProviderStatus: providerStatus, Recovered: false}, nil
	}

	result, err = deps.PersistGeneratedMedia(*task, result)
	if err != nil {
		_ = deps.Log(task.UserID, task.ID, "error", "人工查询已取得视频，但结果保存失败", err.Error())
		return nil, err
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	task.Error = ""
	task.PollStage = strings.ToLower(providerStatus)
	task.NextPollAt = nil
	if err := deps.SaveTaskCompletion(task, resultJSON, nil, false); err != nil {
		_ = deps.Log(task.UserID, task.ID, "error", "人工查询已取得视频，但任务恢复失败", err.Error())
		return nil, err
	}
	if err := deps.RegisterOutput(*task); err != nil {
		_ = deps.Log(task.UserID, task.ID, "error", "任务恢复成功但项目产物登记失败", err.Error())
		return nil, fmt.Errorf("任务已恢复，但项目素材登记失败：%w", err)
	}
	projected := deps.AttachRecovered(task)
	_ = deps.Log(task.UserID, task.ID, "info", "人工查询确认生成成功，任务已恢复并登记项目产物", providerStatus)
	return &ProviderTaskQueryResult{Task: projected, ProviderStatus: providerStatus, Recovered: true}, nil
}

func ProviderTaskRecoveryContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(parent), ProviderTaskRecoveryLeaseDuration)
}

func SelectCatalogTask(
	userID string,
	req SelectRequest,
	upscaleConfig func(string) (generation.Config, error),
	requireWorkflowPlugin func(userID, interfaceType string) error,
	frontendEnabled func() (bool, error),
	lookup modelcatalog.TaskSelectLookup,
) (SelectResult, error) {
	input := req.Input
	if config, ok := input["config"].(map[string]any); ok {
		if strings.HasPrefix(strings.TrimSpace(fmt.Sprint(config["model"])), "topaz/upscale/") || config["channelId"] == "fal-topaz-upscale" {
			return SelectResult{}, kernel.BadAuthRequest("Topaz 请使用素材节点的 AI 超分入口")
		}
	}
	config, _ := input["config"].(map[string]any)
	name := kernel.StringValue(config["model"])
	legacyKind := generation.UpscaleMediaType(name)
	if input["upscale"] != nil || legacyKind != "" {
		kind := kernel.StringValue(input["mode"])
		if (kind != "image" && kind != "video") || (legacyKind != "" && kind != legacyKind) {
			return SelectResult{}, kernel.BadAuthRequest("超分模型与任务类型不一致")
		}
		if req.Model != name || req.Type != "canvas_"+kind || kernel.StringValue(input["mode"]) != kind {
			return SelectResult{}, kernel.BadAuthRequest("超分模型与任务类型不一致")
		}
		managed, err := upscaleConfig(name)
		if err != nil {
			return SelectResult{}, err
		}
		if kernel.StringValue(config["credentialRef"]) != beefapi.CredentialRef || kernel.StringValue(config["apiKey"]) != managed.APIKey || kernel.StringValue(config["baseUrl"]) != managed.BaseURL {
			return SelectResult{}, kernel.BadAuthRequest("AI 超分需要使用已连接的官方算力账号")
		}
	}
	if modelcatalog.TaskInputUsesWorkflowProvider(input) {
		config, _ := input["config"].(map[string]any)
		if err := requireWorkflowPlugin(userID, strings.TrimSpace(fmt.Sprint(config["interfaceType"]))); err != nil {
			return SelectResult{}, err
		}
		return SelectResult{Input: input, Workflow: true}, nil
	}
	enabled, err := frontendEnabled()
	if err != nil {
		return SelectResult{}, err
	}
	selected, err := modelcatalog.SelectTaskModel(modelcatalog.TaskSelectRequest{
		Input:           input,
		LogicalModelID:  req.LogicalModelID,
		Type:            req.Type,
		Operation:       req.Operation,
		FrontendEnabled: enabled,
	}, lookup)
	if err != nil {
		return SelectResult{}, err
	}
	result := SelectResult{Input: selected.Input}
	if selected.Routed != nil {
		routed := selected.Routed
		result.Binding = &RouteBinding{
			LogicalModelID:         routed.LogicalModel.ID,
			LogicalModelRevisionID: routed.Revision.ID,
			RouteID:                routed.Route.ID,
			ChannelModelID:         routed.ChannelModel.ID,
			Model:                  routed.LogicalModel.Code,
			Provider:               "managed",
		}
	}
	return result, nil
}

func ValidateCatalogCapability(
	input map[string]any,
	validateCapability func(map[string]any) error,
	validatePortraitQuote func(map[string]any) error,
) error {
	config, _ := input["config"].(map[string]any)
	if input["upscale"] != nil || generation.UpscaleMediaType(kernel.StringValue(config["model"])) != "" {
		if kernel.StringValue(config["credentialRef"]) == beefapi.CredentialRef {
			config["mediaProtocolVersion"] = beefapi.MediaProtocolVersion
		}
		raw, err := json.Marshal(input)
		if err != nil {
			return err
		}
		var prepared generation.Input
		if err := json.Unmarshal(raw, &prepared); err != nil {
			return err
		}
		return generation.ValidateUpscaleInput(prepared)
	}
	if err := validateCapability(input); err != nil {
		return err
	}
	return validatePortraitQuote(input)
}

func ValidateTaskMediaTransport(
	userID string,
	input map[string]any,
	isWorkflow func(string) bool,
	resolveConfig func(generation.Config) (generation.Config, error),
	bindRuntime func(context.Context, generation.CallMeta) context.Context,
	registry *protocol.Registry,
) error {
	raw, err := json.Marshal(input)
	if err != nil {
		return kernel.BadAuthRequest("任务输入格式无效")
	}
	var prepared generation.Input
	if err := json.Unmarshal(raw, &prepared); err != nil {
		return kernel.BadAuthRequest("任务参数格式无效，请检查模型设置后重新提交")
	}
	if len(prepared.ReferenceImages)+len(prepared.ReferenceVideos)+len(prepared.ReferenceAudios) == 0 && prepared.Mask == nil {
		return nil
	}
	if isWorkflow != nil && isWorkflow(prepared.Config.InterfaceType) {
		return nil
	}
	if prepared.Config.ChannelID != "" || modelcatalog.SystemChannelIDFromBaseURL(prepared.Config.BaseURL) != "" {
		prepared.Config, err = resolveConfig(prepared.Config)
		if err != nil {
			return err
		}
	}
	ctx := bindRuntime(context.Background(), generation.CallMeta{UserID: userID})
	ctx = generation.WithProtocolRegistry(ctx, registry)
	return generation.ValidateMediaTransport(ctx, prepared)
}

func PresentTaskLogs(logs []model.TaskLog) []model.TaskLog {
	for i := range logs {
		logs[i].Summary = generation.DiagnosticSummary(logs[i].Message)
		if logs[i].Level == "error" && logs[i].Payload != "" {
			logs[i].Summary += "：" + generation.ClassifyText(logs[i].Payload).UserMessage()
		}
		logs[i].Message, logs[i].Payload = "", ""
	}
	return logs
}
