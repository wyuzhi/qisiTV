package generation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// BeefAPIVideoSettlement holds the raw billing/settlement fields returned by
// BeefAPI video task endpoints (GET /v1/video/generations/{id} or /v1/videos/{id}).
type BeefAPIVideoSettlement struct {
	UsageState        *string
	ReconcileDeadline *string
}

// ExtractBeefAPIVideoSettlement extracts BeefAPI's raw usage_state and
// reconcile_deadline from a video task response map (including nested data).
func ExtractBeefAPIVideoSettlement(state map[string]interface{}) BeefAPIVideoSettlement {
	var out BeefAPIVideoSettlement
	curr := state
	for curr != nil {
		if out.UsageState == nil {
			if raw, exists := curr["usage_state"]; exists && raw != nil {
				if v, ok := raw.(string); ok {
					trimmed := strings.TrimSpace(v)
					out.UsageState = &trimmed
				}
			}
		}
		if out.ReconcileDeadline == nil {
			if raw, exists := curr["reconcile_deadline"]; exists && raw != nil {
				if v, ok := raw.(string); ok {
					trimmed := strings.TrimSpace(v)
					out.ReconcileDeadline = &trimmed
				}
			}
		}
		nested, ok := curr["data"].(map[string]interface{})
		if !ok {
			break
		}
		curr = nested
	}
	return out
}

// ExtractBeefAPIVideoSettlementBytes parses a JSON response body and extracts
// BeefAPI's raw usage_state and reconcile_deadline if present.
func ExtractBeefAPIVideoSettlementBytes(body []byte) BeefAPIVideoSettlement {
	if len(body) == 0 {
		return BeefAPIVideoSettlement{}
	}
	var state map[string]interface{}
	if err := json.Unmarshal(body, &state); err != nil {
		return BeefAPIVideoSettlement{}
	}
	return ExtractBeefAPIVideoSettlement(state)
}

// ValidateVideoTaskState checks every task envelope before exposing its result.
// Providers without a task ID in their status reply remain supported.
func ValidateVideoTaskState(taskID string, state map[string]interface{}) (map[string]interface{}, error) {
	for {
		for _, field := range []string{"id", "task_id", "taskId"} {
			id, err := firstJSONString(state, field)
			if err != nil || (id != "" && id != strings.TrimSpace(taskID)) {
				return nil, errors.New("上游返回的任务 ID 与原视频任务不一致")
			}
		}
		nested, ok := state["data"].(map[string]interface{})
		if !ok {
			return state, nil
		}
		state = nested
	}
}

func VideoTaskSucceeded(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "succeeded", "success", "done":
		return true
	default:
		return false
	}
}

// QueryHandwrittenVideoTask reads an existing legacy task only. The caller must
// not route an explicitly configured but unavailable plugin through this path.
func QueryHandwrittenVideoTask(ctx context.Context, input Input, taskID string) (map[string]interface{}, string, error) {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return nil, "", errors.New("该任务没有可恢复的上游任务 ID")
	}
	if strings.TrimSpace(input.Config.InterfaceType) != "" {
		_, official := OfficialDeclarativeVideoInterface(input.Config.InterfaceType)
		if official || !IsArkPlanVideoConfig(input.Config) {
			return nil, "", errors.New("该任务的请求协议不支持安全查询上游状态")
		}
	}
	path := "/videos/" + url.PathEscape(taskID)
	if IsArkPlanVideoConfig(input.Config) {
		path = "/contents/generations/tasks/" + url.PathEscape(taskID)
	}
	query := func(ctx context.Context) (VideoResultSource, string, error) {
		var state map[string]interface{}
		if err := GetJSON(WithRequestKind(ctx, "poll"), input.Config, path, &state); err != nil {
			return VideoResultSource{}, "", err
		}
		var err error
		state, err = ValidateVideoTaskState(taskID, state)
		if err != nil {
			return VideoResultSource{}, "", err
		}
		status, rawURL := SeedancePollStatusAndURL(state)
		status = strings.TrimSpace(status)
		if IsArkPlanVideoConfig(input.Config) {
			status = strings.ToLower(strings.TrimSpace(stringField(state, "status")))
			content, _ := state["content"].(map[string]interface{})
			rawURL = stringField(content, "video_url")
		} else if rawURL == "" {
			rawURL = NewAPIVideoResultURL(state)
		}
		if status == "failed" || status == "cancelled" || status == "expired" {
			return VideoResultSource{}, status, errors.New(defaultString(SeedanceErrorMessage(state), "原视频任务未成功，无法取回结果"))
		}
		if !VideoTaskSucceeded(status) {
			return VideoResultSource{}, status, nil
		}
		if rawURL == "" && !IsArkPlanVideoConfig(input.Config) {
			rawURL = APIURL(input.Config.BaseURL, path+"/content")
		}
		rawURL, err = videoResultURL(status, rawURL)
		return videoURLSource(input.Config, rawURL), status, err
	}
	source, status, err := query(ctx)
	if err != nil || source.Read == nil {
		return nil, status, err
	}
	renew := func(ctx context.Context) (VideoResultSource, error) {
		fresh, stage, err := query(ctx)
		if err == nil && fresh.Read == nil {
			_, err = videoResultURL(stage, "")
		}
		return fresh, err
	}
	policy := videoPollPolicyForConfig(ctx, input.Config, DefaultVideoPollPolicy())
	data, mimeType, err := RunVideoDownload(ctx, taskID, policy, VideoResultDownloader(input.Config, taskID, source, renew))
	if err != nil {
		return nil, status, fmt.Errorf("视频结果下载失败（原任务 %s）：%w", taskID, err)
	}
	mimeType = NormalizedMediaMIMEType(mimeType, data)
	return map[string]interface{}{"mode": "video", "video": map[string]interface{}{"dataUrl": DataURL(mimeType, data), "mimeType": mimeType}}, status, nil
}
