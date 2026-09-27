package app

import (
	"encoding/json"
	"strings"
	"testing"

	"gorm.io/gorm"
	"qisitv/backend/internal/mcp"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
)

func TestLocalMCPSessionExposesBoundedTools(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	session := s.MCPSession()
	tools, err := session.ListTools()
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, tool := range tools {
		name, _ := tool["name"].(string)
		got[name] = true
	}
	for _, name := range []string{mcpToolListModels, mcpToolSubmitMedia, mcpToolGetTask} {
		if !got[name] {
			t.Fatalf("missing tool %s in %#v", name, got)
		}
	}
}

func TestMCPListModelsIncludesEnterpriseSelectionAndFiltersMode(t *testing.T) {
	s, _, _ := beefAPIImageAgentFixture(t)
	listed, err := s.callMCPTool(mcpToolListModels, map[string]any{})
	if err != nil || listed.IsError {
		t.Fatalf("list models: %#v err=%v", listed, err)
	}
	names := mcpModelNames(t, listed)
	if !names["企业图片"] && !names["enterprise-image"] {
		t.Fatalf("enterprise image missing from MCP catalog: %v", names)
	}
	if !names["seedance-test"] && !names["视频测试"] {
		t.Fatalf("local video model missing from unfiltered catalog: %v", names)
	}
	filtered, err := s.callMCPTool(mcpToolListModels, map[string]any{
		"userId": "user", "canvasId": "agent-canvas", "mode": "image",
	})
	if err != nil || filtered.IsError {
		t.Fatalf("filtered list: %#v err=%v", filtered, err)
	}
	filteredNames := mcpModelNames(t, filtered)
	if !filteredNames["企业图片"] && !filteredNames["enterprise-image"] {
		t.Fatalf("image intent dropped enterprise model: %v", filteredNames)
	}
	if filteredNames["seedance-test"] || filteredNames["视频测试"] {
		t.Fatalf("image intent kept video model: %v", filteredNames)
	}
}

func TestMCPSubmitMediaRejectedOrUnapprovedCreatesNoTask(t *testing.T) {
	s, db, a := beefAPIImageAgentFixture(t)
	run, state := agentMediaRun(t, s, a, "request_approval")
	if err := s.advanceCloudAgentTool(run, &state); err != nil {
		t.Fatal(err)
	}
	waiting, err := s.CloudAgentRun("user", run.ID)
	if err != nil || waiting.Approval == nil {
		t.Fatalf("missing approval: %v", err)
	}
	unapproved, err := s.callMCPTool(mcpToolSubmitMedia, map[string]any{
		"userId": "user", "runId": run.ID, "callId": "media-call", "approved": true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !unapproved.IsError || !strings.Contains(mustEncodeMCP(t, unapproved), "尚未批准") {
		t.Fatalf("unapproved submit: %#v", unapproved)
	}
	if countCanvasImageTasks(t, db) != 0 {
		t.Fatal("unapproved submit persisted a generation task")
	}
	if err := s.DecideCloudAgentApproval("user", run.ID, waiting.Approval.ID, "reject", "不要生成"); err != nil {
		t.Fatal(err)
	}
	denied, err := s.callMCPTool(mcpToolSubmitMedia, map[string]any{
		"userId": "user", "runId": run.ID, "callId": "media-call",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !denied.IsError {
		t.Fatalf("rejected submit succeeded: %#v", denied)
	}
	if countCanvasImageTasks(t, db) != 0 {
		t.Fatal("rejected approval persisted a generation task")
	}
}

func TestMCPSubmitMediaRejectsModifiedFrozenArguments(t *testing.T) {
	s, db, a := beefAPIImageAgentFixture(t)
	run, state := agentMediaRun(t, s, a, "request_approval")
	if err := s.advanceCloudAgentTool(run, &state); err != nil {
		t.Fatal(err)
	}
	waiting, err := s.CloudAgentRun("user", run.ID)
	if err != nil || waiting.Approval == nil {
		t.Fatalf("missing approval: %v", err)
	}
	if err := s.DecideCloudAgentApproval("user", run.ID, waiting.Approval.ID, "approve", ""); err != nil {
		t.Fatal(err)
	}
	tampered := map[string]any{}
	if err := json.Unmarshal([]byte(waiting.Approval.Call.Function.Arguments), &tampered); err != nil {
		t.Fatal(err)
	}
	tampered["prompt"] = "替换已批准的提示词"
	result, err := s.callMCPTool(mcpToolSubmitMedia, map[string]any{
		"userId": "user", "runId": run.ID, "callId": waiting.Approval.Call.ID, "arguments": tampered,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.IsError || !strings.Contains(mustEncodeMCP(t, result), "不能替换已批准的生成参数") {
		t.Fatalf("modified arguments accepted: %#v", result)
	}
	if countCanvasImageTasks(t, db) != 0 {
		t.Fatal("modified arguments persisted a generation task")
	}
}

func TestMCPApprovedFrozenArgsPersistOneTaskAcrossDuplicateAndRestart(t *testing.T) {
	s, db, a := beefAPIImageAgentFixture(t)
	run, state := agentMediaRun(t, s, a, "request_approval")
	if err := s.advanceCloudAgentTool(run, &state); err != nil {
		t.Fatal(err)
	}
	waiting, err := s.CloudAgentRun("user", run.ID)
	if err != nil || waiting.Approval == nil {
		t.Fatalf("missing approval: %v", err)
	}
	if err := s.DecideCloudAgentApproval("user", run.ID, waiting.Approval.ID, "approve", ""); err != nil {
		t.Fatal(err)
	}
	frozen := json.RawMessage(waiting.Approval.Call.Function.Arguments)
	first, err := s.callMCPTool(mcpToolSubmitMedia, map[string]any{
		"userId": "user", "runId": run.ID, "callId": waiting.Approval.Call.ID, "arguments": frozen,
	})
	if err != nil || first.IsError {
		t.Fatalf("approved submit: %#v err=%v", first, err)
	}
	payload := mcpObject(t, first)
	taskID, _ := payload["taskId"].(string)
	if taskID == "" {
		t.Fatalf("missing task id: %#v", payload)
	}
	if countCanvasImageTasks(t, db) != 1 {
		t.Fatalf("expected one persisted image task, got %d", countCanvasImageTasks(t, db))
	}
	rawTask, err := s.repo.TaskForUser("user", taskID)
	if err != nil {
		t.Fatal(err)
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(rawTask.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	config, _ := input["config"].(map[string]any)
	if stringValue(config["interfaceType"]) != "openai-image" || stringValue(config["credentialRef"]) != managedBeefAPIRef {
		t.Fatalf("managed provider config not resolved: %#v", config)
	}
	if strings.Contains(rawTask.InputJSON, "ent-secret") {
		t.Fatal("persisted task kept plaintext enterprise key")
	}
	if err := db.Model(&model.Task{}).Where("id = ?", taskID).Update("result_json", `{"apiKey":"ent-secret","secretKey":"ent-secret","baseUrl":"https://enterprise.beefapi.com","resourceId":"out-1"}`).Error; err != nil {
		t.Fatal(err)
	}
	duplicate, err := s.callMCPTool(mcpToolSubmitMedia, map[string]any{
		"userId": "user", "runId": run.ID, "callId": waiting.Approval.Call.ID, "arguments": json.RawMessage(waiting.Approval.Call.Function.Arguments),
	})
	if err != nil || duplicate.IsError {
		t.Fatalf("duplicate submit: %#v err=%v", duplicate, err)
	}
	if mcpObject(t, duplicate)["taskId"] != taskID {
		t.Fatalf("duplicate identity drifted: %#v", duplicate)
	}
	if countCanvasImageTasks(t, db) != 1 {
		t.Fatal("duplicate submit created another task")
	}
	restarted := &Service{repo: repository.New(db), dataDir: s.dataDir, mode: serviceModeLocal}
	again, err := restarted.callMCPTool(mcpToolSubmitMedia, map[string]any{
		"userId": "user", "runId": run.ID, "callId": waiting.Approval.Call.ID, "arguments": json.RawMessage(waiting.Approval.Call.Function.Arguments),
	})
	if err != nil || again.IsError {
		t.Fatalf("restart submit: %#v err=%v", again, err)
	}
	if mcpObject(t, again)["taskId"] != taskID || countCanvasImageTasks(t, db) != 1 {
		t.Fatalf("restart created a new task: %#v count=%d", again, countCanvasImageTasks(t, db))
	}
	got, err := restarted.callMCPTool(mcpToolGetTask, map[string]any{"userId": "user", "taskId": taskID})
	if err != nil || got.IsError {
		t.Fatalf("get task: %#v err=%v", got, err)
	}
	raw := mustEncodeMCP(t, got)
	if strings.Contains(raw, "ent-secret") || strings.Contains(raw, "apiKey") || strings.Contains(raw, "secretKey") || strings.Contains(raw, "baseUrl") {
		t.Fatalf("task result leaked credential fields: %s", raw)
	}
	result := mcpObject(t, got)["result"]
	refs, _ := result.(map[string]any)
	if stringValue(refs["resourceId"]) != "out-1" {
		t.Fatalf("public result refs missing: %#v", got)
	}
}

func beefAPIImageAgentFixture(t *testing.T) (*Service, *gorm.DB, cloudAgentMediaArgs) {
	t.Helper()
	s, db, a := agentMediaFixture(t)
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","baseUrl":"https://enterprise.beefapi.com","apiKey":"ent-secret","enabled":true,"models":["enterprise-image","seedance-test"],"modelProfiles":[{"model":"enterprise-image","displayName":"企业图片","capability":"image","protocol":"openai-image"},{"model":"seedance-test","displayName":"视频测试","capability":"video","protocol":"openai-videos"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	image := cloudAgentMediaArgs{
		Mode: "image", Prompt: "画一只猫", ChannelID: "beefapi", ChannelModelKey: "enterprise-image",
		Size: "1:1", SnapshotHash: a.SnapshotHash, NodeID: "enterprise-image-1", Title: "企业图片",
	}
	canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		t.Fatal(err)
	}
	image.SnapshotHash = creationHash(doc)
	return s, db, image
}

func countCanvasImageTasks(t *testing.T, db *gorm.DB) int64 {
	t.Helper()
	var count int64
	if err := db.Model(&model.Task{}).Where("type = ?", "canvas_image").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	return count
}

func mcpObject(t *testing.T, result mcp.ToolResult) map[string]any {
	t.Helper()
	raw, err := json.Marshal(result.Data)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) == "null" || len(raw) == 0 {
		if err := json.Unmarshal([]byte(mustEncodeMCP(t, result)), &result.Data); err != nil {
			t.Fatalf("mcp payload %q: %v", mustEncodeMCP(t, result), err)
		}
		raw, _ = json.Marshal(result.Data)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("mcp payload %s: %v", raw, err)
	}
	return payload
}

func mcpModelNames(t *testing.T, result mcp.ToolResult) map[string]bool {
	t.Helper()
	payload := mcpObject(t, result)
	found := map[string]bool{}
	models, _ := payload["models"].([]any)
	for _, raw := range models {
		item, _ := raw.(map[string]any)
		found[stringValue(item["name"])] = true
	}
	return found
}

func mustEncodeMCP(t *testing.T, result mcp.ToolResult) string {
	t.Helper()
	if len(result.Content) == 0 {
		raw, _ := json.Marshal(result)
		return string(raw)
	}
	text, _ := result.Content[0]["text"].(string)
	return text
}
