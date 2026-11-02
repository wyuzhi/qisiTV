package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/png"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	localasset "qisitv/backend/internal/asset"
	cw "qisitv/backend/internal/canvasworkflow"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/mediatools"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
	"qisitv/backend/internal/outbound"
	"qisitv/backend/internal/platform"
	"qisitv/backend/internal/repository"
	"qisitv/backend/internal/taskruntime"
)

func CanvasMediaDemuxer(mime string) string {
	switch mime {
	case "image/png":
		return "png_pipe"
	case "image/jpeg":
		return "jpeg_pipe"
	case "image/webp":
		return "webp_pipe"
	case "video/mp4", "video/quicktime":
		return "mov"
	case "video/webm":
		return "matroska"
	}
	return ""
}

func ProcessCanvasMedia(
	ctx context.Context,
	repo *repository.Repository,
	resources *localasset.Service,
	openResource func(userID, resourceID string) (*model.Resource, io.ReadCloser, error),
	deliver func(model.Task) error,
	logFn func(userID, taskID, level, msg, payload string) error,
	logInfo func(userID, taskID, msg, extra string),
	task *model.Task,
) error {
	var input CanvasMediaInput
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil || !cw.IsMediaOperation(input.Node.OperationID) {
		return FailTimelineTask(repo, logInfo, task, "处理失败", "媒体处理参数无效")
	}
	var clean func()
	var artifact *os.File
	defer func() {
		if artifact != nil {
			_ = artifact.Close()
		}
		if clean != nil {
			clean()
		}
	}()
	resource, err := resources.RecoverOwned(task.UserID, task.ID+":0", func() (localasset.RecoveredArtifact, error) {
		source, body, err := openResource(task.UserID, input.ResourceID)
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		defer body.Close()
		format := CanvasMediaDemuxer(source.MimeType)
		if format == "" {
			return localasset.RecoveredArtifact{}, fmt.Errorf("此素材格式暂不支持自动处理")
		}
		params, ext, mime, err := cw.MediaCommand(input.Node, source.Width, source.Height)
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		bin, err := mediatools.ResolveFFmpeg()
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		dir, err := os.MkdirTemp("", "beeftv-media-")
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		clean = func() { _ = os.RemoveAll(dir) }
		sourcePath := filepath.Join(dir, "source")
		file, err := os.Create(sourcePath)
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		_, copyErr := io.Copy(file, body)
		closeErr := file.Close()
		if copyErr != nil {
			return localasset.RecoveredArtifact{}, copyErr
		}
		if closeErr != nil {
			return localasset.RecoveredArtifact{}, closeErr
		}
		output := filepath.Join(dir, "result"+ext)
		args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-f", format, "-i", sourcePath}
		args = append(args, params...)
		args = append(args, output)
		if err = UpdateTimelineTaskProgress(repo, task, "本地媒体处理中", 20); err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		cmd := exec.CommandContext(ctx, bin, args...)
		mediatools.HideConsole(cmd)
		if err = cmd.Run(); err != nil {
			return localasset.RecoveredArtifact{}, fmt.Errorf("媒体处理失败，请检查源文件、裁切范围或音轨：%w", err)
		}
		artifact, err = os.Open(output)
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		var facts mediatools.MediaMetadata
		if input.Node.MediaType == "image" {
			config, _, decodeErr := image.DecodeConfig(artifact)
			if decodeErr != nil {
				return localasset.RecoveredArtifact{}, fmt.Errorf("输出图片无效")
			}
			facts.Width, facts.Height = config.Width, config.Height
			if _, err = artifact.Seek(0, io.SeekStart); err != nil {
				return localasset.RecoveredArtifact{}, err
			}
		} else {
			facts, err = mediatools.ProbeLocal(ctx, output)
			if err != nil {
				return localasset.RecoveredArtifact{}, err
			}
			if input.Node.MediaType == "video" && !facts.HasVideo || input.Node.MediaType == "audio" && !facts.HasAudio {
				return localasset.RecoveredArtifact{}, fmt.Errorf("处理结果缺少所需媒体轨道")
			}
		}
		info, err := artifact.Stat()
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		return localasset.RecoveredArtifact{Kind: input.Node.MediaType, FileName: "canvas-process" + ext, MimeType: mime, Size: info.Size(), Width: facts.Width, Height: facts.Height, DurationMs: facts.DurationMs, Body: artifact}, nil
	})
	if err != nil {
		return FailTimelineTask(repo, logInfo, task, "处理失败", err.Error())
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	value := map[string]any{"resourceId": resource.ID, "mimeType": resource.MimeType, "width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs}
	payload, err := json.Marshal(map[string]any{input.Node.MediaType: value, "resourceId": resource.ID})
	if err != nil {
		return err
	}
	task.Status = model.TaskStatusSucceeded
	task.Stage = "处理完成"
	task.Progress = 100
	task.ResultJSON = string(payload)
	now := time.Now()
	task.CompletedAt = &now
	if err := repo.SaveTaskCompletion(task, model.TaskStatusRunning, nil); err != nil {
		return err
	}
	if deliver != nil {
		if err := deliver(*task); err != nil && logFn != nil {
			_ = logFn(task.UserID, task.ID, "error", "媒体处理成功但交付待恢复", err.Error())
		}
	}
	return nil
}

func CanRunProviderTask(task model.Task) bool {
	if !strings.HasPrefix(task.Type, "video_") || strings.TrimSpace(task.InputJSON) == "" {
		return false
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		return false
	}
	return modelcatalog.HasExecutableVideoConfig(input)
}

func ProcessGenerationTask(
	ctx context.Context,
	task model.Task,
	startTrace func(context.Context, model.Task) (context.Context, func(string)),
	traceReason func(error) string,
	decryptInput func(string) (string, error),
	bindExecCtx func(context.Context, model.Task) (context.Context, func()),
	recoverImageSub func(context.Context, model.Task) (map[string]interface{}, bool, error),
	processCanvasGen func(ctx context.Context, userID, projectID, taskType, prompt, inputJSON string) (map[string]interface{}, error),
) (result map[string]interface{}, canvasOps []map[string]interface{}, err error) {
	ctx, finishTrace := startTrace(ctx, task)
	defer func() { finishTrace(traceReason(err)) }()
	if err := ValidateType(task.Type); err != nil {
		return nil, nil, err
	}
	decryptedInput, err := decryptInput(task.InputJSON)
	if err != nil {
		return nil, nil, err
	}
	task.InputJSON = decryptedInput
	ctx, cleanup := bindExecCtx(ctx, task)
	defer cleanup()
	if result, recovered, err := recoverImageSub(ctx, task); recovered {
		return result, nil, err
	}
	if task.Type == "canvas_text" || task.Type == "canvas_image" || task.Type == "canvas_video" || task.Type == "canvas_audio" {
		result, err := processCanvasGen(ctx, task.UserID, task.ProjectID, task.Type, task.Prompt, task.InputJSON)
		return result, nil, err
	}
	if strings.HasPrefix(task.Type, "video_") {
		if !CanRunProviderTask(task) {
			return nil, nil, errors.New("视频任务缺少可执行的模型配置")
		}
		result, err := processCanvasGen(ctx, task.UserID, task.ProjectID, task.Type, task.Prompt, task.InputJSON)
		return result, nil, err
	}
	return nil, nil, errors.New("任务类型没有可用的执行分支")
}

type WorkerExecuteDeps struct {
	Repo                  *repository.Repository
	Terminal              *taskruntime.Terminal
	Log                   func(userID, taskID, level, msg, payload string) error
	RunTimeline           func(*model.Task, context.Context) error
	RunRender             func(*model.Task, context.Context) error
	RunDepth              func(*model.Task, context.Context) error
	RunCanvasMedia        func(*model.Task, context.Context) error
	BeginRouteAttempt     func(*model.Task) (*model.RouteAttempt, error)
	ExecuteRoute          func(context.Context, *model.Task, *model.RouteAttempt) (RouteExecutionResult, error)
	PersistGeneratedMedia func(model.Task, map[string]interface{}) (map[string]interface{}, error)
	FinalizeTurnaround    func(model.Task, map[string]interface{}) (bool, error)
	DecryptTaskInput      func(string) (string, error)
	ShouldDeferImage      func(model.Task, error, bool) bool
	DeferImage            func(model.Task) error
	ResolveProviderConfig func(generation.Config) (generation.Config, error)
	ImageTaskEnded        func(error) bool
	SaveTaskCompletion    func(*model.Task, []byte, []byte, bool) error
}

func ExecuteClaimedTask(deps WorkerExecuteDeps, session taskruntime.Session) taskruntime.Outcome {
	task := session.Task()
	ctx := session.Context()
	if RetiredAgentTask(task) {
		err := deps.Terminal.Refuse(task, "功能已下线", RetiredAgentBoundaryMessage)
		return taskruntime.Outcome{Kind: taskruntime.KindRejected, Err: err, Applied: err == nil}
	}
	terminal := deps.Terminal
	_ = deps.Log(task.UserID, task.ID, "info", "后端任务开始处理", "")
	if latest, latestErr := deps.Repo.Task(task.ID); latestErr == nil && latest.Status == model.TaskStatusCancelled {
		err := terminal.HandleAlreadyCancelled(*latest)
		return taskruntime.Outcome{Kind: taskruntime.KindCancelled, Err: err, Applied: true}
	}

	if task.Type == model.TaskTypeTimelineTranscription {
		return SpecialTaskOutcome(session, deps.RunTimeline)
	}
	if task.Type == model.TaskTypeTimelineRender {
		return SpecialTaskOutcome(session, deps.RunRender)
	}
	if task.Type == model.TaskTypeDepthCapture {
		return SpecialTaskOutcome(session, deps.RunDepth)
	}
	if task.Type == model.TaskTypeCanvasMediaTransform {
		return SpecialTaskOutcome(session, deps.RunCanvasMedia)
	}

	task.Stage = "调用生成模型"
	task.Progress = 35
	if TaskUsesUpstreamReportedProgress(task.Type) {
		task.Stage = "正在连接上游"
		task.Progress = 0
	}
	if err := deps.Repo.UpdateTaskProgressForLease(task.ID, task.LeaseOwner, task.Stage, task.Progress); err != nil {
		return taskruntime.Outcome{Kind: taskruntime.KindFailed, Err: fmt.Errorf("更新任务进度失败，任务暂未调用上游：%w", err)}
	}
	routeAttempt, err := deps.BeginRouteAttempt(task)
	if err != nil {
		uncertain := modelcatalog.IsDispatchUncertain(err)
		termErr := terminal.MarkPreparationFailure(task, "路由准备失败", err, uncertain, "路由准备失败，上游请求未发出")
		kind := taskruntime.KindFailed
		if uncertain {
			kind = taskruntime.KindUncertain
		}
		return taskruntime.Outcome{Kind: kind, Err: termErr, Applied: TerminalWriteApplied(termErr, err)}
	}
	routeResult, stateErr := deps.ExecuteRoute(ctx, task, routeAttempt)
	if stateErr != nil {
		kind := taskruntime.KindFailed
		if modelcatalog.IsDispatchUncertain(stateErr) {
			kind = taskruntime.KindUncertain
		}
		return taskruntime.Outcome{Kind: kind, Err: stateErr, ProviderAccepted: strings.TrimSpace(task.ProviderRequestID) != ""}
	}
	if session.Lost() {
		return LeaseLostOutcome(session, strings.TrimSpace(task.ProviderRequestID) != "")
	}
	result, canvasOps, err := routeResult.Result, routeResult.CanvasOps, routeResult.Err
	providerSucceeded := routeResult.ProviderSucceeded
	providerAccepted := providerSucceeded || strings.TrimSpace(task.ProviderRequestID) != ""
	if err == nil {
		result, err = deps.PersistGeneratedMedia(*task, result)
	}
	if err == nil {
		_, err = deps.FinalizeTurnaround(*task, result)
	}
	if err != nil {
		channelSlotFailedBeforeRequest := false
		if code, _ := platform.ChannelSlotFailureDetails(err); code != "" {
			channelSlotFailedBeforeRequest = true
		}
		if session.Lost() {
			_ = deps.Log(task.UserID, task.ID, "warn", "任务租约失效，等待其他 worker 恢复", session.LostErr().Error())
			return LeaseLostOutcome(session, providerAccepted)
		}
		decryptedInput, decryptErr := deps.DecryptTaskInput(task.InputJSON)
		if deps.ShouldDeferImage(*task, err, providerSucceeded) {
			deferErr := deps.DeferImage(*task)
			return taskruntime.Outcome{Kind: taskruntime.KindSuspended, Err: deferErr, Applied: deferErr == nil, ProviderAccepted: true}
		}
		if decryptErr == nil && ShouldDeferVideoProviderTask(*task, decryptedInput, err, deps.ResolveProviderConfig) {
			stage := "后台仍在生成"
			message := "前台等待结束，上游视频仍在生成，将继续回查原任务"
			var downloadErr generation.VideoDownloadError
			if errors.As(err, &downloadErr) {
				stage = "正在取回生成结果"
				message = "视频已生成，下载暂时中断，将继续取回原任务结果"
			}
			var pendingErr generation.StatePendingError
			if errors.As(err, &pendingErr) {
				stage = "等待上游任务同步"
				message = "上游任务状态暂未同步，将继续回查原任务"
			}
			if task.FailureDiagnostics != nil {
				task.FailureDiagnostics.ExecutionResult = "pending"
			}
			if deferErr := deps.Repo.DeferRunningTaskForProviderPoll(task.ID, task.LeaseOwner, stage, 15*time.Second, task.FailureDiagnostics); deferErr != nil {
				return taskruntime.Outcome{Kind: taskruntime.KindFailed, Err: deferErr, ProviderAccepted: true}
			}
			_ = deps.Log(task.UserID, task.ID, "info", message, task.PollStage)
			return taskruntime.Outcome{Kind: taskruntime.KindSuspended, Applied: true, ProviderAccepted: true}
		}
		if NewAPIChannel2TaskSyncExpired(*task, err, time.Now()) {
			err = errors.New("上游任务长时间未同步，已停止自动查询，请确认渠道任务状态后重试。")
		}
		var imageRecovery generation.ImageRecoveryError
		if errors.Is(err, context.DeadlineExceeded) && !errors.As(err, &imageRecovery) {
			err = errors.New(TaskTimeoutMessage(task.Type))
		}
		outcome := ExecutionFailureOutcome(terminal, task, err, providerSucceeded, providerAccepted, channelSlotFailedBeforeRequest, deps.ImageTaskEnded)
		if outcome.Applied && task.Type == "canvas_image" && !task.IsUpscale() && task.RecoveryOutcome != nil {
			failed := *task
			failed.LeaseOwner = ""
			_ = deps.Repo.FinishFailedImageRecovery(failed, task.RecoveryOutcome, nil)
		}
		return outcome
	}
	latest, err := deps.Repo.Task(task.ID)
	if err != nil {
		return taskruntime.Outcome{Kind: taskruntime.KindFailed, Err: err, ProviderAccepted: providerAccepted}
	}
	if latest.Status == model.TaskStatusCancelled {
		termErr := terminal.HandleCancelledResult(*latest)
		return taskruntime.Outcome{Kind: taskruntime.KindCancelled, Err: termErr, Applied: true, ProviderAccepted: providerAccepted}
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return PersistenceFailureOutcome(terminal, task, fmt.Errorf("序列化任务结果失败：%w", err), providerAccepted)
	}
	opsJSON, err := json.Marshal(canvasOps)
	if err != nil {
		return PersistenceFailureOutcome(terminal, task, fmt.Errorf("序列化画布操作失败：%w", err), providerAccepted)
	}
	if session.Lost() {
		return LeaseLostOutcome(session, true)
	}
	if err := deps.SaveTaskCompletion(task, resultJSON, opsJSON, len(canvasOps) > 0); err != nil {
		if deps.ShouldDeferImage(*task, err, true) {
			deferErr := deps.DeferImage(*task)
			return taskruntime.Outcome{Kind: taskruntime.KindSuspended, Err: deferErr, Applied: deferErr == nil, ProviderAccepted: true}
		}
		return PersistenceFailureOutcome(terminal, task, err, true)
	}
	termErr := terminal.HandleSuccess(task)
	return taskruntime.Outcome{Kind: taskruntime.KindCompleted, Err: termErr, Applied: true, ProviderAccepted: true}
}

func SpecialTaskOutcome(session taskruntime.Session, run func(*model.Task, context.Context) error) taskruntime.Outcome {
	err := run(session.Task(), session.Context())
	if session.Lost() {
		return LeaseLostOutcome(session, false)
	}
	if err == nil {
		return taskruntime.Outcome{Kind: taskruntime.KindCompleted, Applied: true}
	}
	if errors.Is(err, context.Canceled) {
		return taskruntime.Outcome{Kind: taskruntime.KindCancelled, Err: err}
	}
	return taskruntime.Outcome{Kind: taskruntime.KindFailed, Err: err}
}

func LeaseLostOutcome(session taskruntime.Session, providerAccepted bool) taskruntime.Outcome {
	err := session.LostErr()
	if err == nil {
		err = taskruntime.ErrLeaseLost
	}
	kind := taskruntime.KindLeaseLost
	if providerAccepted {
		kind = taskruntime.KindUncertain
	}
	return taskruntime.Outcome{
		Kind:             kind,
		Err:              fmt.Errorf("任务租约失效，停止保存上游结果：%w", err),
		ProviderAccepted: providerAccepted,
	}
}

func ExecutionFailureOutcome(terminal *taskruntime.Terminal, task *model.Task, err error, providerSucceeded, providerAccepted, channelSlotFailedBeforeRequest bool, imageEnded func(error) bool) taskruntime.Outcome {
	if task != nil && task.Type == "canvas_image" && !task.IsUpscale() && imageEnded != nil && imageEnded(err) {
		noResult := "no_result"
		task.RecoveryOutcome = &noResult
	}
	termErr := terminal.HandleExecutionFailure(task, err, providerSucceeded, channelSlotFailedBeforeRequest)
	if errors.Is(err, context.Canceled) && termErr == nil {
		return taskruntime.Outcome{Kind: taskruntime.KindCancelled, Applied: true, ProviderAccepted: providerAccepted}
	}
	kind := taskruntime.KindFailed
	var imageRecovery generation.ImageRecoveryError
	var unknown generation.SubmissionUnknownError
	if errors.As(err, &imageRecovery) || errors.As(err, &unknown) {
		kind = taskruntime.KindUncertain
	}
	return taskruntime.Outcome{Kind: kind, Err: termErr, Applied: TerminalWriteApplied(termErr, err), ProviderAccepted: providerAccepted}
}

func PersistenceFailureOutcome(terminal *taskruntime.Terminal, task *model.Task, err error, providerAccepted bool) taskruntime.Outcome {
	handled, termErr := terminal.HandleResultPersistenceFailure(task, err)
	if handled {
		return taskruntime.Outcome{Kind: taskruntime.KindCancelled, Err: termErr, Applied: termErr == nil, ProviderAccepted: providerAccepted}
	}
	return taskruntime.Outcome{Kind: taskruntime.KindFailed, Err: termErr, Applied: TerminalWriteApplied(termErr, err), ProviderAccepted: providerAccepted}
}

func TerminalWriteApplied(termErr, cause error) bool {
	if termErr == nil {
		return true
	}
	var joined interface{ Unwrap() []error }
	if errors.As(termErr, &joined) {
		return false
	}
	return cause != nil && errors.Is(termErr, cause)
}

func TaskUsesUpstreamReportedProgress(taskType string) bool {
	return taskType == "canvas_image" || taskType == "canvas_video" || strings.HasPrefix(taskType, "video_")
}

func TaskFailureMessage(err error) string {
	if err == nil {
		return generation.PersistableTaskFailureMessage(err)
	}
	return kernel.TruncateRunes(generation.PersistableTaskFailureMessage(err), 2_000)
}

func TaskExecutionTimeoutWithMinutes(taskType string, videoMin, imageMin, audioMin, textMin, defaultMin int) time.Duration {
	switch {
	case strings.HasPrefix(taskType, "canvas_video") || strings.HasPrefix(taskType, "video_"):
		return max(time.Duration(videoMin)*time.Minute, 5*time.Minute)
	case strings.HasPrefix(taskType, "canvas_image"):
		return time.Duration(imageMin) * time.Minute
	case strings.HasPrefix(taskType, "canvas_audio"):
		return time.Duration(audioMin) * time.Minute
	case strings.HasPrefix(taskType, "canvas_text"):
		return time.Duration(textMin) * time.Minute
	case taskType == model.TaskTypeTimelineTranscription:
		return 20 * time.Minute
	case taskType == model.TaskTypeTimelineRender:
		return 60 * time.Minute
	case taskType == model.TaskTypeDepthCapture:
		return 2 * time.Hour
	default:
		return time.Duration(defaultMin) * time.Minute
	}
}

func ShouldDeferVideoProviderTask(task model.Task, decryptedInput string, err error, resolveConfig func(generation.Config) (generation.Config, error)) bool {
	var input generation.Input
	if json.Unmarshal([]byte(decryptedInput), &input) != nil {
		return false
	}
	providerRequestID := strings.TrimSpace(task.ProviderRequestID)
	if providerRequestID == "" || (!strings.HasPrefix(task.Type, "canvas_video") && !strings.HasPrefix(task.Type, "video_") && input.Upscale == nil) {
		return false
	}
	deferSignal := errors.Is(err, context.DeadlineExceeded)
	var dns *outbound.DNSResolutionError
	if errors.As(err, &dns) {
		deferSignal, _ = generation.RetryableVideoPollError(context.Background(), err)
	}
	var downloadErr generation.VideoDownloadError
	if errors.As(err, &downloadErr) {
		deferSignal, _ = generation.RetryableVideoPollError(context.Background(), downloadErr.Cause)
	}
	if task.StartedAt != nil && time.Since(*task.StartedAt) >= 24*time.Hour {
		return false
	}
	var pendingErr generation.StatePendingError
	if errors.As(err, &pendingErr) {
		deferSignal = strings.TrimSpace(pendingErr.TaskID) == providerRequestID && !NewAPIChannel2TaskSyncExpired(task, err, time.Now())
	}
	if !deferSignal {
		return false
	}
	if input.Config.ChannelID == "" && generation.IsBeefAPIVideoConfig(context.Background(), input.Config) {
		return true
	}
	resolved, resolveErr := resolveConfig(input.Config)
	return resolveErr == nil && (resolved.InterfaceType == string(model.ChannelInterfaceNewAPIChannel2) || generation.IsBeefAPIVideoConfig(context.Background(), resolved))
}

func NewAPIChannel2TaskSyncExpired(task model.Task, err error, now time.Time) bool {
	var pendingErr generation.StatePendingError
	if !errors.As(err, &pendingErr) || strings.TrimSpace(pendingErr.TaskID) == "" || strings.TrimSpace(pendingErr.TaskID) != strings.TrimSpace(task.ProviderRequestID) {
		return false
	}
	if task.StartedAt == nil {
		return true
	}
	return !now.Before(task.StartedAt.Add(NewAPIChannel2TaskSyncMaxAge))
}

func TaskTimeoutMessage(taskType string) string {
	if strings.HasPrefix(taskType, "canvas_video") || strings.HasPrefix(taskType, "video_") {
		return "视频生成等待超时，请稍后到任务中心查看或重试。"
	}
	if strings.HasPrefix(taskType, "canvas_image") {
		return "图片生成等待超时，请稍后重试。"
	}
	return "任务执行超时，请稍后重试。"
}
