package task

import (
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/repository"
)

func SummariesForOutput(tasks []model.Task) []Summary {
	result := make([]Summary, 0, len(tasks))
	for _, task := range tasks {
		result = append(result, SummaryForOutput(task))
	}
	return result
}

func SummaryForOutput(task model.Task) Summary {
	task = CorrectPersistedVODParameterFailure(task)
	errorCode := generation.PersistedFailureErrorCode(task.Error, task.Stage)
	if errorCode == string(generation.CategoryUnknown) && !generation.IsContentModerationFailure(task.Error) {
		errorCode = ""
	}
	if generation.IsContentModerationFailure(task.Error) && errorCode == "" {
		errorCode = generation.ContentModerationErrorCode
	}
	previewURL, previewKind, previewPosterURL := MediaPreviewWithPoster(task.ResultJSON, task.Type)
	return Summary{
		ID:                        task.ID,
		ProjectID:                 task.ProjectID,
		Type:                      task.Type,
		Status:                    task.Status,
		Stage:                     task.Stage,
		Progress:                  task.Progress,
		Prompt:                    kernel.TruncateRunes(task.Prompt, 500),
		Operation:                 task.Operation,
		Provider:                  task.Provider,
		Model:                     task.Model,
		ProviderRequestID:         task.ProviderRequestID,
		ProviderCancelStatus:      task.ProviderCancelStatus,
		ProviderCancelError:       task.ProviderCancelError,
		ProviderCancelAttempts:    task.ProviderCancelAttempts,
		ProviderCancelRequestedAt: task.ProviderCancelRequestedAt,
		ProviderCancelledAt:       task.ProviderCancelledAt,
		Error:                     SafePersistedFailureMessage(task.Error, task.Stage),
		ErrorCode:                 errorCode,
		FailureDiagnostics:        generation.SanitizeTaskDiagnostics(task.FailureDiagnostics),
		PreviewURL:                previewURL,
		PreviewKind:               previewKind,
		PreviewPosterURL:          previewPosterURL,
		Attempts:                  task.Attempts,
		StartedAt:                 task.StartedAt,
		CompletedAt:               task.CompletedAt,
		CreatedAt:                 task.CreatedAt,
		UpdatedAt:                 task.UpdatedAt,
		ClientContext:             ClientContextFromInput(task.InputJSON),
	}
}

func ClientContextFromInput(raw string) *ClientContext {
	var input struct {
		Metadata struct {
			Source          string `json:"source"`
			SceneID         string `json:"sceneId"`
			NodeID          string `json:"nodeId"`
			ConversationID  string `json:"conversationId"`
			MessageID       string `json:"messageId"`
			BatchIndex      int    `json:"batchIndex"`
			BatchCount      int    `json:"batchCount"`
			DomainProjectID string `json:"domainProjectId"`
			ChapterID       string `json:"chapterId"`
			Operation       string `json:"operation"`
			ShotID          string `json:"shotId"`
			WorkflowStepID  string `json:"workflowStepId"`
			ArtifactType    string `json:"artifactType"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(raw), &input) != nil {
		return nil
	}
	metadata := input.Metadata
	ctx := &ClientContext{NodeID: metadata.NodeID}
	if metadata.Source == "director-panorama" && metadata.SceneID != "" {
		ctx.Source = metadata.Source
		ctx.SceneID = metadata.SceneID
		return ctx
	}
	if metadata.Source == "create-page" && metadata.ConversationID != "" && metadata.MessageID != "" {
		ctx.ConversationID = metadata.ConversationID
		ctx.MessageID = metadata.MessageID
		ctx.BatchIndex = metadata.BatchIndex
		ctx.BatchCount = metadata.BatchCount
		return ctx
	}
	if metadata.ShotID != "" && metadata.WorkflowStepID != "" {
		ctx.DomainProjectID = metadata.DomainProjectID
		ctx.ShotID = metadata.ShotID
		ctx.WorkflowStepID = metadata.WorkflowStepID
		ctx.ArtifactType = metadata.ArtifactType
		return ctx
	}
	chapterOperation := ""
	if metadata.Operation == "chapter_character_breakdown" {
		chapterOperation = "characters"
	} else if metadata.Source == "short-drama-chapter-storyboard" {
		chapterOperation = "storyboard"
	}
	if chapterOperation == "" || metadata.DomainProjectID == "" || metadata.ChapterID == "" {
		if ctx.NodeID == "" {
			return nil
		}
		return ctx
	}
	ctx.DomainProjectID = metadata.DomainProjectID
	ctx.ChapterID = metadata.ChapterID
	ctx.ChapterOperation = chapterOperation
	return ctx
}

func MediaPreview(raw string, taskType string) (string, string) {
	previewURL, previewKind, _ := MediaPreviewWithPoster(raw, taskType)
	return previewURL, previewKind
}

func MediaPreviewWithPoster(raw string, taskType string) (string, string, string) {
	if strings.TrimSpace(raw) == "" {
		return "", "", ""
	}
	var payload any
	if json.Unmarshal([]byte(raw), &payload) != nil {
		return "", "", ""
	}
	defaultKind := "image"
	if strings.Contains(strings.ToLower(taskType), "video") {
		defaultKind = "video"
	}
	previewURL, previewKind := findTaskMediaPreview(payload, defaultKind)
	posterURL := findTaskMediaPoster(payload)
	if previewKind == "image" && posterURL == "" {
		posterURL = previewURL
	}
	return previewURL, previewKind, posterURL
}

func findTaskMediaPoster(value any) string {
	switch item := value.(type) {
	case []any:
		for _, child := range item {
			if posterURL := findTaskMediaPoster(child); posterURL != "" {
				return posterURL
			}
		}
	case map[string]any:
		for _, key := range []string{"posterUrl", "posterURL", "thumbnailUrl", "thumbnailURL", "coverUrl", "coverURL", "poster", "thumbnail", "cover"} {
			child, exists := item[key]
			if !exists {
				continue
			}
			if previewURL, previewKind := findTaskMediaPreview(child, "image"); previewURL != "" && previewKind == "image" {
				return previewURL
			}
		}
		for _, child := range item {
			if posterURL := findTaskMediaPoster(child); posterURL != "" {
				return posterURL
			}
		}
	}
	return ""
}

func findTaskMediaPreview(value any, hint string) (string, string) {
	switch item := value.(type) {
	case string:
		text := strings.TrimSpace(item)
		if !assets.IsFileURL(text) && !strings.HasPrefix(text, "http://") && !strings.HasPrefix(text, "https://") {
			return "", ""
		}
		kind := hint
		lower := strings.ToLower(text)
		if strings.Contains(lower, ".mp4") || strings.Contains(lower, ".webm") || strings.Contains(lower, ".mov") {
			kind = "video"
		} else if kind != "video" {
			kind = "image"
		}
		return text, kind
	case []any:
		for _, child := range item {
			if previewURL, previewKind := findTaskMediaPreview(child, hint); previewURL != "" {
				return previewURL, previewKind
			}
		}
	case map[string]any:
		for _, key := range []string{"images", "image", "video", "dataUrl", "url", "resultUrl", "outputUrl"} {
			child, exists := item[key]
			if !exists {
				continue
			}
			childHint := hint
			if key == "video" {
				childHint = "video"
			} else if key == "images" || key == "image" {
				childHint = "image"
			}
			if previewURL, previewKind := findTaskMediaPreview(child, childHint); previewURL != "" {
				return previewURL, previewKind
			}
		}
	}
	return "", ""
}

func TaskForOutput(task model.Task) *model.Task {
	task = CorrectPersistedVODParameterFailure(task)
	task.FailureDiagnostics = generation.SanitizeTaskDiagnostics(task.FailureDiagnostics)
	task.InputJSON = PublicTaskInputJSON(task.InputJSON)
	task.LogicalModelRevisionID = ""
	task.RouteID = ""
	task.ChannelModelID = ""
	task.ErrorCode = generation.PersistedFailureErrorCode(task.Error, task.Stage)
	if task.ErrorCode == string(generation.CategoryUnknown) && !generation.IsContentModerationFailure(task.Error) {
		task.ErrorCode = ""
	}
	task.Error = SafePersistedFailureMessage(task.Error, task.Stage)
	return &task
}

func SafePersistedFailureMessage(message, stage string) string {
	if strings.TrimSpace(message) == "" {
		return ""
	}
	if stage == "submission_unknown" {
		return (generation.Failure{Category: generation.CategorySubmissionUncertain}).UserMessage()
	}
	return generation.ClassifyText(message).UserMessage()
}

func PublicTaskInputJSON(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		return ""
	}
	public := map[string]any{}
	if input["mode"] == "video" {
		config, _ := input["config"].(map[string]any)
		counts := func(key string) int { items, _ := input[key].([]any); return len(items) }
		parameters := map[string]any{"imageCount": counts("referenceImages"), "videoCount": counts("referenceVideos"), "audioCount": counts("referenceAudios")}
		for _, key := range []string{"model", "size"} {
			if value, ok := config[key].(string); ok {
				parameters[key] = value
			}
		}
		base, _ := config["baseUrl"].(string)
		u, _ := url.Parse(base)
		host := ""
		if u != nil {
			host = strings.ToLower(u.Hostname())
		}
		parameters["affectedChannel"] = config["credentialRef"] == "beeftv" || host == "beeftv.app" || host == "whatstoken.ai" || host == "www.whatstoken.ai"
		public["videoParameters"] = parameters
	}
	for _, key := range []string{"mode", "metadata", "workflowStepId", "domainProjectId", "assetVersionId", "resourceId", "mediaType", "role"} {
		if value, ok := input[key]; ok {
			public[key] = value
		}
	}
	if len(public) == 0 {
		return ""
	}
	data, _ := json.Marshal(public)
	return string(data)
}

func CorrectPersistedVODParameterFailure(task model.Task) model.Task {
	d := task.FailureDiagnostics
	if task.Type != "canvas_image" || task.Status != model.TaskStatusFailed || task.Stage != "submission_unknown" || d == nil || d.OmittedRequests != 0 || len(d.Requests) != 1 {
		return task
	}
	r := d.Requests[0]
	if !r.Dispatched || r.Outcome != "http_error" || r.HTTPStatus != 400 || r.ProviderCode != d.ProviderCode || d.HTTPStatus != 400 || (r.ProviderCode != "vod_image_invalid_params" && r.ProviderCode != "vod_image_invalid_media") {
		return task
	}
	raw, _ := json.Marshal(map[string]any{"error": map[string]string{"code": r.ProviderCode}})
	failure := generation.ClassifyError(generation.HTTPError{StatusCode: 400, Body: string(raw)})
	task.Stage = "生成失败"
	task.Error = failure.UserMessage()
	task.FailureDiagnostics = generation.SanitizeTaskDiagnostics(d)
	task.FailureDiagnostics.Summary = failure.UserMessage()
	task.FailureDiagnostics.Stage = task.Stage
	return task
}

func CompletionInputJSON(task model.Task, resultJSON []byte, decryptInput func(string) (string, error), encryptSecret func(string) (string, error)) (string, error) {
	public := PublicTaskInputJSON(task.InputJSON)
	if task.Type != "canvas_image" {
		return public, nil
	}
	var result struct {
		Images []struct {
			URL     string `json:"url"`
			DataURL string `json:"dataUrl"`
		} `json:"images"`
	}
	if err := json.Unmarshal(resultJSON, &result); err != nil {
		return "", err
	}
	remote := false
	for _, imageItem := range result.Images {
		remote = remote || strings.HasPrefix(imageItem.URL, "https://") || strings.HasPrefix(imageItem.URL, "http://")
		remote = remote || strings.HasPrefix(imageItem.DataURL, "https://") || strings.HasPrefix(imageItem.DataURL, "http://")
	}
	if !remote {
		return public, nil
	}
	plain, err := decryptInput(task.InputJSON)
	if err != nil {
		return "", err
	}
	var input map[string]json.RawMessage
	if err := json.Unmarshal([]byte(plain), &input); err != nil {
		return "", err
	}
	if len(input["config"]) == 0 {
		return public, nil
	}
	var original map[string]json.RawMessage
	if err := json.Unmarshal(input["config"], &original); err != nil {
		return "", err
	}
	config := map[string]json.RawMessage{}
	for _, key := range []string{"channelId", "channelModelKey", "providerModelKey", "variantId", "apiFormat", "interfaceType", "baseUrl", "apiKey", "secretKey", "headers", "credentialRef", "model"} {
		if value, ok := original[key]; ok {
			config[key] = value
		}
	}
	configJSON, err := json.Marshal(config)
	if err != nil {
		return "", err
	}
	cipher, err := encryptSecret(string(configJSON))
	if err != nil {
		return "", err
	}
	payload := map[string]any{}
	if public != "" {
		if err := json.Unmarshal([]byte(public), &payload); err != nil {
			return "", err
		}
	}
	payload["imageDeliveryCipher"] = cipher
	encoded, err := json.Marshal(payload)
	return string(encoded), err
}

func OutcomeFactsForTasks(repo *repository.Repository, tasks []model.Task, stageRequestNotSent string) map[string]OutcomeFacts {
	ids := make([]string, 0, len(tasks))
	for _, task := range tasks {
		if task.Status != model.TaskStatusQueued && task.Status != model.TaskStatusRunning && task.Status != model.TaskStatusSucceeded {
			ids = append(ids, task.ID)
		}
	}
	evidence, err := repo.ImageRecoveryEvidence(ids)
	facts := make(map[string]OutcomeFacts, len(tasks))
	for _, task := range tasks {
		f := OutcomeFacts{Unreadable: err != nil, RequestNotSent: task.Stage == stageRequestNotSent}
		if e, ok := evidence[task.ID]; ok {
			f.HasImageReceipt = e.HasReceipt
			if e.Attempt != nil && e.Attempt.RouteRun == task.RouteRun {
				f.DispatchState = e.Attempt.DispatchState
				if e.Submission != nil && e.Submission.UserID == task.UserID {
					f.ImageResponseAccepted = e.Submission.ResponseAccepted
				}
			}
		}
		facts[task.ID] = f
	}
	return facts
}

type DeliveryProgressRegistry struct {
	mu      sync.Mutex
	entries map[string]model.TaskDeliveryOutputProgress
}

func (r *DeliveryProgressRegistry) Record(identity string, progress model.TaskDeliveryOutputProgress) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.entries == nil {
		r.entries = map[string]model.TaskDeliveryOutputProgress{}
	}
	progress.UpdatedAt = time.Now().UnixMilli()
	r.entries[identity] = progress
}

func (r *DeliveryProgressRegistry) Clear(identity string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.entries, identity)
}

func (r *DeliveryProgressRegistry) ForTask(taskID string) *model.TaskDeliveryProgress {
	if r == nil {
		return nil
	}
	prefix := strings.TrimSpace(taskID) + ":"
	r.mu.Lock()
	defer r.mu.Unlock()
	outputs := make([]model.TaskDeliveryOutputProgress, 0, len(r.entries))
	for identity, progress := range r.entries {
		if strings.HasPrefix(identity, prefix) {
			outputs = append(outputs, progress)
		}
	}
	if len(outputs) == 0 {
		return nil
	}
	sort.Slice(outputs, func(i, j int) bool { return outputs[i].OutputIndex < outputs[j].OutputIndex })
	return &model.TaskDeliveryProgress{Outputs: outputs}
}

func DeliveryOutputIndex(identity string) int {
	if index := strings.LastIndex(identity, ":"); index >= 0 {
		if parsed, err := strconv.Atoi(identity[index+1:]); err == nil {
			return parsed
		}
	}
	return 0
}

func DeliveryProgressFromOutbound(identity string, progress outbound.ResumableProgress) model.TaskDeliveryOutputProgress {
	return model.TaskDeliveryOutputProgress{
		OutputIndex:     DeliveryOutputIndex(identity),
		DownloadedBytes: progress.DownloadedBytes,
		TotalBytes:      progress.TotalBytes,
		BytesPerSecond:  progress.BytesPerSecond,
		State:           progress.State,
	}
}

type ReferenceProgressPort struct {
	Map    *sync.Map
	TaskID string
	mu     sync.Mutex
	closed bool
	value  *generation.ReferenceProgress
}

func NewReferenceProgressPort(store *sync.Map, taskID string) *ReferenceProgressPort {
	p := &ReferenceProgressPort{Map: store, TaskID: taskID}
	store.Store(taskID, p)
	return p
}

func (p *ReferenceProgressPort) ReportReference(value generation.ReferenceProgress) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.closed {
		p.value = &value
	}
}

func (p *ReferenceProgressPort) ClearReference() {
	p.mu.Lock()
	p.closed = true
	p.value = nil
	p.mu.Unlock()
	if p.Map != nil {
		p.Map.CompareAndDelete(p.TaskID, p)
	}
}

func ReferenceProgressForTask(store *sync.Map, taskID string) *generation.ReferenceProgress {
	if store == nil {
		return nil
	}
	value, ok := store.Load(taskID)
	if !ok {
		return nil
	}
	p, ok := value.(*ReferenceProgressPort)
	if !ok || p == nil {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.value == nil {
		return nil
	}
	progress := *p.value
	return &progress
}

const (
	TextStreamFlushBytes    = 2 << 10
	TextStreamFlushInterval = 500 * time.Millisecond
)

type TextStreamPublisher struct {
	UserID   string
	TaskID   string
	Append   func(userID, taskID, delta string) error
	LogWarn  func(userID, taskID, msg, payload string)
	Sink     func(string) error
	mu       sync.Mutex
	buffer   strings.Builder
	timer    *time.Timer
	disabled bool
	closed   bool
}

func (p *TextStreamPublisher) Publish(delta string) {
	if p == nil || delta == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.disabled || p.closed {
		return
	}
	p.buffer.WriteString(delta)
	if p.buffer.Len() >= TextStreamFlushBytes {
		p.flushLocked()
		return
	}
	if p.timer == nil {
		p.timer = time.AfterFunc(TextStreamFlushInterval, p.flush)
	}
}

func (p *TextStreamPublisher) Close() {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	p.flushLocked()
}

func (p *TextStreamPublisher) flush() {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.flushLocked()
}

func (p *TextStreamPublisher) flushLocked() {
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
	if p.disabled || p.buffer.Len() == 0 {
		return
	}
	content := p.buffer.String()
	p.buffer.Reset()
	var err error
	if p.Sink != nil {
		err = p.Sink(content)
	} else if p.Append != nil {
		err = p.Append(p.UserID, p.TaskID, content)
	}
	if err != nil {
		p.disabled = true
		if p.LogWarn != nil {
			p.LogWarn(p.UserID, p.TaskID, "文本流持久化已降级", err.Error())
		}
	}
}
