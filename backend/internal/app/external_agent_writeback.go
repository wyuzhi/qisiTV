package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
)

type ExternalAgentApplyRequest struct {
	CanvasID     string `json:"canvasId,omitempty"`
	NodeID       string `json:"nodeId,omitempty"`
	BaseRevision *int64 `json:"baseRevision,omitempty"`
}
type externalAgentOutput struct {
	kind  string
	media map[string]any
	text  string
}

func externalAgentOutputs(task *model.Task) ([]externalAgentOutput, error) {
	var result map[string]any
	if err := json.Unmarshal([]byte(task.ResultJSON), &result); err != nil {
		return nil, BadAuthRequest("任务结果格式无效")
	}
	outputs := []externalAgentOutput{}
	if images, ok := result["images"].([]any); ok {
		for _, raw := range images {
			media, ok := raw.(map[string]any)
			if !ok {
				return nil, BadAuthRequest("图片结果格式无效")
			}
			outputs = append(outputs, externalAgentOutput{kind: "image", media: media})
		}
	}
	for _, kind := range []string{"video", "audio"} {
		if media, ok := result[kind].(map[string]any); ok {
			outputs = append(outputs, externalAgentOutput{kind: kind, media: media})
		}
	}
	if text := stringValue(result["text"]); text != "" {
		outputs = append(outputs, externalAgentOutput{kind: "text", text: text})
	}
	if len(outputs) == 0 || len(outputs) > 100 {
		return nil, BadAuthRequest("任务没有可回填的结果或结果数量过多")
	}
	return outputs, nil
}

// Durable queue completion and the manual recovery tool share one writeback.
// Every output keeps the original canvas/task binding; deleted/rebound nodes
// are never recreated. Candidate media assets and canvas commit together.
func (s *Service) ApplyExternalAgentTask(userID, taskID string, request ExternalAgentApplyRequest) (map[string]any, error) {
	if !s.IsLocalMode() {
		return nil, NewAppError(http.StatusNotFound, "外部 Agent 接口仅用于本地工作区")
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	var response map[string]any
	var dispositionError error
	err = s.repo.WithExternalAgentCanvasTransaction(func(repo *repository.Repository) error {
		task, findErr := repo.TaskForUser(userID, taskID)
		if findErr != nil {
			return NewAppError(http.StatusNotFound, "任务不存在或无权访问")
		}
		var input map[string]any
		if json.Unmarshal([]byte(task.InputJSON), &input) != nil {
			return BadAuthRequest("任务输入记录无效")
		}
		metadata, _ := input["metadata"].(map[string]any)
		skip := func(message string, status int) error {
			metadata["externalAgentWriteback"] = "skipped"
			marked, _ := json.Marshal(input)
			if markErr := repo.CompleteExternalAgentWriteback(task, string(marked)); markErr != nil {
				return markErr
			}
			dispositionError = NewAppError(status, message)
			return nil
		}
		canvasID, nodeID := stringValue(metadata["canvasId"]), stringValue(metadata["nodeId"])
		if metadata["externalAgent"] != true || task.Operation != "external_agent_generate" || canvasID == "" || nodeID == "" || canvasID != task.ProjectID {
			return BadAuthRequest("任务缺少外部 Agent 画布绑定")
		}
		if (request.CanvasID != "" && request.CanvasID != canvasID) || (request.NodeID != "" && request.NodeID != nodeID) {
			return NewAppError(http.StatusConflict, "不能将任务结果重定向到其他画布或节点")
		}
		if task.Status != model.TaskStatusSucceeded && task.Status != model.TaskStatusFailed && task.Status != model.TaskStatusCancelled {
			return NewAppError(http.StatusConflict, "任务尚未完成")
		}
		canvasRecord, readErr := repo.CanvasProjectForUser(userID, canvasID)
		if readErr != nil {
			if errors.Is(readErr, gorm.ErrRecordNotFound) {
				return skip("目标画布已删除，任务结果仍保留", http.StatusNotFound)
			}
			return readErr
		}
		raw, readErr := canvas.New(repo, nil).UserCanvasProject(userID, canvasID)
		if readErr != nil {
			return readErr
		}
		doc, readErr := creationDocument(string(raw))
		if readErr != nil {
			return readErr
		}
		nodes, readErr := creationObjects(doc["nodes"])
		if readErr != nil {
			return readErr
		}
		if request.BaseRevision != nil && *request.BaseRevision != canvasRecord.Revision {
			return NewAppError(http.StatusConflict, "画布版本已变化")
		}
		if stringValue(metadata["externalAgentWriteback"]) == "complete" {
			response = map[string]any{"taskId": task.ID, "canvasId": canvasID, "nodeId": nodeID, "project": json.RawMessage(raw), "alreadyApplied": true}
			return nil
		}
		target := nodes[nodeID]
		targetMeta, _ := target["metadata"].(map[string]any)
		if target == nil || stringValue(targetMeta["taskId"]) != task.ID {
			return skip("目标节点已删除或任务绑定已变化，未覆盖画布", http.StatusConflict)
		}
		nodeList := creationMaps(doc["nodes"])
		candidateAssets := []json.RawMessage{}
		assetIDs := map[string]bool{}
		outputIDs := []string{nodeID}
		if task.Status == model.TaskStatusSucceeded {
			outputs, outputErr := externalAgentOutputs(task)
			if outputErr != nil {
				return outputErr
			}
			outputIDs = []string{}
			for index, output := range outputs {
				id := externalAgentOutputNodeID(task.ID, index)
				if index == 0 {
					id = nodeID
				}
				node := nodes[id]
				if node != nil {
					meta, _ := node["metadata"].(map[string]any)
					if stringValue(meta["taskId"]) != task.ID || stringValue(node["type"]) != output.kind {
						return NewAppError(http.StatusConflict, "输出节点已经存在且不属于该任务")
					}
				} else {
					if index == 0 {
						return NewAppError(http.StatusConflict, "目标节点已删除")
					}
					position, _ := target["position"].(map[string]any)
					x, _ := position["x"].(float64)
					y, _ := position["y"].(float64)
					node = map[string]any{"id": id, "type": output.kind, "title": fmt.Sprintf("%s %d", task.Model, index+1), "position": map[string]any{"x": x + float64(index*400), "y": y}, "width": float64(360), "height": float64(240), "metadata": map[string]any{"taskId": task.ID, "prompt": task.Prompt}}
					nodeList = append(nodeList, node)
				}
				meta, _ := node["metadata"].(map[string]any)
				if meta == nil {
					meta = map[string]any{}
					node["metadata"] = meta
				}
				if output.kind == "text" {
					meta["content"] = output.text
				} else {
					resourceID, _ := findTaskOutputResource(output.media, output.kind)
					resource, resourceErr := repo.ResourceForUser(userID, resourceID)
					if resourceErr != nil || resource.Status != model.ResourceStatusReady || !strings.HasPrefix(resource.MimeType, output.kind+"/") {
						return BadAuthRequest("生成结果尚未保存为当前工作区可用资源")
					}
					// Keep the persisted import namespace across the qisiTV rename.
					assetID := uuid.NewSHA1(uuid.NameSpaceURL, []byte("beeftv-agent:"+output.kind+":resource:"+resource.ID)).String()
					asset := map[string]any{"id": assetID, "kind": output.kind, "title": stringValue(node["title"]), "coverUrl": resourceFileURL(resource.ID), "tags": []string{}, "category": "material", "status": "confirmed", "source": "Canvas", "createdAt": resource.CreatedAt, "updatedAt": resource.UpdatedAt, "data": map[string]any{"dataUrl": resourceFileURL(resource.ID), "storageKey": "resource:" + resource.ID, "mimeType": resource.MimeType, "bytes": resource.Size, "width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs}, "metadata": map[string]any{"source": "canvas-generation", "canvasId": canvasID, "nodeId": id, "taskId": task.ID}}
					assetRaw, _ := json.Marshal(asset)
					if !assetIDs[assetID] {
						candidateAssets = append(candidateAssets, assetRaw)
						assetIDs[assetID] = true
					}
					meta["content"], meta["storageKey"], meta["assetId"], meta["mimeType"], meta["bytes"], meta["naturalWidth"], meta["naturalHeight"], meta["durationMs"] = resourceFileURL(resource.ID), "resource:"+resource.ID, assetID, resource.MimeType, resource.Size, resource.Width, resource.Height, resource.DurationMs
					meta["nodeRole"], meta["resultOrigin"] = "result", "generated"
					if width, ok := node["width"].(float64); ok && resource.Width > 0 && resource.Height > 0 {
						node["height"] = width * float64(resource.Height) / float64(resource.Width)
					}
				}
				meta["status"], meta["taskStatus"], meta["taskProgress"], meta["taskStage"] = "success", "succeeded", 100, "已完成"
				meta["externalAgent"] = true
				delete(meta, "errorDetails")
				node["updatedAt"] = time.Now().UTC()
				outputIDs = append(outputIDs, id)
			}
		} else {
			targetMeta["status"], targetMeta["taskStatus"], targetMeta["errorDetails"] = "error", string(task.Status), cloudAgentSafeMediaTaskError(task)
		}
		doc["nodes"] = nodeList
		encoded, encodeErr := json.Marshal(doc)
		if encodeErr != nil {
			return encodeErr
		}
		usage, usageErr := repo.UserStorageUsage(userID)
		if usageErr != nil {
			return usageErr
		}
		canvasDelta := int64(len(encoded) - len(canvasRecord.PayloadJSON))
		if quotaErr := validateStructuredStorageQuotaWithPolicy(usage, "canvas", false, canvasDelta, policy.Resource); quotaErr != nil {
			return quotaErr
		}
		usage.CanvasBytes += canvasDelta
		for _, assetRaw := range candidateAssets {
			asset, parseErr := canvas.AssetFromJSON(userID, assetRaw)
			if parseErr != nil {
				return parseErr
			}
			existingAsset, assetErr := repo.AssetForUser(userID, asset.ID)
			creating := errors.Is(assetErr, gorm.ErrRecordNotFound)
			if assetErr != nil && !creating {
				return assetErr
			}
			delta := int64(len(assetRaw))
			if existingAsset != nil {
				delta -= int64(len(existingAsset.PayloadJSON))
			}
			if quotaErr := validateStructuredStorageQuotaWithPolicy(usage, "asset", creating, delta, policy.Resource); quotaErr != nil {
				return quotaErr
			}
			if creating {
				usage.AssetCount++
			}
			usage.AssetBytes += delta
		}
		saved, saveErr := canvas.New(repo, nil).CommitUserCanvasProjectAssets(userID, encoded, candidateAssets)
		if saveErr != nil {
			return saveErr
		}
		metadata["externalAgentWriteback"] = "complete"
		marked, _ := json.Marshal(input)
		if markErr := repo.CompleteExternalAgentWriteback(task, string(marked)); markErr != nil {
			return markErr
		}
		doc["revision"], doc["updatedAt"] = saved.Revision, saved.UpdatedAt
		response = map[string]any{"taskId": task.ID, "canvasId": canvasID, "nodeId": nodeID, "nodeIds": outputIDs, "project": doc}
		return nil
	})
	if err == nil && dispositionError != nil {
		return nil, dispositionError
	}
	return response, err
}

func (s *Service) noteExternalAgentTask(task model.Task) {
	if !s.IsLocalMode() || task.Operation != "external_agent_generate" {
		return
	}
	// Pending state is durable and retried by the bounded recovery worker. Do
	// not emit the same warning every poll or include provider payloads in logs.
	_, _ = s.ApplyExternalAgentTask(task.UserID, task.ID, ExternalAgentApplyRequest{})
}

func (s *Service) startExternalAgentWritebackRecovery() {
	if !s.IsLocalMode() {
		return
	}
	s.runWorkerLoop(func(ctx context.Context) {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			// A blocked old result must not starve later completions. Scan in
			// bounded pages and advance even when one projection cannot save.
			cursor := ""
			for {
				tasks, err := s.repo.PendingExternalAgentWritebacks(50, cursor)
				if err != nil || len(tasks) == 0 {
					break
				}
				for _, task := range tasks {
					if ctx.Err() != nil {
						return
					}
					s.noteExternalAgentTask(task)
				}
				cursor = tasks[len(tasks)-1].ID
				if len(tasks) < 50 {
					break
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	})
}
