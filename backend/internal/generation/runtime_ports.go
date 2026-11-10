package generation

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func ResourceInfoFromModel(userID string, resource *model.Resource) ResourceInfo {
	if resource == nil {
		return ResourceInfo{UserID: userID}
	}
	return ResourceInfo{
		UserID:     userID,
		ID:         resource.ID,
		Status:     string(resource.Status),
		Kind:       resource.Kind,
		MimeType:   resource.MimeType,
		Provider:   resource.Provider,
		Size:       resource.Size,
		Width:      resource.Width,
		Height:     resource.Height,
		DurationMs: resource.DurationMs,
	}
}

func LogTaskPhase(repo *repository.Repository, logTask func(userID, taskID, level, msg, payload string) error, taskID, phase string) {
	if repo == nil || logTask == nil {
		return
	}
	task, err := repo.Task(taskID)
	if err != nil || task == nil {
		return
	}
	payload, _ := json.Marshal(map[string]string{"phase": phase})
	message := "开始取回生成结果"
	if phase == "result_transfer_end" {
		message = "取回生成结果阶段结束"
	}
	_ = logTask(task.UserID, task.ID, "info", message, string(payload))
}

func SetTaskStage(ctx context.Context, repo *repository.Repository, logTask func(userID, taskID, level, msg, payload string) error, task model.Task, stage string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	err := repo.WithContext(ctx).UpdateTaskStageForLease(task.ID, task.LeaseOwner, stage)
	if err == nil && stage == "正在取回生成结果" {
		LogTaskPhase(repo, logTask, task.ID, "result_transfer_start")
	}
	return err
}

func ObserveTransportReceipt(observation TransportObservation, repo *repository.Repository, imageTaskFromCtx func(context.Context) (model.Task, bool), logCall func(model.ApiCallLog) error) {
	if observation.Request == nil {
		return
	}
	evidence := model.TaskRequestEvidence{
		StartedAt:             observation.StartedAt.Format(time.RFC3339Nano),
		ResponseLimitBytes:    observation.ResponseLimitBytes,
		Dispatched:            observation.Dispatched,
		TransportPhase:        observation.TransportPhase,
		TransportRoute:        observation.TransportRoute,
		HTTPStatus:            observation.HTTPStatus,
		DeclaredResponseBytes: observation.DeclaredResponseBytes,
		ReceivedBytes:         observation.ReceivedBytes,
		RequestID:             observation.RequestID,
		Outcome:               observation.Outcome,
	}
	RecordTaskRequestEvidence(observation.Request, evidence, observation.Body, observation.Err)
	if repo != nil {
		call := CanonicalCallMeta(observation.Request.Context())
		taskID := strings.TrimSpace(call.TaskID)
		isImage := call.Capability == "image" || strings.HasPrefix(strings.TrimSpace(call.TaskType), "canvas_image")
		if imageTaskFromCtx != nil {
			if imgTask, ok := imageTaskFromCtx(observation.Request.Context()); ok {
				if taskID == "" {
					taskID = strings.TrimSpace(imgTask.ID)
				}
				if strings.HasPrefix(strings.TrimSpace(imgTask.Type), "canvas_image") {
					isImage = true
				}
			}
		}
		if taskID != "" && isImage {
			if jobID := ExtractBeefTVImageJobID(observation.Headers, observation.Body); jobID != "" {
				_ = repo.UpdateTaskImageJobID(taskID, jobID)
			}
		}
	}
	RecordProviderRequest(repo, logCall, observation.Request, observation.StartedAt, observation.StatusCode, observation.Body, observation.Err)
}

func NotifyPollReceipt(ctx context.Context, repo *repository.Repository, logTask func(userID, taskID, level, msg, payload string) error, event string, err error) {
	if repo == nil || logTask == nil {
		return
	}
	call := CanonicalCallMeta(ctx)
	if strings.TrimSpace(call.TaskID) == "" {
		return
	}
	message := "上游任务查询暂时异常，正在继续查询原任务"
	level := "warn"
	payload := ""
	if err != nil {
		payload = err.Error()
	}
	if VideoPollEvent(event) == VideoPollEventRecovered {
		message = "上游任务查询已恢复"
		level = "info"
	}
	_ = logTask(call.UserID, call.TaskID, level, message, payload)
}

func ApplyStandardCapabilities(ctx context.Context, repo *repository.Repository, readLocalConfig func() ([]byte, error), input *Input) error {
	if input == nil {
		return nil
	}
	switch input.Mode {
	case "image":
		return ValidateResolvedImageCapability(repo, readLocalConfig, input)
	case "video":
		if IsBeefTVSeedancePreuploadConfig(ctx, input.Config) {
			if err := ResolveVideoCapability(ctx, repo, readLocalConfig, input); err != nil {
				return err
			}
			if strings.TrimSpace(input.Config.ChannelID) != "" && input.VideoCapability != nil {
				return validateVideoTaskParameters(input.VideoCapability, *input)
			}
			return nil
		}
		return ValidateResolvedVideoCapabilityContext(ctx, repo, readLocalConfig, input)
	default:
		return nil
	}
}

func InterceptImageRequest(req *http.Request, hasService bool, prepare func(*http.Request) (*model.ImageSubmission, bool, error), taskFromCtx func(context.Context) model.Task, send func(context.Context, model.Task, *model.ImageSubmission) ([]byte, string, error)) (bool, []byte, string, error) {
	if !RecoverableImageEndpoint(req) {
		return false, nil, "", nil
	}
	if !hasService {
		return true, nil, "", ImagePreparationError{ErrImageOwnerMissing}
	}
	row, handled, err := prepare(req)
	if err != nil {
		return true, nil, "", ImagePreparationError{err}
	}
	if !handled {
		data, mimeType, sendErr := DoBinaryWithConsumer(req, nil)
		return true, data, mimeType, sendErr
	}
	task := taskFromCtx(req.Context())
	data, mimeType, sendErr := send(req.Context(), task, row)
	return true, data, mimeType, sendErr
}
