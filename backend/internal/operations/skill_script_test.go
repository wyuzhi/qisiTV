package operations_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/skills"
)

func TestSkillScriptProposalApprovalAndSessionAlwaysAllow(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not on PATH")
	}
	dir := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "ops-script.sqlite")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Skill{}, &model.SkillVersion{}, &model.SkillFile{}, &model.UserSkillState{}, &model.SystemSetting{}, &model.AgentOpRecord{}, &model.AssistantTurn{}); err != nil {
		t.Fatal(err)
	}
	rawDB, _ := db.DB()
	t.Cleanup(func() { _ = rawDB.Close() })

	skillSvc := skills.New(repository.New(db), dir, nil)
	var zipBuf bytes.Buffer
	zw := zip.NewWriter(&zipBuf)
	for name, content := range map[string]string{
		"SKILL.md":       "---\nname: 脚本审批测试\ndescription: 验证脚本确认与本对话始终允许\n---\n运行 scripts/echo.js",
		"scripts/echo.js": "console.log('ECHO:' + process.argv.slice(2).join(','));",
	} {
		f, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(f, content)
	}
	_ = zw.Close()

	var formBuf bytes.Buffer
	mw := multipart.NewWriter(&formBuf)
	fw, _ := mw.CreateFormFile("file", "skill.zip")
	_, _ = fw.Write(zipBuf.Bytes())
	_ = mw.Close()
	req := httptest.NewRequest("POST", "/skills/install", &formBuf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	_ = req.ParseMultipartForm(10 << 20)
	defer req.MultipartForm.RemoveAll()

	installed, err := skillSvc.InstallSkillUpload("owner", "zip", req.MultipartForm.File["file"][0], skills.SkillInstallRequest{IsPrivate: true})
	if err != nil {
		t.Fatal(err)
	}
	pin := skills.Pin{SkillID: installed.SkillID, VersionID: installed.VersionID, ContentHash: installed.ContentHash}

	sessionID := "durable:22222222-2222-2222-2222-222222222222"
	// 1. First call requires confirmation
	firstOut, err := operations.ProposeOrRunSkillScript(context.Background(), db, skillSvc, "owner", "turn-1", skills.ScriptRunRequest{
		CanvasID:   "canvas-1",
		SessionID:  sessionID,
		Pin:        pin,
		ScriptPath: "scripts/echo.js",
		Args:       []string{"hello", "world"},
		Note:       "测试首次确认",
	})
	if err != nil {
		t.Fatal(err)
	}
	firstMap := firstOut.(map[string]any)
	if firstMap["status"] != "requires_confirmation" {
		t.Fatalf("expected status=requires_confirmation, got %+v", firstMap)
	}
	proposal := firstMap["proposal"].(operations.SkillScriptProposal)
	if !strings.HasPrefix(proposal.ProposalID, "sp-") || proposal.Status != "pending" {
		t.Fatalf("unexpected proposal: %+v", proposal)
	}

	// 2. Confirm proposal with alwaysAllowSession=true
	confirmed, result, err := operations.ConfirmSkillScriptProposal(context.Background(), db, skillSvc, "owner", "turn-1", proposal.ProposalID, "canvas-1", true)
	if err != nil {
		t.Fatal(err)
	}
	if confirmed.Status != "completed" || result.ExitCode != 0 || strings.TrimSpace(result.Stdout) != "ECHO:hello,world" {
		t.Fatalf("unexpected confirmation result: proposal=%+v result=%+v", confirmed, result)
	}

	// 3. Subsequent call in the same session for the same script runs inline
	secondOut, err := operations.ProposeOrRunSkillScript(context.Background(), db, skillSvc, "owner", "turn-2", skills.ScriptRunRequest{
		CanvasID:   "canvas-1",
		SessionID:  sessionID,
		Pin:        pin,
		ScriptPath: "scripts/echo.js",
		Args:       []string{"auto"},
	})
	if err != nil {
		t.Fatal(err)
	}
	secondMap := secondOut.(map[string]any)
	if secondMap["status"] != "completed" {
		t.Fatalf("expected session-allowed script to run immediately, got %+v", secondMap)
	}
	secondRes := secondMap["result"].(*skills.ScriptRunResult)
	if strings.TrimSpace(secondRes.Stdout) != "ECHO:auto" {
		t.Fatalf("unexpected auto-run stdout: %q", secondRes.Stdout)
	}

	// 4. Revoking session allows requires confirmation again
	if err := operations.RevokeSessionScriptAllows(db, "owner", "canvas-1", sessionID); err != nil {
		t.Fatal(err)
	}
	thirdOut, err := operations.ProposeOrRunSkillScript(context.Background(), db, skillSvc, "owner", "turn-3", skills.ScriptRunRequest{
		CanvasID:   "canvas-1",
		SessionID:  sessionID,
		Pin:        pin,
		ScriptPath: "scripts/echo.js",
		Args:       []string{"after-revoke"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if thirdOut.(map[string]any)["status"] != "requires_confirmation" {
		t.Fatalf("expected requires_confirmation after RevokeSessionScriptAllows, got %+v", thirdOut)
	}

	// 5. Empty turnID is rejected on propose and confirm
	if _, err := operations.ProposeOrRunSkillScript(context.Background(), db, skillSvc, "owner", "", skills.ScriptRunRequest{
		CanvasID:   "canvas-1",
		SessionID:  sessionID,
		Pin:        pin,
		ScriptPath: "scripts/echo.js",
	}); err == nil {
		t.Fatal("expected empty turnID to be rejected by ProposeOrRunSkillScript")
	}
	if err := operations.UpsertSkillScriptProposal(db, "owner", operations.SkillScriptProposal{
		ProposalID: "sp-no-turn",
		TurnID:     "",
		CanvasID:   "canvas-1",
		SkillID:    pin.SkillID,
		VersionID:  pin.VersionID,
		ContentHash: pin.ContentHash,
		ScriptPath: "scripts/echo.js",
		Status:     "pending",
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := operations.ConfirmSkillScriptProposal(context.Background(), db, skillSvc, "owner", "turn-3", "sp-no-turn", "canvas-1", false); err == nil {
		t.Fatal("expected proposal without TurnID to be rejected by ConfirmSkillScriptProposal")
	}
}

func TestSkillScriptRunOperationAuthorizationAndIdempotentReplay(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not on PATH")
	}
	h := newHarness(t)
	var zipBuf bytes.Buffer
	zw := zip.NewWriter(&zipBuf)
	for name, content := range map[string]string{
		"SKILL.md":          "---\nname: 计数器脚本\ndescription: 验证 opId 幂等与权限边界\n---\n运行 scripts/count.js",
		"scripts/count.js":  "const fs=require('fs'),p=require('path');const f=p.join(process.env.BEEFTV_OUTPUT_DIR,'count.txt');const n=fs.existsSync(f)?Number(fs.readFileSync(f,'utf8'))+1:1;fs.writeFileSync(f,String(n));console.log('COUNT:'+n);",
	} {
		f, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(f, content)
	}
	_ = zw.Close()

	var formBuf bytes.Buffer
	mw := multipart.NewWriter(&formBuf)
	fw, _ := mw.CreateFormFile("file", "skill.zip")
	_, _ = fw.Write(zipBuf.Bytes())
	_ = mw.Close()
	req := httptest.NewRequest("POST", "/skills/install", &formBuf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	_ = req.ParseMultipartForm(10 << 20)
	defer req.MultipartForm.RemoveAll()

	installed, err := h.service.SkillsDomain().InstallSkillUpload(h.userID, "zip", req.MultipartForm.File["file"][0], skills.SkillInstallRequest{IsPrivate: true})
	if err != nil {
		t.Fatal(err)
	}
	pin := skills.Pin{SkillID: installed.SkillID, VersionID: installed.VersionID, ContentHash: installed.ContentHash}.Identity()
	params := map[string]any{
		"canvasId":              h.canvasID,
		"skillId":               pin.SkillID,
		"versionId":             pin.VersionID,
		"contentHash":           pin.ContentHash,
		"scriptPath":            "scripts/count.js",
		"useWorkspaceOutputDir": true,
	}

	// 1. Read-only external client rejected with CodeReadOnly
	_, err = h.execute(t, operations.ExternalCaller(true), "skill.script.run", "op-ro-script", params)
	if got := opErr(t, err); got.Code != operations.CodeReadOnly || got.Reason != "read_only_client" {
		t.Fatalf("expected read_only_client for read-only external caller, got %+v", got)
	}

	// 2. Read-write external client without assistant turn rejected with scope_denied
	_, err = h.execute(t, operations.ExternalCaller(false), "skill.script.run", "op-ext-script", params)
	if got := opErr(t, err); got.Code != operations.CodePermissionDenied || got.Reason != "scope_denied" {
		t.Fatalf("expected scope_denied for external caller without assistant turn, got %+v", got)
	}

	// 3. Assistant caller without pinned skill rejected with scope_denied
	const turn1 = "1111222233334444"
	const sessionID = "durable:33333333-3333-3333-3333-333333333333"
	if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turn1, app.AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	_ = h.service.AssistantTurns().BindDurableSession(h.userID, turn1, sessionID, false)
	unpinnedCaller := operations.AssistantCaller(&agentops.AssistantScope{
		CanvasID:       h.canvasID,
		PermissionMode: "canvas",
		SkillPins:      map[skills.Pin]bool{},
	}, false)
	rawParams := mustMarshalRaw(t, params)
	_, err = h.registry.Execute(operations.Request{
		Op: "skill.script.run", OpID: "op-unpinned", UserID: h.userID, TurnID: turn1, Caller: unpinnedCaller, Params: rawParams,
	})
	if got := opErr(t, err); got.Code != operations.CodePermissionDenied || got.Reason != "scope_denied" {
		t.Fatalf("expected scope_denied for unpinned skill, got %+v", got)
	}

	// 4. Pinned skill with session allow runs once and replays idempotently on same opId
	const turn2 = "5555666677778888"
	if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turn2, app.AssistantTurnInput{SkillPins: []skills.Pin{pin}}); err != nil {
		t.Fatal(err)
	}
	_ = h.service.AssistantTurns().BindDurableSession(h.userID, turn2, sessionID, false)
	if err := operations.RecordSessionScriptAllow(h.service.Database(), h.userID, h.canvasID, sessionID, pin, "scripts/count.js"); err != nil {
		t.Fatal(err)
	}
	pinnedCaller := operations.AssistantCaller(&agentops.AssistantScope{
		CanvasID:       h.canvasID,
		PermissionMode: "canvas",
		SkillPins:      map[skills.Pin]bool{pin: true},
	}, false)
	firstExec, err := h.registry.Execute(operations.Request{
		Op: "skill.script.run", OpID: "op-auto-1", UserID: h.userID, TurnID: turn2, Caller: pinnedCaller, Params: rawParams,
	})
	if err != nil {
		t.Fatal(err)
	}
	if firstExec.Replayed {
		t.Fatal("expected first execution not to be replayed")
	}
	replayExec, err := h.registry.Execute(operations.Request{
		Op: "skill.script.run", OpID: "op-auto-1", UserID: h.userID, TurnID: turn2, Caller: pinnedCaller, Params: rawParams,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !replayExec.Replayed {
		t.Fatal("expected second execution with same OpID to be replayed without re-running script")
	}
	proposals, err := operations.ListTurnSkillScriptProposals(h.service.Database(), h.userID, h.canvasID, turn2)
	if err != nil {
		t.Fatal(err)
	}
	if len(proposals) != 1 || proposals[0].Result == nil || strings.TrimSpace(proposals[0].Result.Stdout) != "COUNT:1" {
		t.Fatalf("expected exactly 1 script execution on replay, got proposals=%+v", proposals)
	}
	if err := h.service.FinalizeAssistantTurn(turn2); err != nil {
		t.Fatalf("FinalizeAssistantTurn must succeed after skill.script.run receipt: %v", err)
	}
	_ = database.MigrateLocalSchema
}

func mustMarshalRaw(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

