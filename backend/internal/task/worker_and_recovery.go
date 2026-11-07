package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/transcription"

	"gorm.io/gorm"
)

const (
	CanvasBindRecoveryBatch           = 64
	NewAPIChannel2TaskSyncMaxAge      = 5 * time.Minute
	WorkerSlotLeaseDuration           = time.Minute
	TimelineRenderFileName            = "timeline-render.mp4"
	VideoRecoveryBatch                = 4
	VideoRecoveryPassTimeout          = 30 * time.Second
	VideoRecoveryDefaultBackoff       = 30 * time.Second
	ProviderTaskRecoveryLeaseDuration = 10 * time.Minute
)

type CanvasBindDeps struct {
	Repo                *repository.Repository
	Intents             func(model.Task) []CanvasBindingIntent
	PrepareSeedream     func(model.Task) error
	RegisterOutput      func(model.Task) error
	DeliverAndIntents   func(model.Task) []CanvasBindingIntent
	HasWorkspaceOps     bool
	ExecuteCanvasBind   func(task model.Task, nodeID string, outputIndex int) error
	ExecuteMessageBind  func(task model.Task, conversationID, messageID string, outputIndex int) error
	Refusal             func(error) (string, map[string]any)
	ReconcileTurnaround func(userID, projectID string) bool
}

func RecoverCanvasTaskBindings(deps CanvasBindDeps, task model.Task) error {
	if deps.Repo == nil || strings.TrimSpace(task.ID) == "" || strings.TrimSpace(task.UserID) == "" || task.Status != model.TaskStatusSucceeded {
		return nil
	}
	intents := deps.Intents(task)
	canvasIDs, missing, err := TaskCanvasState(task, intents, IsOwnedBusinessProjectInRepo(deps.Repo, task.UserID), CanvasExistsInRepo(deps.Repo, task.UserID))
	if err != nil {
		return err
	}
	var last error
	if missing {
		if HasCanvasBindMarker(task.RecoveryOutcome) {
			last = deps.Repo.UpdateCanvasBindRecovery(task.UserID, task.ID, nil)
		}
	} else {
		if len(canvasIDs) > 0 && deps.PrepareSeedream != nil {
			if err := deps.PrepareSeedream(task); err != nil {
				return err
			}
		}
		if deps.RegisterOutput != nil {
			if err := deps.RegisterOutput(task); err != nil {
				last = err
			} else if HasWorkflowOutputIntent(task.InputJSON) && deps.DeliverAndIntents != nil {
				intents = deps.DeliverAndIntents(task)
			}
		}
		if len(canvasIDs) > 0 && deps.HasWorkspaceOps {
			pass := NewCanvasBindPass(task.RecoveryOutcome)
			for _, target := range CanvasBindTargets(task, intents) {
				if pass.Skip(target.NodeID, target.OutputIndex, CanvasRevisionFromRepo(deps.Repo, task)) {
					continue
				}
				if err := deps.ExecuteCanvasBind(task, target.NodeID, target.OutputIndex); err != nil {
					reason, details := "", map[string]any(nil)
					if deps.Refusal != nil {
						reason, details = deps.Refusal(err)
					}
					if pass.Refused(target.NodeID, target.OutputIndex, reason, details) || SkippableCanvasBindError(err, deps.Refusal) {
						continue
					}
					last = err
					continue
				}
				pass.Bound(target.NodeID, target.OutputIndex)
			}
			if marker, changed, err := pass.Finish(); err != nil {
				last = err
			} else if changed {
				if err := deps.Repo.UpdateCanvasBindRecovery(task.UserID, task.ID, marker); err != nil {
					last = err
				}
			}
		}
	}
	if deps.HasWorkspaceOps && deps.ExecuteMessageBind != nil {
		for _, target := range MessageBindTargets(task, intents) {
			if err := deps.ExecuteMessageBind(task, target.ConversationID, target.MessageID, target.OutputIndex); err != nil {
				last = err
			}
		}
	}
	if projectID := strings.TrimSpace(task.ProjectID); projectID != "" && deps.ReconcileTurnaround != nil {
		deps.ReconcileTurnaround(task.UserID, projectID)
	}
	return last
}

func RecoverPendingCanvasBindings(
	repo *repository.Repository,
	hasOps bool,
	cursorMu *sync.Mutex,
	afterID *string,
	limit int,
	recoverTask func(model.Task) error,
) error {
	if repo == nil || !hasOps {
		return nil
	}
	if limit <= 0 {
		limit = CanvasBindRecoveryBatch
	}
	cursorMu.Lock()
	currentAfter := *afterID
	cursorMu.Unlock()
	tasks, err := repo.SucceededTasksForDelivery(currentAfter, limit)
	if err != nil {
		if BindInfrastructureUnavailable(err) {
			return nil
		}
		return err
	}
	if len(tasks) == 0 && currentAfter != "" {
		tasks, err = repo.SucceededTasksForDelivery("", limit)
		if err != nil {
			if BindInfrastructureUnavailable(err) {
				return nil
			}
			return err
		}
	}
	cursorMu.Lock()
	if len(tasks) == 0 || len(tasks) < limit {
		*afterID = ""
	} else {
		*afterID = tasks[len(tasks)-1].ID
	}
	cursorMu.Unlock()
	var last error
	for _, task := range tasks {
		if err := recoverTask(task); err != nil {
			last = err
		}
	}
	return last
}

func SkippableCanvasBindError(err error, refusal func(error) (string, map[string]any)) bool {
	if err == nil {
		return true
	}
	if BindInfrastructureUnavailable(err) {
		return true
	}
	if refusal == nil {
		return false
	}
	reason, _ := refusal(err)
	if reason == "" {
		return false
	}
	switch reason {
	case "node_deleted", "node_task_mismatch", "node_mismatch", "canvas_mismatch",
		"conversation_deleted", "message_deleted", "message_mismatch", "conversation_mismatch",
		"message_task_mismatch",
		"task_not_found", "task_not_succeeded", "task_foreign",
		"output_not_ready", "resource_not_ready", "resource_missing", "resource_foreign",
		"resource_mismatch", "asset_foreign", "delivery_unreadable", "unsupported_result_shape",
		"effect_identity_mismatch":
		return true
	default:
		return false
	}
}

func CanvasRevisionFromRepo(repo *repository.Repository, task model.Task) func() (int64, error) {
	return func() (int64, error) {
		current, err := repo.CanvasProjectMetadata(task.UserID, task.ProjectID)
		return current.Revision, err
	}
}

func CanvasExistsInRepo(repo *repository.Repository, userID string) func(string) (bool, error) {
	return func(canvasID string) (bool, error) {
		_, err := repo.CanvasProjectMetadata(userID, canvasID)
		if err == nil {
			return true, nil
		}
		if errors.Is(err, gorm.ErrRecordNotFound) || BindInfrastructureUnavailable(err) {
			return false, nil
		}
		return false, err
	}
}

func IsOwnedBusinessProjectInRepo(repo *repository.Repository, userID string) func(string) (bool, error) {
	return func(projectID string) (bool, error) {
		_, err := repo.ProjectForUser(userID, projectID)
		if err == nil {
			return true, nil
		}
		if errors.Is(err, gorm.ErrRecordNotFound) || BindInfrastructureUnavailable(err) {
			return false, nil
		}
		return false, err
	}
}

func BindInfrastructureUnavailable(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "no such table") ||
		strings.Contains(message, "op_store_unavailable") ||
		strings.Contains(message, "op_domain_unavailable")
}

type RouteExecutionResult struct {
	Result            map[string]interface{}
	CanvasOps         []map[string]interface{}
	Err               error
	ProviderSucceeded bool
}

type RouteExecuteDeps struct {
	MarkDispatching  func(*model.RouteAttempt) error
	Process          func(context.Context, model.Task) (map[string]interface{}, []map[string]interface{}, error)
	RefreshState     func(*model.Task) error
	FinishAttempt    func(*model.RouteAttempt, *model.Task, error)
	NextAfterFailure func(*model.Task, *model.RouteAttempt, error) (*model.RouteAttempt, error)
	WriteLog         func(string, string, string, string, string) error
	WithSubKey       func(context.Context, *model.RouteAttempt) context.Context
	IsRecoveryErr    func(error) bool
	IsVODParamErr    func(error) bool
	IsImageThrottle  func(error) bool
}

func ExecuteRouteAttemptLoop(ctx context.Context, deps RouteExecuteDeps, task *model.Task, attempt *model.RouteAttempt) (RouteExecutionResult, error) {
	var execution RouteExecutionResult
	ctx, recorder := generation.WithTaskRequestEvidence(ctx, task.FailureDiagnostics)
	defer func() { task.FailureDiagnostics = recorder.Snapshot(execution.ProviderSucceeded) }()
	for {
		if dispatchErr := deps.MarkDispatching(attempt); dispatchErr != nil {
			execution.Err = dispatchErr
			break
		}
		callCtx := ctx
		if deps.WithSubKey != nil {
			callCtx = deps.WithSubKey(ctx, attempt)
		}
		execution.Result, execution.CanvasOps, execution.Err = deps.Process(callCtx, *task)
		if stateErr := deps.RefreshState(task); stateErr != nil {
			return RouteExecutionResult{}, stateErr
		}
		deps.FinishAttempt(attempt, task, execution.Err)
		if execution.Err == nil {
			break
		}
		if task.Type == "canvas_image" && !task.IsUpscale() && attempt != nil && attempt.DispatchState == "submission_unknown" && !deps.IsRecoveryErr(execution.Err) && !deps.IsVODParamErr(execution.Err) {
			execution.Err = generation.ImageRecoveryError{Cause: execution.Err}
		}
		var upstream generation.HTTPError
		if task.Type == "canvas_image" && attempt != nil && attempt.AttemptNumber < 3 && deps.IsImageThrottle(execution.Err) && errors.As(execution.Err, &upstream) {
			delay := time.Duration(1<<attempt.AttemptNumber) * time.Second
			if upstream.RetryAfter > delay {
				delay = upstream.RetryAfter
			}
			if waitErr := generation.SleepContext(ctx, delay); waitErr != nil {
				break
			}
		}
		nextAttempt, routeErr := deps.NextAfterFailure(task, attempt, execution.Err)
		if routeErr != nil {
			_ = deps.WriteLog(task.UserID, task.ID, "warn", "备用路由不可用，保留原始失败", routeErr.Error())
			break
		}
		if nextAttempt == nil {
			break
		}
		task.RouteID = nextAttempt.RouteID
		attempt = nextAttempt
		if task.Type == "canvas_image" {
			_ = deps.WriteLog(task.UserID, task.ID, "warn", "上游限流，正在重试原图片请求", nextAttempt.ID)
		} else {
			_ = deps.WriteLog(task.UserID, task.ID, "warn", "上游未创建任务，切换备用能力路由", nextAttempt.RouteID)
		}
	}
	execution.ProviderSucceeded = execution.Err == nil
	return execution, nil
}

func FailTimelineTask(repo *repository.Repository, logInfo func(userID, taskID, msg, extra string), task *model.Task, stage string, message string) error {
	done, err := repo.UpdateTaskTerminalState(task.ID, task.LeaseOwner, model.TaskStatusRunning, model.TaskStatusFailed, stage, message, time.Now(), task.FailureDiagnostics)
	if err != nil {
		return fmt.Errorf("写入转写失败态失败: %w", err)
	}
	if !done {
		return fmt.Errorf("时间线任务状态或租约已变化：%w", repository.ErrTaskStateConflict)
	}
	label := "时间线转写失败"
	if task.Type == model.TaskTypeDepthCapture {
		label = "深度处理失败"
	}
	if logInfo != nil {
		logInfo(task.UserID, task.ID, fmt.Sprintf("%s: %s", label, message), "")
	}
	return nil
}

func UpdateTimelineTaskProgress(repo *repository.Repository, task *model.Task, stage string, progress int) error {
	if err := repo.UpdateTaskProgressForLease(task.ID, task.LeaseOwner, stage, progress); err != nil {
		return fmt.Errorf("更新转写进度失败: %w", err)
	}
	return nil
}

func ProcessTimelineTranscription(
	ctx context.Context,
	repo *repository.Repository,
	beef *beeftv.Service,
	requireFeature func() error,
	newExecutor func(userID, baseURL string) *transcription.Executor,
	logInfo func(userID, taskID, msg, extra string),
	task *model.Task,
) error {
	baseURL := strings.TrimSpace(os.Getenv(transcription.BaseURLEnv))
	var input TimelineTranscriptionInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil || strings.TrimSpace(input.ResourceID) == "" {
		return FailTimelineTask(repo, logInfo, task, "转写失败", "任务缺少有效的资源引用")
	}
	if input.Model == "" && baseURL == "" {
		return FailTimelineTask(repo, logInfo, task, "转写失败", "未配置本地转写服务：请设置 CANVAS_WHISPER_BASE_URL 指向 whisper.cpp 服务")
	}
	if err := requireFeature(); err != nil {
		return FailTimelineTask(repo, logInfo, task, "转写失败", "字幕转写暂未开放")
	}
	logInfo(task.UserID, task.ID, "时间线转写任务开始", "")
	executor := newExecutor(task.UserID, baseURL)
	if input.Model != "" {
		if task.Attempts > 1 {
			return FailTimelineTask(repo, logInfo, task, "转写已中断", "上次云端转写结果未确认，未重复提交。请检查原任务和用量后重新创建转写")
		}
		if beef == nil {
			return FailTimelineTask(repo, logInfo, task, "转写失败", "请先连接 BeefTV")
		}
		cred, err := beef.Resolve()
		if err != nil || input.ManagedTokenID == "" || cred.TokenID != input.ManagedTokenID {
			return FailTimelineTask(repo, logInfo, task, "转写失败", "BeefTV 连接已改变，请重新提交转写")
		}
		executor.Client = transcription.NewClient(cred.BaseURL)
		if _, err := outbound.ValidateOutboundURL(cred.BaseURL); err != nil {
			return FailTimelineTask(repo, logInfo, task, "转写失败", "云端转写地址不可用，请重新连接 BeefTV")
		}
		executor.Client.HTTP = outbound.OutboundHTTPClient(20 * time.Minute)
		executor.Client.Model, executor.Client.APIKey = input.Model, cred.APIKey
	}
	result, err := executor.Run(ctx, input.ResourceID, input.Language, func(stage string, percent int) error {
		return UpdateTimelineTaskProgress(repo, task, stage, percent)
	})
	if err != nil {
		return FailTimelineTask(repo, logInfo, task, "转写失败", err.Error())
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return FailTimelineTask(repo, logInfo, task, "转写失败", "转写结果序列化失败")
	}
	task.Status = model.TaskStatusSucceeded
	task.Stage = "转写完成"
	task.Progress = 100
	task.ResultJSON = string(payload)
	completedAt := time.Now()
	task.CompletedAt = &completedAt
	if err := repo.SaveTaskCompletion(task, model.TaskStatusRunning, nil); err != nil {
		return fmt.Errorf("写入转写完成态失败: %w", err)
	}
	logInfo(task.UserID, task.ID, fmt.Sprintf("时间线转写完成，段落 %d", len(result.Segments)), "")
	return nil
}

func BindTranscriptionModel(beef *beeftv.Service, modelID string) (string, error) {
	if beef == nil {
		return "", kernel.BadAuthRequest("请先连接 BeefTV")
	}
	cred, err := beef.Resolve()
	if err != nil {
		return "", kernel.BadAuthRequest(err.Error())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	models, err := beef.RefreshCatalog(ctx)
	if err != nil {
		return "", kernel.BadAuthRequest(err.Error())
	}
	available := false
	for _, m := range models {
		if m.ID == modelID {
			for _, endpoint := range m.SupportedEndpointTypes {
				if endpoint == "audio.transcriptions" {
					available = true
				}
			}
		}
	}
	if !available {
		return "", kernel.BadAuthRequest("该模型不支持音视频转写，请刷新模型列表")
	}
	next, err := beef.Resolve()
	if err != nil || next.TokenID != cred.TokenID || next.AccountID != cred.AccountID {
		return "", kernel.BadAuthRequest("BeefTV 连接已改变，请重新提交转写")
	}
	return cred.TokenID, nil
}

type TimelineRenderPlanRequest struct {
	Timeline editing.Project      `json:"timeline"`
	Sources  []editing.SourceMeta `json:"sources"`
	Options  editing.Options      `json:"options"`
}

type TimelineRenderResult struct {
	Video       map[string]any `json:"video,omitempty"`
	ResourceID  string         `json:"resourceId"`
	FileName    string         `json:"fileName"`
	Size        int64          `json:"size"`
	DurationMs  int64          `json:"durationMs"`
	SubtitleSRT string         `json:"subtitleSrt,omitempty"`
}

func CompileTimelineRenderPlan(userID string, req TimelineRenderPlanRequest) (*editing.Plan, error) {
	if strings.TrimSpace(userID) == "" {
		return nil, kernel.Unauthorized("未登录")
	}
	plan, err := editing.Compile(req.Timeline, req.Sources, req.Options)
	if err != nil {
		return nil, kernel.BadAuthRequest(err.Error())
	}
	return plan, nil
}

func TimelineRenderArtifactIdentity(taskID string) string {
	return strings.TrimSpace(taskID) + ":0"
}

func ProcessTimelineRender(
	ctx context.Context,
	repo *repository.Repository,
	resources *localasset.Service,
	renderer func(userID string) *editing.Renderer,
	deliver func(model.Task) error,
	logInfo func(userID, taskID, msg, extra string),
	task *model.Task,
) error {
	var input TimelineRenderInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		return FailTimelineTask(repo, logInfo, task, "渲染失败", "任务缺少有效的时间线快照")
	}
	plan, err := editing.Compile(input.Timeline, nil, input.Options)
	if err != nil {
		return FailTimelineTask(repo, logInfo, task, "渲染失败", err.Error())
	}
	var (
		renderCleanup func()
		renderFile    *os.File
	)
	defer func() {
		if renderFile != nil {
			_ = renderFile.Close()
		}
		if renderCleanup != nil {
			renderCleanup()
		}
	}()
	resource, err := resources.RecoverOwned(task.UserID, TimelineRenderArtifactIdentity(task.ID), func() (localasset.RecoveredArtifact, error) {
		rendered, cleanup, renderErr := renderer(task.UserID).Render(ctx, plan, func(stage string, percent int) error {
			return UpdateTimelineTaskProgress(repo, task, stage, percent)
		})
		renderCleanup = cleanup
		if renderErr != nil {
			return localasset.RecoveredArtifact{}, renderErr
		}
		file, openErr := os.Open(rendered.Path)
		if openErr != nil {
			return localasset.RecoveredArtifact{}, fmt.Errorf("读取渲染产物失败")
		}
		renderFile = file
		return localasset.RecoveredArtifact{
			Kind: "video", FileName: TimelineRenderFileName, MimeType: "video/mp4",
			Size: rendered.Size, Width: rendered.Width, Height: rendered.Height,
			DurationMs: rendered.DurationMs, Body: file,
		}, nil
	})
	if err != nil {
		return FailTimelineTask(repo, logInfo, task, "渲染失败", err.Error())
	}
	if resource == nil {
		return FailTimelineTask(repo, logInfo, task, "渲染失败", "保存渲染产物失败")
	}
	if err := UpdateTimelineTaskProgress(repo, task, "写入资源…", 85); err != nil {
		return err
	}
	result := TimelineRenderResult{
		Video:       map[string]any{"resourceId": resource.ID, "mimeType": "video/mp4", "fileName": TimelineRenderFileName, "durationMs": resource.DurationMs},
		ResourceID:  resource.ID,
		FileName:    TimelineRenderFileName,
		Size:        resource.Size,
		DurationMs:  resource.DurationMs,
		SubtitleSRT: plan.SubtitleSRT,
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return FailTimelineTask(repo, logInfo, task, "渲染失败", "渲染结果序列化失败")
	}
	task.Status = model.TaskStatusSucceeded
	task.Stage = "渲染完成"
	task.Progress = 100
	task.ResultJSON = string(payload)
	completedAt := time.Now()
	task.CompletedAt = &completedAt
	if err := repo.SaveTaskCompletion(task, model.TaskStatusRunning, nil); err != nil {
		return fmt.Errorf("写入渲染完成态失败: %w", err)
	}
	if deliver != nil {
		if err := deliver(*task); err != nil {
			return fmt.Errorf("本地渲染完成后的素材交付失败：%w", err)
		}
	}
	logInfo(task.UserID, task.ID, fmt.Sprintf("时间线渲染完成，时长 %.1fs", float64(resource.DurationMs)/1000), "")
	return nil
}
