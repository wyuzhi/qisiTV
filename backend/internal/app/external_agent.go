package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/canvascontract"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
)

type ExternalAgentConsent struct {
	Approved bool   `json:"approved"`
	Scope    string `json:"scope"`
}
type ExternalAgentTaskRequest struct {
	CanvasID       string               `json:"canvasId"`
	NodeID         string               `json:"nodeId,omitempty"`
	ChannelID      string               `json:"channelId,omitempty"`
	Type           string               `json:"type"`
	Model          string               `json:"model"`
	Prompt         string               `json:"prompt"`
	Input          map[string]any       `json:"input,omitempty"`
	Consent        ExternalAgentConsent `json:"consent"`
	IdempotencyKey string               `json:"idempotencyKey,omitempty"`
}

func (s *Service) ExternalAgentModels() ([]map[string]any, error) {
	if !s.IsLocalMode() {
		return nil, NewAppError(http.StatusNotFound, "外部 Agent 接口仅用于本地工作区")
	}
	items := []map[string]any{}
	for _, item := range s.localChannelModels() {
		if !item.Enabled {
			continue
		}
		kind := normalizeCapability(item.Capability)
		if kind == "" {
			for _, candidate := range []string{"image", "video", "text", "audio"} {
				if strings.HasSuffix(item.Protocol, "-"+candidate) {
					kind = candidate
				}
			}
		}
		if kind == "" {
			continue
		}
		items = append(items, map[string]any{"model": item.Model, "name": item.DisplayName, "type": kind, "channelId": item.ChannelID, "protocol": item.Protocol, "capabilityConfig": item.CapabilityConfig, "defaultOptions": s.externalAgentModelDefaults(item.ChannelID, item.Model)})
	}
	return items, nil
}

func (s *Service) externalAgentModelDefaults(channelID, modelName string) map[string]any {
	body, err := s.ReadLocalModelConfig()
	if err != nil {
		return map[string]any{}
	}
	var config struct {
		Channels []struct {
			ID            string `json:"id"`
			ModelProfiles []struct {
				Model          string         `json:"model"`
				DefaultOptions map[string]any `json:"defaultOptions"`
			} `json:"modelProfiles"`
		} `json:"channels"`
	}
	_ = json.Unmarshal(body, &config)
	for _, channel := range config.Channels {
		if channel.ID == channelID {
			for _, profile := range channel.ModelProfiles {
				if profile.Model == modelName && !externalAgentSensitiveValue(profile.DefaultOptions) {
					return profile.DefaultOptions
				}
			}
		}
	}
	return map[string]any{}
}

func externalAgentSensitiveValue(value any) bool {
	switch item := value.(type) {
	case map[string]any:
		for key, child := range item {
			normalized := strings.ToLower(strings.NewReplacer("-", "", "_", "").Replace(key))
			switch normalized {
			case "apikey", "secretkey", "authorization", "cookie", "token", "accesstoken", "bearertoken", "credentials", "password", "headers", "baseurl", "config", "credentialref", "runninghubwalletapikey", "runninghubuploadapikey":
				return true
			}
			if externalAgentSensitiveValue(child) {
				return true
			}
		}
	case []any:
		for _, child := range item {
			if externalAgentSensitiveValue(child) {
				return true
			}
		}
	}
	return false
}

func externalAgentOutputNodeID(taskID string, index int) string {
	// Existing completed tasks must resolve to their original output node IDs.
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("beeftv-task:"+taskID+":"+strconv.Itoa(index))).String()
}

func (s *Service) SubmitExternalAgentTask(userID string, request ExternalAgentTaskRequest) (*model.Task, string, error) {
	if !s.IsLocalMode() {
		return nil, "", NewAppError(http.StatusNotFound, "外部 Agent 接口仅用于本地工作区")
	}
	if !request.Consent.Approved || strings.TrimSpace(request.Consent.Scope) == "" || len(request.Consent.Scope) > 2000 {
		return nil, "", BadAuthRequest("必须明确确认本次生成费用范围 consent.approved 和 consent.scope")
	}
	if !wordSetExternal("text image video audio")[request.Type] || strings.TrimSpace(request.Model) == "" || strings.TrimSpace(request.Prompt) == "" || len(request.Prompt) > 64000 {
		return nil, "", BadAuthRequest("生成类型、模型或提示词无效")
	}
	if len(request.IdempotencyKey) > 160 || externalAgentSensitiveValue(request.Input) {
		return nil, "", BadAuthRequest("生成输入不能包含凭据、地址或 config")
	}
	for key := range request.Input {
		if key != "referenceNodeIds" && key != "options" {
			return nil, "", BadAuthRequest("input 仅接受 referenceNodeIds 与 options")
		}
	}
	if _, err := s.repo.CanvasProjectForUser(userID, request.CanvasID); err != nil {
		return nil, "", NewAppError(http.StatusNotFound, "目标画布不存在或无权访问")
	}
	requestHash, _ := json.Marshal(request)
	digest := sha256.Sum256(requestHash)
	fingerprint := hex.EncodeToString(digest[:])
	taskID := newID()
	if request.IdempotencyKey != "" {
		// Changing this persisted namespace could resubmit an already paid task.
		taskID = uuid.NewSHA1(uuid.NameSpaceURL, []byte("beeftv-external-task:"+userID+":"+request.IdempotencyKey)).String()
	}
	if existing, err := s.repo.TaskForUser(userID, taskID); err == nil {
		return existingExternalAgentTask(existing, fingerprint)
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, "", err
	}
	models, err := s.ExternalAgentModels()
	if err != nil {
		return nil, "", err
	}
	var selected map[string]any
	for _, item := range models {
		if stringValue(item["model"]) == request.Model && stringValue(item["type"]) == request.Type && (request.ChannelID == "" || stringValue(item["channelId"]) == request.ChannelID) {
			if selected != nil {
				return nil, "", BadAuthRequest("同名模型存在于多个渠道，请指定 channelId")
			}
			selected = item
		}
	}
	if selected == nil {
		return nil, "", BadAuthRequest("所选模型未在本地渠道启用，或类型不匹配")
	}
	config, ok := s.localAgentProviderConfig(request.Model, stringValue(selected["channelId"]))
	if !ok {
		return nil, "", BadAuthRequest("本地模型凭据未配置")
	}
	options := map[string]any{}
	if raw, exists := request.Input["options"]; exists {
		custom, ok := raw.(map[string]any)
		if !ok {
			return nil, "", BadAuthRequest("input.options 必须是对象")
		}
		for key, value := range custom {
			options[key] = value
		}
	}
	providerOptions := map[string]any{}
	protocol := stringValue(config["interfaceType"])
	if defaults := s.externalAgentModelDefaults(stringValue(selected["channelId"]), request.Model); len(defaults) > 0 {
		// Match the browser's generationMetadata contract: model-profile
		// defaults are protocol extension data (kwargs/body for LikeAI).
		providerOptions[protocol] = defaults
	}
	allowed := wordSetExternal("size quality transparentBackground count videoSeconds vquality videoGenerateAudio videoWatermark audioVoice audioFormat audioSpeed audioInstructions systemPrompt")
	for key, value := range options {
		if key == "providerOptions" {
			custom, ok := value.(map[string]any)
			if !ok {
				return nil, "", BadAuthRequest("providerOptions 必须是对象")
			}
			for namespace, raw := range custom {
				patch, ok := raw.(map[string]any)
				if !ok {
					return nil, "", BadAuthRequest("providerOptions 的协议参数必须是对象")
				}
				merged := map[string]any{}
				if defaults, ok := providerOptions[namespace].(map[string]any); ok {
					for key, item := range defaults {
						merged[key] = item
					}
				}
				for key, item := range patch {
					merged[key] = item
				}
				providerOptions[namespace] = merged
			}
			continue
		}
		if !allowed[key] {
			return nil, "", BadAuthRequest("不支持的生成配置: " + key)
		}
		switch value.(type) {
		case string, float64, bool, json.Number:
			config[key] = fmt.Sprint(value)
		default:
			return nil, "", BadAuthRequest("生成配置必须是字符串、数值或布尔值")
		}
	}
	if isLikeAIProtocol(stringValue(config["interfaceType"])) && request.Type == "video" {
		for key, value := range map[string]string{"videoSeconds": "5", "vquality": "720p", "size": "adaptive"} {
			if stringValue(config[key]) == "" {
				config[key] = value
			}
		}
	}
	nodeID := request.NodeID
	if nodeID == "" {
		nodeID = externalAgentOutputNodeID(taskID, 0)
	}
	if err = validateCloudAgentID(nodeID, "节点 ID", 80); err != nil {
		return nil, "", err
	}
	raw, err := s.UserCanvasProject(userID, request.CanvasID)
	if err != nil {
		return nil, "", err
	}
	doc, err := creationDocument(string(raw))
	if err != nil {
		return nil, "", err
	}
	nodes, err := creationObjects(doc["nodes"])
	if err != nil {
		return nil, "", err
	}
	var referenceIDs []string
	_, explicitReferences := request.Input["referenceNodeIds"]
	if value, exists := request.Input["referenceNodeIds"]; exists {
		data, _ := json.Marshal(value)
		if json.Unmarshal(data, &referenceIDs) != nil || len(referenceIDs) > canvascontract.MaxGenerationReferenceNodes {
			return nil, "", BadAuthRequest("referenceNodeIds 必须是最多 50 个节点 ID")
		}
	} else if target := nodes[nodeID]; target != nil {
		found := map[string]bool{}
		appendRef := func(id string) {
			if id != "" && !found[id] {
				found[id] = true
				referenceIDs = append(referenceIDs, id)
			}
		}
		for _, edge := range creationMaps(doc["connections"]) {
			if stringValue(edge["toNodeId"]) == nodeID {
				source := stringValue(edge["fromNodeId"])
				if cloudAgentReferenceAdapters[stringValue(nodes[source]["type"])].PayloadField != "" {
					appendRef(source)
				}
			}
		}
		meta, _ := target["metadata"].(map[string]any)
		if refs, ok := meta["referenceNodeIds"].([]any); ok {
			for _, ref := range refs {
				appendRef(stringValue(ref))
			}
		}
		appendRef(stringValue(meta["videoStartFrameNodeId"]))
		appendRef(stringValue(meta["videoEndFrameNodeId"]))
	}
	if len(referenceIDs) > canvascontract.MaxGenerationReferenceNodes {
		return nil, "", BadAuthRequest("参考节点最多 50 个")
	}
	input := map[string]any{"mode": request.Type, "prompt": request.Prompt, "config": config}
	seen := map[string]bool{}
	for _, id := range referenceIDs {
		if id == nodeID || seen[id] || nodes[id] == nil {
			return nil, "", BadAuthRequest("参考节点不存在或重复")
		}
		seen[id] = true
		ref, field, refErr := cloudAgentReference(s.repo, userID, nodes[id])
		if refErr != nil {
			return nil, "", refErr
		}
		list, _ := input[field].([]any)
		input[field] = append(list, ref)
	}
	if request.Type != "text" {
		if err = validateCloudAgentMediaReferences(request.Type, input); err != nil {
			return nil, "", err
		}
	}
	metadata := map[string]any{"source": "canvas", "nodeId": nodeID, "canvasId": request.CanvasID, "externalAgent": true, "externalAgentWriteback": "pending", "externalAgentFingerprint": fingerprint, "consent": request.Consent, "providerOptions": providerOptions}
	if target := nodes[nodeID]; target != nil {
		meta, _ := target["metadata"].(map[string]any)
		if stringValue(target["type"]) != request.Type || stringValue(meta["taskId"]) != "" || stringValue(meta["content"]) != "" || stringValue(meta["storageKey"]) != "" || meta["locked"] == true {
			return nil, "", BadAuthRequest("目标必须是同类型空白节点；已有成品或任务请新建节点")
		}
		for _, key := range []string{"videoStartFrameNodeId", "videoEndFrameNodeId"} {
			if id := stringValue(meta[key]); id != "" {
				if explicitReferences && !seen[id] {
					continue
				}
				if !seen[id] || stringValue(nodes[id]["type"]) != "image" {
					return nil, "", BadAuthRequest("首尾帧必须包含在图片参考节点中")
				}
				metadata[key] = id
			}
		}
	}
	input["metadata"] = metadata
	task, err := s.CreateTask(userID, CreateTaskRequest{ProjectID: request.CanvasID, Type: "canvas_" + request.Type, Operation: "external_agent_generate", Prompt: request.Prompt, Model: request.Model, Provider: stringValue(config["interfaceType"]), Input: input, creationPrepare: &creationTaskPreparation{}, admission: &taskAdmission{ID: taskID}})
	if err != nil {
		return nil, "", err
	}
	var normalized map[string]any
	_ = json.Unmarshal([]byte(task.InputJSON), &normalized)
	if err = s.protectTaskSecrets(normalized); err != nil {
		return nil, "", err
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return nil, "", err
	}
	task.InputJSON = string(encoded)
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, "", err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	err = s.repo.WithExternalAgentCanvasTransaction(func(repo *repository.Repository) error {
		if previous, findErr := repo.TaskForUser(userID, task.ID); findErr == nil {
			existing, _, reuseErr := existingExternalAgentTask(previous, fingerprint)
			if reuseErr != nil {
				return reuseErr
			}
			*task = *existing
			return nil
		} else if !errors.Is(findErr, gorm.ErrRecordNotFound) {
			return findErr
		}
		revision := int64(doc["revision"].(float64))
		nodeMeta := map[string]any{"externalAgent": true, "nodeRole": "generator", "prompt": request.Prompt, "composerContent": request.Prompt, "status": "loading", "taskId": task.ID, "taskStatus": "queued", "model": request.Model, "referenceNodeIds": referenceIDs}
		for _, key := range []string{"videoStartFrameNodeId", "videoEndFrameNodeId"} {
			// An explicit reference list also replaces stale first/last frame
			// selections. A nil patch removes a previously selected frame.
			nodeMeta[key] = metadata[key]
		}
		var ops []canvas.CanvasOperation
		if nodes[nodeID] == nil {
			ops = append(ops, canvas.CanvasOperation{Op: "add", Node: map[string]any{"id": nodeID, "type": request.Type, "title": request.Model, "position": map[string]any{"x": float64(len(nodes) * 400), "y": float64(0)}, "metadata": nodeMeta}})
		} else {
			ops = append(ops, canvas.CanvasOperation{Op: "update", NodeID: nodeID, Patch: map[string]any{"metadata": nodeMeta}})
		}
		for _, id := range referenceIDs {
			connected := false
			for _, edge := range creationMaps(doc["connections"]) {
				if stringValue(edge["fromNodeId"]) == id && stringValue(edge["toNodeId"]) == nodeID {
					connected = true
				}
			}
			if !connected {
				ops = append(ops, canvas.CanvasOperation{Op: "connect", Connection: map[string]any{"fromNodeId": id, "toNodeId": nodeID}})
			}
		}
		if _, saveErr := canvas.New(repo, nil).ApplyCanvasOperations(userID, request.CanvasID, canvas.CanvasOperationsRequest{BaseRevision: &revision, Operations: ops}); saveErr != nil {
			return saveErr
		}
		usage, usageErr := repo.UserStorageUsage(userID)
		if usageErr != nil {
			return usageErr
		}
		// The outer transaction includes the new canvas bytes already. Roll
		// it back with the task when admitting the placeholder exceeds quota.
		if quotaErr := validateStructuredStorageQuotaWithPolicy(usage, "canvas", false, 0, policy.Resource); quotaErr != nil {
			return quotaErr
		}
		return createTaskWithStorageQuotaRepository(repo, task, policy)
	})
	if err != nil {
		return nil, "", err
	}
	return taskForOutput(*task), nodeID, nil
}

func existingExternalAgentTask(task *model.Task, fingerprint string) (*model.Task, string, error) {
	var input struct {
		Metadata map[string]any `json:"metadata"`
	}
	_ = json.Unmarshal([]byte(task.InputJSON), &input)
	if stringValue(input.Metadata["externalAgentFingerprint"]) != fingerprint {
		return nil, "", NewAppError(http.StatusConflict, "幂等键已用于不同的生成请求")
	}
	return taskForOutput(*task), stringValue(input.Metadata["nodeId"]), nil
}
func wordSetExternal(words string) map[string]bool {
	result := map[string]bool{}
	for _, word := range strings.Fields(words) {
		result[word] = true
	}
	return result
}
