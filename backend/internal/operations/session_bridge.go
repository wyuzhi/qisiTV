package operations

import (
	"errors"
	"strings"

	"gorm.io/gorm"

	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/conversation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
	localtask "qisitv/backend/internal/task"
	"qisitv/backend/internal/taskbinding"
)

func WorkspaceTask(repo *repository.Repository, userID, id string) (*model.Task, error) {
	if repo == nil {
		return nil, gorm.ErrRecordNotFound
	}
	return repo.TaskForUser(userID, id)
}

func GenerationOutputs(repo *repository.Repository, taskID string) ([]localtask.CanonicalOutput, error) {
	if repo == nil {
		return nil, nil
	}
	results, err := repo.GenerationOutputResults(taskID)
	if err != nil {
		return nil, err
	}
	outputs, err := localtask.DecodeOutputResults(results)
	if err != nil {
		return nil, &taskbinding.Error{Status: 412, Reason: localtask.MaterializeErrorDeliveryUnreadable, Message: "任务产物无法读取，不能当作已就绪结果绑定"}
	}
	return outputs, nil
}

func OwnedReadyResource(repo *repository.Repository, userID, resourceID string) (*model.Resource, error) {
	resourceID = strings.TrimSpace(resourceID)
	if repo == nil || resourceID == "" {
		return nil, &taskbinding.Error{Status: 412, Reason: localtask.MaterializeErrorResourceMissing, Message: "任务资源不存在"}
	}
	resource, err := repo.ResourceForUser(userID, resourceID)
	if err == nil {
		if resource.Status != model.ResourceStatusReady {
			return nil, &taskbinding.Error{Status: 412, Reason: localtask.MaterializeErrorResourceNotReady, Message: "任务资源未就绪"}
		}
		return resource, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	if _, lookupErr := repo.Resource(resourceID); lookupErr == nil {
		return nil, &taskbinding.Error{Status: 403, Reason: localtask.MaterializeErrorResourceForeign, Message: "任务资源不属于当前用户"}
	}
	return nil, &taskbinding.Error{Status: 412, Reason: localtask.MaterializeErrorResourceMissing, Message: "任务资源不存在"}
}

func OwnedAsset(repo *repository.Repository, userID, assetID string) (*model.Asset, error) {
	assetID = strings.TrimSpace(assetID)
	if repo == nil || assetID == "" {
		return nil, &taskbinding.Error{Status: 412, Reason: "output_not_ready", Message: "任务素材尚未就绪"}
	}
	asset, err := repo.AssetForUser(userID, assetID)
	if err == nil {
		return asset, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	existing, lookupErr := repo.Asset(assetID)
	if lookupErr == nil && existing != nil && existing.UserID != userID {
		return nil, &taskbinding.Error{Status: 403, Reason: localtask.MaterializeErrorAssetForeign, Message: "任务素材不属于当前用户"}
	}
	return nil, &taskbinding.Error{Status: 412, Reason: "output_not_ready", Message: "任务素材尚未就绪"}
}

func PrepareCanvasNodeBind(repo *repository.Repository, userID string, patch canvas.TaskOutputBind) (canvas.TaskOutputBind, *model.Task, error) {
	patch.AllowEmptyVideo = false
	patch.PendingClientOperationID = ""
	patch.TaskType = ""
	task, err := repo.TaskForUser(userID, patch.TaskID)
	if err != nil {
		return canvas.TaskOutputBind{}, nil, err
	}
	if task != nil {
		patch.TaskType = task.Type
	}
	if task != nil && task.UserID == userID && task.ProjectID == patch.CanvasID && task.Type == model.TaskTypeTimelineRender && task.Provider == "local" && task.Model == "ffmpeg" && task.Status == model.TaskStatusSucceeded {
		patch.AllowEmptyVideo = true
	}
	if task != nil && task.UserID == userID && task.ProjectID == patch.CanvasID && (task.Type == model.TaskTypeDepthCapture || task.Type == "canvas_video") && task.Status == model.TaskStatusSucceeded && task.ClientOperationID != nil {
		target := localtask.TargetBindingFromInput(task.InputJSON)
		if target.NodeID == patch.NodeID && target.Source == "canvas" {
			patch.PendingClientOperationID = strings.TrimSpace(*task.ClientOperationID)
		}
	}
	return patch, task, nil
}

func UserConversation(repo *repository.Repository, tx *gorm.DB, userID, conversationID string) (taskbinding.ConversationView, error) {
	if repo == nil {
		return taskbinding.ConversationView{}, gorm.ErrRecordNotFound
	}
	row, err := repo.CreationConversation(tx, userID, conversationID)
	if err != nil {
		return taskbinding.ConversationView{}, err
	}
	view := taskbinding.ConversationView{
		ID:       row.ConversationID,
		Revision: row.Revision,
		Deleted:  row.Deleted,
	}
	if !row.Deleted {
		view.Document = []byte(row.Document)
	}
	return view, nil
}

func AttachConversationMessage(repo *repository.Repository, tx *gorm.DB, userID string, input taskbinding.MessageAttachInput) (taskbinding.ConversationView, error) {
	var svc *conversation.Service
	if repo == nil {
		svc = conversation.New(nil)
	} else {
		svc = conversation.New(conversation.NewStore(repo))
		if tx != nil {
			svc = svc.WithTx(tx)
		}
	}
	record, err := svc.AttachMessageResult(userID, conversation.AttachInput{
		ConversationID: input.ConversationID,
		MessageID:      input.MessageID,
		TaskID:         input.TaskID,
		EffectKey:      input.EffectKey,
		ResultURLs:     input.ResultURLs,
		Status:         input.Status,
		Content:        input.Content,
	})
	if err != nil {
		return taskbinding.ConversationView{}, MapConversationAttachError(err)
	}
	return taskbinding.ConversationView{
		ID:       record.ID,
		Revision: record.Revision,
		Deleted:  record.Deleted,
		Document: record.Document,
	}, nil
}

func MapConversationAttachError(err error) error {
	if err == nil {
		return nil
	}
	var convErr *conversation.Error
	if !errors.As(err, &convErr) {
		return err
	}
	switch convErr.Reason {
	case conversation.ReasonNotFound:
		return &taskbinding.Error{Status: 404, Reason: "conversation_deleted", Message: convErr.Message}
	case conversation.ReasonDeleted:
		return &taskbinding.Error{Status: 409, Reason: "conversation_deleted", Message: convErr.Message}
	case conversation.ReasonMessageTaskMismatch:
		return &taskbinding.Error{Status: 409, Reason: "message_task_mismatch", Message: convErr.Message}
	case conversation.ReasonStaleRevision, conversation.ReasonConflict:
		return &taskbinding.Error{Status: 409, Reason: "stale_revision", Message: convErr.Message}
	default:
		return &taskbinding.Error{Status: convErr.Status, Reason: convErr.Reason, Message: convErr.Message}
	}
}
