package app

import (
	"encoding/json"
	"reflect"
	"testing"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/operations"
)

func externalGenerationFixture(t *testing.T) (*Service, *operations.Registry, string, int64) {
	t.Helper()
	svc, canvasID, _ := newAssistantTurnService(t)
	sqlDB, _ := svc.Database().DB()
	sqlDB.SetMaxOpenConns(1)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::qwen-image-2.1","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["qwen-image-2.1"],"modelProfiles":[{"model":"qwen-image-2.1","capability":"image","protocol":"openai-image"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"] = []any{
		map[string]any{"id": "image", "type": "image", "metadata": map[string]any{"prompt": "A wooden tray", "size": "1:1", "count": 1}},
		map[string]any{"id": "image-2", "type": "image", "metadata": map[string]any{"prompt": "A glass of water", "size": "1:1", "count": 1}},
	}
	doc["connections"] = []any{}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	r := operations.NewRegistry(svc, operations.NewStore(svc.Database()))
	operations.RegisterDefaultOps(r)
	return svc, r, canvasID, canvasRevisionOf(t, svc, canvasID)
}

func externalGenerationRequest(canvasID string, revision int64, operationID string) operations.Request {
	raw, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeIds": []string{"image", "image-2"}, "expectedRevision": revision, "expectedModelConfigRevision": 1})
	return operations.Request{Op: "canvas.generation.submit", OpID: operationID, UserID: "local", Caller: operations.ExternalCaller(false), Params: raw}
}

func TestExternalGenerationSubmitsAndReplaysWithoutAssistantTurn(t *testing.T) {
	svc, r, canvasID, revision := externalGenerationFixture(t)
	req := externalGenerationRequest(canvasID, revision, "external-confirmed-1")
	first, err := r.Execute(req)
	if err != nil {
		t.Fatal(err)
	}
	second, err := r.Execute(req)
	if err != nil || !second.Replayed || !reflect.DeepEqual(first.Result, second.Result) {
		t.Fatalf("replay = %+v, %v", second, err)
	}
	var tasks []model.Task
	if err := svc.Database().Find(&tasks).Error; err != nil || len(tasks) != 2 {
		t.Fatalf("tasks = %d, %v", len(tasks), err)
	}
	for _, task := range tasks {
		var input struct {
			Config struct {
				Model string `json:"model"`
			} `json:"config"`
		}
		if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
			t.Fatal(err)
		}
		if task.Status != model.TaskStatusQueued || task.ProjectID != canvasID || input.Config.Model != "qwen-image-2.1" {
			t.Fatalf("unexpected admitted task: %s, %s, %s", task.Status, task.ProjectID, input.Config.Model)
		}
	}
	var turns int64
	svc.Database().Model(&model.AssistantTurn{}).Count(&turns)
	if turns != 0 {
		t.Fatal("external submission invented an assistant turn")
	}
	// A new key must not purchase another generation while the original node has a task.
	duplicate := externalGenerationRequest(canvasID, first.Revision, "external-confirmed-2")
	if _, err := r.Execute(duplicate); err == nil {
		t.Fatal("duplicate target accepted")
	}
	// Old read-only credentials may not replay a write receipt.
	req.Caller = operations.ExternalCaller(true)
	if _, err := r.Execute(req); err == nil {
		t.Fatal("read-only replay accepted")
	}
}

func TestExternalGenerationValidationAndAtomicAdmission(t *testing.T) {
	svc, r, canvasID, revision := externalGenerationFixture(t)
	for _, tc := range []struct {
		name   string
		mutate func(*operations.Request)
	}{
		{"stale canvas", func(r *operations.Request) { r.Params = externalGenerationRequest(canvasID, revision-1, "").Params }},
		{"missing revision", func(r *operations.Request) {
			r.Params = json.RawMessage(`{"canvasId":"` + canvasID + `","nodeIds":["image"]}`)
		}},
		{"stale model config", func(r *operations.Request) {
			var params map[string]any
			_ = json.Unmarshal(r.Params, &params)
			params["expectedModelConfigRevision"] = 0
			r.Params, _ = json.Marshal(params)
		}},
		{"other user", func(r *operations.Request) { r.UserID = "another-user" }},
		{"manual cannot impersonate external", func(r *operations.Request) { r.Caller = operations.ManualCaller(false) }},
		{"read-only", func(r *operations.Request) { r.Caller = operations.ExternalCaller(true) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := externalGenerationRequest(canvasID, revision, tc.name)
			tc.mutate(&req)
			if _, err := r.Execute(req); err == nil {
				t.Fatal("invalid admission accepted")
			}
		})
	}
	if err := svc.Database().Exec("CREATE TRIGGER fail_external_batch BEFORE INSERT ON tasks WHEN NEW.prompt = 'A glass of water' BEGIN SELECT RAISE(ABORT, 'fixture second admission failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	req := externalGenerationRequest(canvasID, revision, "atomic-external")
	if _, err := r.Execute(req); err == nil {
		t.Fatal("second admission failure accepted")
	}
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 0 || canvasRevisionOf(t, svc, canvasID) != revision {
		t.Fatal("failed batch left a task or canvas mutation", count)
	}
	if err := svc.Database().Exec("DROP TRIGGER fail_external_batch").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := r.Execute(req); err != nil {
		t.Fatal("rolled-back batch could not retry same key", err)
	}
}

func TestGenerationOrderModesAskCallerAutoAndUnifiedApprove(t *testing.T) {
	svc, r, canvasID, revision := externalGenerationFixture(t)

	// 1. ask 模式：外部客户端开单后不能自己 submit，需由 owner 批准执行。
	askCaller := operations.Caller{
		Kind:         operations.CallerExternal,
		ClientID:     "client-ask",
		ClientLabel:  "claude-ask",
		ApprovalMode: operations.ApprovalModeAsk,
	}
	proposeParams, _ := json.Marshal(map[string]any{
		"canvasId": canvasID,
		"nodeIds":  []string{"image"},
		"kind":     "image",
		"note":     "ask mode test",
	})
	proposed, err := r.Execute(operations.Request{
		Op:     "canvas.generation.propose",
		UserID: "local",
		Caller: askCaller,
		Params: proposeParams,
	})
	if err != nil {
		t.Fatal(err)
	}
	propMap := proposed.Result.(map[string]any)
	proposalID, _ := propMap["proposalId"].(string)
	if proposalID == "" || propMap["approvalMode"] != "ask" || propMap["status"] != "pending" {
		t.Fatalf("unexpected ask proposal: %+v", propMap)
	}

	submitParams, _ := json.Marshal(map[string]any{
		"canvasId":                    canvasID,
		"proposalId":                  proposalID,
		"nodeIds":                     []string{"image"},
		"expectedRevision":            revision,
		"expectedModelConfigRevision": 1,
	})
	if _, err := r.Execute(operations.Request{
		Op:     "canvas.generation.submit",
		OpID:   "submit-ask-self",
		UserID: "local",
		Caller: askCaller,
		Params: submitParams,
	}); err == nil || operations.AsError(err).Reason != "generation_approval_required" {
		t.Fatalf("ask caller must not self-submit: %v", err)
	}

	approved, err := svc.ApproveGenerationOrder("local", proposalID, "owner")
	if err != nil {
		t.Fatal(err)
	}
	appMap := approved.(map[string]any)
	orderVal, _ := appMap["order"].(*operations.GenerationOrder)
	if orderVal == nil || orderVal.Status != operations.GenerationOrderSubmitted || orderVal.ApprovedBy != "owner" || len(orderVal.TaskIDs) != 1 {
		t.Fatalf("unexpected approved order: %+v", appMap)
	}
	// 再次批准同一单应幂等返回，不重复建任务。
	approvedAgain, err := svc.ApproveGenerationOrder("local", proposalID, "owner")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(approvedAgain.(map[string]any)["taskIds"], appMap["taskIds"]) {
		t.Fatalf("idempotent approve taskIds mismatch: %+v vs %+v", approvedAgain, appMap)
	}

	// 2. auto 模式（脚本）：一步提交自动生成并落生成单，无需先 propose 或传 expectedRevision。
	autoCaller := operations.Caller{
		Kind:         operations.CallerExternal,
		ClientID:     "client-auto",
		ClientLabel:  "batch-script",
		ApprovalMode: operations.ApprovalModeAuto,
	}
	autoParams, _ := json.Marshal(map[string]any{
		"canvasId": canvasID,
		"nodeIds":  []string{"image-2"},
		"kind":     "image",
	})
	autoRes, err := r.Execute(operations.Request{
		Op:     "canvas.generation.submit",
		OpID:   "submit-auto-1",
		UserID: "local",
		Caller: autoCaller,
		Params: autoParams,
	})
	if err != nil {
		t.Fatal(err)
	}
	autoMap := autoRes.Result.(map[string]any)
	autoOrderID, _ := autoMap["orderId"].(string)
	if autoOrderID == "" || autoMap["approvalMode"] != "auto" {
		t.Fatalf("unexpected auto submit result: %+v", autoMap)
	}
	orders, err := svc.ListGenerationOrders("local", canvasID)
	if err != nil || len(orders) != 2 {
		t.Fatalf("expected 2 generation orders, got %d (%v)", len(orders), err)
	}
}

func TestConfirmAssistantProductionHandlesOrdinarySingleBatchProposal(t *testing.T) {
	svc, r, canvasID, _ := externalGenerationFixture(t)
	const turnID = "bbaa112233445566"
	if _, err := svc.BeginAssistantTurn("local", canvasID, turnID, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	proposeParams, _ := json.Marshal(map[string]any{
		"canvasId": canvasID,
		"nodeIds":  []string{"image"},
		"kind":     "image",
	})
	proposed, err := r.Execute(operations.Request{
		Op:     "canvas.generation.propose",
		UserID: "local",
		TurnID: turnID,
		Caller: operations.ManualCaller(false),
		Params: proposeParams,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.FinalizeAssistantTurn(turnID); err != nil {
		t.Fatal(err)
	}
	proposalID, _ := proposed.Result.(map[string]any)["proposalId"].(string)
	if proposalID == "" {
		t.Fatalf("missing proposalId: %+v", proposed.Result)
	}
	confirmed, err := svc.ConfirmAssistantProduction("local", turnID, AssistantProductionConfirmation{
		CanvasID:   canvasID,
		ProposalID: proposalID,
		Kind:       "image",
		NodeIDs:    []string{"image"},
	})
	if err != nil {
		t.Fatal(err)
	}
	confMap := confirmed.(map[string]any)
	taskIDs, _ := confMap["taskIds"].([]string)
	contID, _ := confMap["continuationId"].(string)
	if len(taskIDs) != 1 || contID != "" {
		t.Fatalf("ordinary proposal should create 1 task without continuation, got %+v", confMap)
	}
	orders, err := svc.ListGenerationOrders("local", canvasID)
	if err != nil || len(orders) != 1 || orders[0].Status != operations.GenerationOrderSubmitted || orders[0].ApprovedBy != "ui" {
		t.Fatalf("expected submitted generation order approved by ui, got %+v (%v)", orders, err)
	}
}
