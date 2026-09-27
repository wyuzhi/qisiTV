package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"qisitv/backend/internal/mcp"
)

const (
	mcpToolListModels  = "qisitv_list_models"
	mcpToolSubmitMedia = "qisitv_submit_media"
	mcpToolGetTask     = "qisitv_get_task"
)

func (s *Service) MCPSession() *mcp.Session {
	if s == nil {
		return nil
	}
	s.mcpOnce.Do(func() {
		session := mcp.NewSession()
		s.registerMCPTools(session)
		_, _ = session.Initialize()
		s.mcpSession = session
	})
	return s.mcpSession
}

func (s *Service) registerMCPTools(session *mcp.Session) {
	session.Register(mcp.Tool{
		Name: mcpToolListModels, Description: "读取当前可用的生成模型目录与能力。",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{"userId": map[string]any{"type": "string"}, "canvasId": map[string]any{"type": "string"}, "mode": map[string]any{"type": "string"}, "referenceNodeIds": map[string]any{"type": "array"}}},
		Handle:      s.mcpListModels,
	})
	session.Register(mcp.Tool{
		Name: mcpToolSubmitMedia, Description: "在已批准的媒体生成准入之后提交本地生成任务，返回 taskId 与结果引用。",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{"userId": map[string]any{"type": "string"}, "runId": map[string]any{"type": "string"}, "callId": map[string]any{"type": "string"}}, "required": []string{"userId", "runId"}},
		Handle:      s.mcpSubmitMedia,
	})
	session.Register(mcp.Tool{
		Name: mcpToolGetTask, Description: "读取生成任务状态和本地结果引用。",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{"userId": map[string]any{"type": "string"}, "taskId": map[string]any{"type": "string"}}, "required": []string{"userId", "taskId"}},
		Handle:      s.mcpGetTask,
	})
}

func (s *Service) mcpListModels(raw json.RawMessage) (any, error) {
	var args struct {
		UserID           string   `json:"userId"`
		CanvasID         string   `json:"canvasId"`
		Mode             string   `json:"mode"`
		ReferenceNodeIDs []string `json:"referenceNodeIds"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, BadAuthRequest("模型查询参数无效")
		}
	}
	var catalog any
	var intent *ModelRequestIntent
	var err error
	if args.UserID != "" && args.CanvasID != "" && (args.Mode != "" || len(args.ReferenceNodeIDs) > 0) {
		body, _ := json.Marshal(map[string]any{"mode": args.Mode, "referenceNodeIds": args.ReferenceNodeIDs})
		var intentErr error
		intent, intentErr = s.cloudAgentModelIntent(args.UserID, args.CanvasID, string(body))
		if intentErr != nil {
			return nil, intentErr
		}
		catalog, err = s.cloudAgentModelList(intent)
	} else {
		catalog, err = s.cloudAgentModelList(nil)
	}
	if err != nil {
		return nil, err
	}
	return catalog, nil
}

func (s *Service) appendLocalBeefAPIModels(catalog any, intent *ModelRequestIntent) any {
	payload, _ := catalog.(map[string]any)
	if payload == nil {
		payload = map[string]any{"models": []map[string]any{}}
	}
	models := coerceCatalogModels(payload["models"])
	seen := map[string]bool{}
	for _, item := range models {
		if name := catalogModelName(item); name != "" {
			seen[name] = true
		}
		if selection, _ := item["selection"].(map[string]any); selection != nil {
			seen[strings.TrimSpace(stringValue(selection["channelId"]))+"::"+strings.TrimSpace(stringValue(selection["channelModelKey"]))] = true
		}
	}
	for _, item := range s.localChannelModelListItems(intent) {
		selection, _ := item["selection"].(map[string]any)
		key := strings.TrimSpace(stringValue(selection["channelId"])) + "::" + strings.TrimSpace(stringValue(selection["channelModelKey"]))
		name := catalogModelName(item)
		if seen[key] || (name != "" && seen[name] && selection != nil && stringValue(selection["channelId"]) == "") {
			continue
		}
		seen[key] = true
		models = append(models, item)
	}
	payload["models"] = models
	return payload
}

func (s *Service) mcpSubmitMedia(raw json.RawMessage) (any, error) {
	var args struct {
		UserID    string          `json:"userId"`
		RunID     string          `json:"runId"`
		CallID    string          `json:"callId"`
		Approved  bool            `json:"approved"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return nil, BadAuthRequest("媒体提交参数无效")
	}
	_ = args.Approved
	if strings.TrimSpace(args.UserID) == "" || strings.TrimSpace(args.RunID) == "" {
		return nil, BadAuthRequest("缺少运行标识")
	}
	run, err := s.repo.CloudAgent(args.UserID, args.RunID)
	if err != nil {
		return nil, BadAuthRequest("未找到可执行的媒体审批")
	}
	state, err := cloudAgentDecode(run)
	if err != nil {
		return nil, err
	}
	if state.Approval == nil || state.Approval.Decision != "approve" {
		return nil, Forbidden("媒体生成尚未批准")
	}
	call := state.Approval.Call
	if args.CallID != "" && call.ID != "" && args.CallID != call.ID {
		return nil, Forbidden("审批内容与待执行操作不一致")
	}
	if state.Approval.CallHash != "" && state.Approval.CallHash != cloudAgentApprovalCallHash(call) {
		return nil, Forbidden("审批内容与待执行操作不一致")
	}
	if len(args.Arguments) > 0 && strings.TrimSpace(string(args.Arguments)) != "" && string(args.Arguments) != "null" {
		caller := call
		caller.Function.Arguments = string(args.Arguments)
		if cloudAgentApprovalCallHash(caller) != cloudAgentApprovalCallHash(call) {
			return nil, Forbidden("不能替换已批准的生成参数")
		}
	}
	admissionID := cloudAgentMediaExecutionID(run.UserID, run.ID, call.ID)
	if existing, err := s.repo.TaskForUser(run.UserID, admissionID); err == nil && existing != nil {
		return map[string]any{"taskId": existing.ID, "status": existing.Status, "duplicate": true}, nil
	}
	req, plan, err := s.prepareCloudAgentMedia(run, &state, call)
	if err != nil {
		return nil, err
	}
	req.admission = &taskAdmission{ID: admissionID}
	if err := s.enqueueCloudAgentTask(run, &state, req, plan); err != nil {
		return nil, err
	}
	latest, err := s.repo.CloudAgent(run.UserID, run.ID)
	if err != nil {
		return nil, err
	}
	fresh, err := cloudAgentDecode(latest)
	if err != nil {
		return nil, err
	}
	return map[string]any{"taskId": fresh.MediaTaskID, "nodeId": plan.Args.NodeID, "status": "queued"}, nil
}

func (s *Service) mcpGetTask(raw json.RawMessage) (any, error) {
	var args struct {
		UserID string `json:"userId"`
		TaskID string `json:"taskId"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return nil, BadAuthRequest("任务查询参数无效")
	}
	task, err := s.Task(args.UserID, args.TaskID)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"taskId": task.ID, "status": task.Status, "progress": task.Progress,
		"result": publicTaskResultRefs(task.ResultJSON),
	}, nil
}

func publicTaskResultRefs(raw string) any {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var payload map[string]any
	if json.Unmarshal([]byte(raw), &payload) != nil {
		return nil
	}
	refs := map[string]any{}
	for _, key := range []string{"resourceId", "storageKey", "url", "previewUrl", "posterUrl", "assetId"} {
		if value, ok := payload[key]; ok {
			refs[key] = value
		}
	}
	return refs
}

func cloudAgentMediaExecutionID(userID, runID, callID string) string {
	return cloudAgentID(userID, fmt.Sprintf("%s:mcp-media:%s", runID, callID))
}

func (s *Service) callMCPTool(name string, arguments any) (mcp.ToolResult, error) {
	session := s.MCPSession()
	if session == nil {
		return mcp.ToolResult{}, errors.New("本地 MCP 会话不可用")
	}
	return session.CallTool(name, arguments)
}
