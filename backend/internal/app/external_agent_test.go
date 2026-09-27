package app

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/database"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
)

func externalAgentFixture(t *testing.T) (*Service, *gorm.DB, string) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "agent.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err = database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	svc := NewLocal(repository.New(db), t.TempDir())
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	if err = svc.SaveLocalModelConfig([]byte(`{"channels":[{"id":"test-channel","baseUrl":"https://api.example.invalid/v1","apiKey":"do-not-return-this-secret","enabled":true,"models":["test-image","test-text"],"modelProfiles":[{"model":"test-image","protocol":"openai-image","capability":"image","defaultOptions":{"kwargs":{"web_search":true}}},{"model":"test-text","protocol":"openai-chat","capability":"text"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.UpsertUserCanvasProject(owner.ID, json.RawMessage(`{"id":"canvas","title":"test","revision":0,"nodes":[],"connections":[]}`)); err != nil {
		t.Fatal(err)
	}
	return svc, db, owner.ID
}
func externalAgentRequest() ExternalAgentTaskRequest {
	return ExternalAgentTaskRequest{CanvasID: "canvas", Type: "image", Model: "test-image", Prompt: "A test image", IdempotencyKey: "one-authorized-image", Consent: ExternalAgentConsent{Approved: true, Scope: "User approved one test image within the stated budget"}}
}

func TestExternalAgentAdmissionAndAtomicPlaceholder(t *testing.T) {
	svc, db, userID := externalAgentFixture(t)
	models, err := svc.ExternalAgentModels()
	if err != nil || len(models) != 2 {
		t.Fatalf("models %v %v", models, err)
	}
	data, _ := json.Marshal(models)
	if strings.Contains(string(data), "do-not-return") {
		t.Fatal("catalog leaked secret")
	}
	req := externalAgentRequest()
	req.Consent.Approved = false
	if _, _, err = svc.SubmitExternalAgentTask(userID, req); err == nil {
		t.Fatal("missing consent accepted")
	}
	req = externalAgentRequest()
	req.Input = map[string]any{"options": map[string]any{"providerOptions": map[string]any{"apiKey": "injected"}}}
	if _, _, err = svc.SubmitExternalAgentTask(userID, req); err == nil {
		t.Fatal("credential injection accepted")
	}
	req = externalAgentRequest()
	task, nodeID, err := svc.SubmitExternalAgentTask(userID, req)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(task.InputJSON, "do-not-return") {
		t.Fatal("task response leaked secret")
	}
	stored, err := svc.repo.TaskForUser(userID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored.InputJSON, "do-not-return") {
		t.Fatal("task credentials persisted in cleartext")
	}
	if !strings.Contains(stored.InputJSON, `"openai-image":{"kwargs":{"web_search":true}}`) {
		t.Fatal("model profile defaults did not use the provider namespace")
	}
	raw, err := svc.UserCanvasProject(userID, "canvas")
	if err != nil || !strings.Contains(string(raw), task.ID) || !strings.Contains(string(raw), nodeID) {
		t.Fatalf("placeholder missing %s %v", raw, err)
	}
	again, againNode, err := svc.SubmitExternalAgentTask(userID, req)
	if err != nil || again.ID != task.ID || againNode != nodeID {
		t.Fatalf("idempotency failure %+v %v", again, err)
	}
	req.Prompt = "different paid request"
	if _, _, err = svc.SubmitExternalAgentTask(userID, req); err == nil {
		t.Fatal("idempotency key reused for different request")
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 1 {
		t.Fatalf("task count %d", count)
	}
}

func TestExternalAgentWritebackDurableMediaAndNoDuplicate(t *testing.T) {
	svc, db, userID := externalAgentFixture(t)
	task, nodeID, err := svc.SubmitExternalAgentTask(userID, externalAgentRequest())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	resource := model.Resource{ID: "generated", UserID: userID, Kind: "image", MimeType: "image/png", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "output.png", Width: 640, Height: 360, Size: 123, CreatedAt: now, UpdatedAt: now}
	if err = db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": `{"images":[{"storageKey":"resource:generated","url":"/api/resources/generated/file"},{"storageKey":"resource:generated"}]}`}).Error; err != nil {
		t.Fatal(err)
	}
	stale := int64(0)
	if _, err = svc.ApplyExternalAgentTask(userID, task.ID, ExternalAgentApplyRequest{BaseRevision: &stale}); err == nil {
		t.Fatal("stale revision accepted")
	}
	result, err := svc.ApplyExternalAgentTask(userID, task.ID, ExternalAgentApplyRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if result["nodeId"] != nodeID {
		t.Fatal("target changed")
	}
	if ids, ok := result["nodeIds"].([]string); !ok || len(ids) != 2 {
		t.Fatalf("multiple outputs missing: %+v", result["nodeIds"])
	}
	var assetCount int64
	if err = db.Model(&model.Asset{}).Count(&assetCount).Error; err != nil || assetCount != 1 {
		t.Fatalf("duplicate output resource created duplicate assets: %d %v", assetCount, err)
	}
	raw, err := svc.UserCanvasProject(userID, "canvas")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"storageKey":"resource:generated"`) || !strings.Contains(string(raw), `"assetId"`) {
		t.Fatalf("media unbound %s", raw)
	}
	if err = svc.validateCanvasMediaAssets(userID, raw); err != nil {
		t.Fatal(err)
	}
	result, err = svc.ApplyExternalAgentTask(userID, task.ID, ExternalAgentApplyRequest{})
	if err != nil || result["alreadyApplied"] != true {
		t.Fatalf("not idempotent %v %v", result, err)
	}
	after, _ := svc.UserCanvasProject(userID, "canvas")
	if string(after) != string(raw) {
		t.Fatal("repeat apply changed canvas")
	}
	if _, err = svc.ApplyExternalAgentTask(userID, task.ID, ExternalAgentApplyRequest{CanvasID: "other"}); err == nil {
		t.Fatal("cross-canvas apply accepted")
	}
	pending, err := svc.repo.PendingExternalAgentWritebacks(50)
	if err != nil || len(pending) != 0 {
		t.Fatalf("pending not cleared %v %v", pending, err)
	}
}

func TestExternalAgentWritebackFailureAndDeletedNode(t *testing.T) {
	svc, db, userID := externalAgentFixture(t)
	task, nodeID, err := svc.SubmitExternalAgentTask(userID, externalAgentRequest())
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusFailed, "error": "upstream rejected"}).Error; err != nil {
		t.Fatal(err)
	}
	svc.noteExternalAgentTask(*task)
	raw, _ := svc.UserCanvasProject(userID, "canvas")
	if !strings.Contains(string(raw), `"taskStatus":"failed"`) {
		t.Fatalf("failure not projected %s", raw)
	}
	if _, err = svc.DeleteUserCanvasNode(userID, "canvas", nodeID); err != nil {
		t.Fatal(err)
	}
	// Recovery must not resurrect a deliberately removed target.
	_, err = svc.ApplyExternalAgentTask(userID, task.ID, ExternalAgentApplyRequest{})
	if err != nil {
		var appErr *AppError
		if !errors.As(err, &appErr) {
			t.Fatal(err)
		}
	}
	raw, _ = svc.UserCanvasProject(userID, "canvas")
	if strings.Contains(string(raw), nodeID) {
		t.Fatal("deleted node resurrected")
	}
}

func TestExternalAgentManualConnectionsAndExplicitReferenceOverride(t *testing.T) {
	svc, db, userID := externalAgentFixture(t)
	sourceTask, sourceID, err := svc.SubmitExternalAgentTask(userID, externalAgentRequest())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err = db.Create(&model.Resource{ID: "reference", UserID: userID, Kind: "image", MimeType: "image/png", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "ref.png", Width: 640, Height: 360, Size: 123, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&model.Task{}).Where("id = ?", sourceTask.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": `{"images":[{"storageKey":"resource:reference"}]}`}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = svc.ApplyExternalAgentTask(userID, sourceTask.ID, ExternalAgentApplyRequest{}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"inferred", "explicit"} {
		_, err = svc.ApplyCanvasOperations(userID, "canvas", canvas.CanvasOperationsRequest{Operations: []canvas.CanvasOperation{
			{Op: "add", Node: map[string]any{"id": id, "type": "image", "metadata": map[string]any{"referenceNodeIds": []string{sourceID}}}},
			{Op: "connect", Connection: map[string]any{"fromNodeId": sourceID, "toNodeId": id}},
		}})
		if err != nil {
			t.Fatal(err)
		}
		req := externalAgentRequest()
		req.NodeID, req.IdempotencyKey = id, id
		if id == "explicit" {
			req.Input = map[string]any{"referenceNodeIds": []string{}}
		}
		task, _, submitErr := svc.SubmitExternalAgentTask(userID, req)
		if submitErr != nil {
			t.Fatal(submitErr)
		}
		task, err = svc.repo.TaskForUser(userID, task.ID)
		if err != nil {
			t.Fatal(err)
		}
		var input map[string]any
		if err = json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
			t.Fatal(err)
		}
		refs, _ := input["referenceImages"].([]any)
		if id == "inferred" && (len(refs) != 1 || refs[0].(map[string]any)["id"] != sourceID) {
			t.Fatalf("manual connection not inherited: %+v", refs)
		}
		if id == "explicit" && len(refs) != 0 {
			t.Fatalf("explicit empty references ignored: %+v", refs)
		}
	}
}

func TestExternalAgentCancelledAndDeletedBeforeWriteback(t *testing.T) {
	svc, db, userID := externalAgentFixture(t)
	req := externalAgentRequest()
	task, nodeID, err := svc.SubmitExternalAgentTask(userID, req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.CancelTask(context.Background(), userID, task.ID); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject(userID, "canvas")
	if !strings.Contains(string(raw), `"taskStatus":"cancelled"`) {
		t.Fatal("cancellation left the canvas loading")
	}
	req.IdempotencyKey = "deleted-before-finish"
	task, nodeID, err = svc.SubmitExternalAgentTask(userID, req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.DeleteUserCanvasNode(userID, "canvas", nodeID); err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&model.Task{}).Where("id = ?", task.ID).Update("status", model.TaskStatusFailed).Error; err != nil {
		t.Fatal(err)
	}
	svc.noteExternalAgentTask(*task)
	stored, _ := svc.repo.TaskForUser(userID, task.ID)
	if !strings.Contains(stored.InputJSON, `"externalAgentWriteback":"skipped"`) {
		t.Fatal("removed target keeps retrying forever")
	}
	pending, err := svc.repo.PendingExternalAgentWritebacks(50)
	if err != nil || len(pending) != 0 {
		t.Fatalf("terminal projections remained pending: %v %v", pending, err)
	}
	raw, _ = svc.UserCanvasProject(userID, "canvas")
	if strings.Contains(string(raw), nodeID) {
		t.Fatal("writeback resurrected deleted target")
	}
}
