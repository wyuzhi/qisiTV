package beefapi

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

type LegacyVideoReference struct{ ID, Kind, URL string }

var ErrReferencesNotUploaded = errors.New("参考素材尚未上传完成")
var ErrInvalidVideoReferences = errors.New("已选择的关键帧不在本次参考素材中")

type LegacyVideoInput struct {
	Model, Prompt, Seconds, Resolution, AspectRatio, DraftTaskID string
	GenerateAudio, Watermark, Draft, ReturnLastFrame             *bool
	References                                                   []LegacyVideoReference
	Metadata                                                     map[string]any
}

// This describes the user's requested content. Provider defaults, supported
// roles and model validation belong to BeefAPI's existing /videos normalizer.
func LegacyVideoBody(input LegacyVideoInput) (map[string]any, error) {
	body := map[string]any{"model": input.Model, "prompt": input.Prompt}
	if input.Seconds != "" {
		body["seconds"] = input.Seconds
	}
	if input.Resolution != "" {
		body["resolution"] = input.Resolution
	}
	if input.AspectRatio != "" {
		body["aspect_ratio"] = input.AspectRatio
	}
	metadata := map[string]any{}
	if input.GenerateAudio != nil {
		metadata["generate_audio"] = *input.GenerateAudio
	}
	if input.Watermark != nil {
		metadata["watermark"] = *input.Watermark
	}
	if input.ReturnLastFrame != nil {
		body["return_last_frame"] = *input.ReturnLastFrame
		metadata["return_last_frame"] = *input.ReturnLastFrame
	}
	if draftID := strings.TrimSpace(input.DraftTaskID); draftID != "" {
		body["draft_task_id"] = draftID
		metadata["draft_task_id"] = draftID
		metadata["operation"] = "draft_to_final"
		delete(body, "prompt")
		delete(body, "seconds")
		delete(body, "aspect_ratio")
		delete(metadata, "generate_audio")
		if len(metadata) > 0 {
			body["metadata"] = metadata
		}
		return body, nil
	}
	if input.Draft != nil && *input.Draft {
		body["draft"] = true
		metadata["draft"] = true
	}
	if operation, _ := input.Metadata["videoEditOperation"].(string); operation != "" {
		metadata["operation"] = operation
	}
	if value, ok := input.Metadata["videoMiddleFrameTime"]; ok {
		body["middle_frame_time"] = value
	}
	if controls, ok := input.Metadata["videoH3Options"].(map[string]any); ok {
		// sync_mode selects result transport, so even a historical value must
		// never override BeefAPI's URL/task delivery contract.
		for _, key := range []string{"seed", "prompt_expansion_mode", "damage_level", "enable_safety_checker"} {
			if value, exists := controls[key]; exists {
				body[key] = value
			}
		}
	}
	refs, err := VideoIntentReferences(input)
	if err != nil {
		return nil, err
	}
	content := make([]map[string]any, 0, len(refs))
	for _, ref := range refs {
		if ref.URL == "" {
			return nil, ErrReferencesNotUploaded
		}
		kind := ref.Kind + "_url"
		content = append(content, map[string]any{"type": kind, kind: map[string]any{"url": ref.URL}, "role": ref.Role})
	}
	if len(content) > 0 {
		body["content"] = content
	}
	if len(metadata) > 0 {
		body["metadata"] = metadata
	}
	return body, nil
}

type VideoIntentReference struct {
	LegacyVideoReference
	Role        string
	SourceIndex int
}

// Frame selection and user reference order are shared by legacy and managed
// envelopes. Neither envelope derives roles from a supplier or model name.
func VideoIntentReferences(input LegacyVideoInput) ([]VideoIntentReference, error) {
	roles := map[string][]string{}
	for _, selected := range []struct{ key, role string }{{"videoStartFrameNodeId", "first_frame"}, {"videoEndFrameNodeId", "last_frame"}, {"videoMiddleFrameNodeId", "middle_frame"}} {
		if id, _ := input.Metadata[selected.key].(string); id != "" {
			found := false
			for _, ref := range input.References {
				if ref.ID == id && ref.Kind == "image" {
					found = true
					break
				}
			}
			if !found {
				return nil, ErrInvalidVideoReferences
			}
			roles[id] = append(roles[id], selected.role)
		}
	}
	references := make([]VideoIntentReference, len(input.References))
	for index, ref := range input.References {
		references[index] = VideoIntentReference{LegacyVideoReference: ref, SourceIndex: index}
	}
	var order []string
	switch raw := input.Metadata["videoReferenceOrder"].(type) {
	case []string:
		order = raw
	case []any:
		for _, value := range raw {
			if id, ok := value.(string); ok {
				order = append(order, id)
			}
		}
	}
	if len(order) > 0 {
		sorted := make([]VideoIntentReference, 0, len(references))
		seen := map[string]bool{}
		for _, id := range order {
			for _, ref := range references {
				if ref.ID == id && !seen[id] {
					sorted = append(sorted, ref)
					seen[id] = true
				}
			}
		}
		for _, ref := range references {
			if !seen[ref.ID] {
				sorted = append(sorted, ref)
			}
		}
		references = sorted
	}
	result := make([]VideoIntentReference, 0, len(references))
	for _, ref := range references {
		selected := roles[ref.ID]
		if len(selected) == 0 {
			selected = []string{"reference_" + ref.Kind}
		}
		for _, role := range selected {
			item := ref
			item.Role = role
			result = append(result, item)
		}
	}
	return result, nil
}

// Dispatch is stricter than historical body inspection: built-in video creates
// never carry inline bytes, including stale plugin or persisted inputs.
func (c *MediaClient) CreateLegacyVideo(ctx context.Context, key string, input LegacyVideoInput) (string, error) {
	for _, ref := range input.References {
		parsed, err := url.Parse(ref.URL)
		if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
			return "", ErrReferencesNotUploaded
		}
	}
	body, err := LegacyVideoBody(input)
	if err != nil {
		return "", err
	}
	var created map[string]any
	if err := c.LegacyCreate(ctx, "/videos", key, body, &created); err != nil {
		return "", err
	}
	if nested, ok := created["data"].(map[string]any); ok {
		created = nested
	}
	for _, field := range []string{"id", "task_id"} {
		if value, ok := created[field].(string); ok && value != "" {
			return value, nil
		}
	}
	return "", errors.New("视频接口没有返回有效任务编号")
}

type LegacyVideoTask struct {
	ID                            string
	State                         map[string]any
	Status, URL, LastFrameURL     string
	UsageState, ReconcileDeadline *string
	ContentPath                   string
}

func (t LegacyVideoTask) Done() bool {
	switch t.Status {
	case "completed", "succeeded", "success", "done":
		return true
	}
	return false
}
func (t LegacyVideoTask) Failure() error {
	switch t.Status {
	case "failed", "failure", "cancelled", "expired":
		if value, ok := t.State["error"].(map[string]any); ok {
			if message, ok := value["message"].(string); ok && message != "" {
				return &MediaTaskError{Category: "async_failed", TaskID: t.ID, Message: message}
			}
		}
		return &MediaTaskError{Code: "video_task_failed", Category: "async_failed", TaskID: t.ID, Message: "原视频任务未成功，请查询原任务结果与扣费"}
	}
	return nil
}

func (c *MediaClient) QueryLegacyVideo(ctx context.Context, id string) (LegacyVideoTask, error) {
	var task LegacyVideoTask
	task.ID = id
	if id == "" {
		return task, errors.New("视频任务编号为空")
	}
	path := "/videos/" + url.PathEscape(id)
	err := c.LegacyJSON(ctx, http.MethodGet, path, nil, &task.State)
	var upstream *MediaHTTPError
	if errors.As(err, &upstream) && upstream.StatusCode == 404 {
		err = c.LegacyJSON(ctx, http.MethodGet, "/video/generations/"+url.PathEscape(id), nil, &task.State)
	}
	if err != nil {
		return task, err
	}
	state := task.State
	for state != nil {
		for _, key := range []string{"id", "task_id", "taskId"} {
			if value, exists := state[key]; exists && value != nil {
				identity, ok := value.(string)
				if !ok || identity != "" && identity != id {
					return task, errors.New("视频回执与原任务编号不一致")
				}
			}
		}
		if task.UsageState == nil {
			if value, ok := state["usage_state"].(string); ok {
				task.UsageState = &value
			}
		}
		if task.ReconcileDeadline == nil {
			if value, ok := state["reconcile_deadline"].(string); ok {
				task.ReconcileDeadline = &value
			}
		}
		nested, _ := state["data"].(map[string]any)
		if nested == nil {
			break
		}
		state = nested
	}
	value, _ := state["status"].(string)
	task.Status = strings.ToLower(value)
	task.URL, _ = state["video_url"].(string)
	task.LastFrameURL, _ = state["last_frame_url"].(string)
	if metadata, ok := state["metadata"].(map[string]any); ok {
		if status, _ := metadata["generation_status"].(string); status != "" {
			task.Status = strings.ToLower(status)
		}
		if task.URL == "" {
			task.URL, _ = metadata["url"].(string)
		}
		if task.LastFrameURL == "" {
			task.LastFrameURL, _ = metadata["last_frame_url"].(string)
		}
	}
	if task.URL == "" {
		task.URL, _ = state["url"].(string)
	}
	if task.URL == "" {
		if output, ok := state["output"].(map[string]any); ok {
			task.URL, _ = output["url"].(string)
		}
	}
	if task.URL == "" {
		task.URL = legacyVideoResultURL(state, 0)
	}
	if task.URL != "" {
		for _, path := range []string{"/videos/" + url.PathEscape(id) + "/content", "/video/generations/" + url.PathEscape(id) + "/content"} {
			absolute, _ := c.endpoint(path)
			if task.URL == absolute || task.URL == "/v1"+path {
				task.ContentPath, task.URL = path, ""
				break
			}
		}
	}
	if task.URL == "" && task.Done() {
		if task.ContentPath == "" {
			task.ContentPath = "/videos/" + url.PathEscape(id) + "/content"
		}
	}
	return task, nil
}

// LegacyVideoContent downloads a finished video from the task content endpoint.
// The gateway may answer with a redirect to object storage; only this GET
// follows redirects through storageClient so credentials never leave the gateway.
func (c *MediaClient) LegacyVideoContent(ctx context.Context, path string, limit int64) ([]byte, string, error) {
	req, err := c.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Del(MediaProtocolHeader)
	data, header, err := c.sendWith(c.storageClient("视频结果重定向次数过多"), req, limit)
	return data, header.Get("Content-Type"), err
}

func legacyVideoResultURL(state map[string]any, depth int) string {
	if depth > 5 {
		return ""
	}
	for _, key := range []string{"data", "result", "video", "output", "metadata"} {
		if nested, ok := state[key].(map[string]any); ok {
			if link := legacyVideoResultURL(nested, depth+1); link != "" {
				return link
			}
		}
	}
	for _, key := range []string{"video_url", "videoUrl", "url", "result_url", "resultUrl"} {
		if link, ok := state[key].(string); ok && (strings.HasPrefix(link, "https://") || strings.HasPrefix(link, "http://") || strings.HasPrefix(link, "/v1/")) {
			return link
		}
	}
	return ""
}
