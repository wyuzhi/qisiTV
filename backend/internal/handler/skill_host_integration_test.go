package handler

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/skills"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSelectedSkillsActualHostBusinessFlows(t *testing.T) {
	cases := []struct {
		name, instruction, path, reference string
		titles                             []string
		script                             bool
	}{
		{"coffee", "读取 references/shots.md，为三个段落创建草稿，不生成。", "references/shots.md", "磨豆；手冲；甜点", []string{"磨豆", "手冲", "甜点"}, false},
		{"interview", "读取 references/interview.md，使用原话创建保留区间草稿。", "references/interview.md", "00:02-00:06 主人公说：每天练习。", []string{"00:02-00:06 每天练习"}, false},
		{"audio", "读取 scripts/listen.js，并提交 skill_script_run 等待用户确认运行。", "scripts/listen.js", "console.log('audio check ok')", nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newAssistantTestEnv(t, nil)
			const turnID = "112233aabbccdd44"
			owner, e := env.service.LocalWorkspaceOwner()
			if e != nil {
				t.Fatal(e)
			}
			var archive bytes.Buffer
			zw := zip.NewWriter(&archive)
			for name, content := range map[string]string{"SKILL.md": "---\nname: " + tc.name + "\ndescription: 上传创作流程\n---\n" + tc.instruction, tc.path: tc.reference} {
				f, e := zw.Create(name)
				if e != nil {
					t.Fatal(e)
				}
				io.WriteString(f, content)
			}
			zw.Close()
			var body bytes.Buffer
			form := multipart.NewWriter(&body)
			f, _ := form.CreateFormFile("file", "skill.zip")
			f.Write(archive.Bytes())
			form.Close()
			req := httptest.NewRequest("POST", "/skills/install", &body)
			req.Header.Set("Content-Type", form.FormDataContentType())
			if e := req.ParseMultipartForm(20 << 20); e != nil {
				t.Fatal(e)
			}
			defer req.MultipartForm.RemoveAll()
			installed, e := env.service.SkillsDomain().InstallSkillUpload(owner.ID, "zip", req.MultipartForm.File["file"][0], app.SkillInstallRequest{IsPrivate: true})
			if e != nil {
				t.Fatal(e)
			}
			pin := skills.Pin{SkillID: installed.SkillID, VersionID: installed.VersionID, ContentHash: installed.ContentHash}
			env.beginTurn(t, turnID, app.AssistantTurnInput{SkillPins: []skills.Pin{pin}})
			const continueTurnID = "112233aabbccdd45"
			const reselectTurnID = "112233aabbccdd46"
			const freshTurnID = "112233aabbccdd47"
			env.beginTurn(t, continueTurnID, app.AssistantTurnInput{})
			env.beginTurn(t, reselectTurnID, app.AssistantTurnInput{SkillPins: []skills.Pin{pin}})
			env.beginTurn(t, freshTurnID, app.AssistantTurnInput{})
			backend := httptest.NewServer(env.router)
			defer backend.Close()
			root, err := filepath.Abs("../../..")
			if err != nil {
				t.Fatal(err)
			}
			directory := t.TempDir()
			config, err := json.Marshal(map[string]any{"root": root, "directory": directory, "backend": backend.URL + "/api", "canvasId": env.canvasID, "turnId": turnID, "continueTurnId": continueTurnID, "reselectTurnId": reselectTurnID, "freshTurnId": freshTurnID, "hostToken": assistantTestHostToken, "pin": pin, "instruction": tc.instruction, "path": tc.path, "reference": tc.reference, "titles": tc.titles, "script": tc.script})
			if err != nil {
				t.Fatal(err)
			}
			configPath := filepath.Join(directory, "config.json")
			if err := os.WriteFile(configPath, config, 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, "node", filepath.Join(root, "agent-host/test-support/skill-business-probe.mjs"), configPath)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("real Durable host/Go probe failed: %v\n%s", err, output)
			}
			raw, e := env.service.UserCanvasProject(owner.ID, env.canvasID)
			if e != nil {
				t.Fatal(e)
			}
			var doc struct {
				Nodes []struct {
					Title    string `json:"title"`
					Metadata struct {
						Prompt string `json:"prompt"`
					} `json:"metadata"`
				} `json:"nodes"`
			}
			if e := json.Unmarshal(raw, &doc); e != nil {
				t.Fatal(e)
			}
			if len(doc.Nodes) != 1+len(tc.titles) {
				t.Fatalf("unexpected mutations %s", raw)
			}
			for _, title := range tc.titles {
				found := false
				for _, node := range doc.Nodes {
					if node.Title == title && node.Metadata.Prompt == tc.reference {
						found = true
					}
				}
				if !found {
					t.Fatalf("missing task draft %s", raw)
				}
			}
		})
	}
}

func TestConfirmSkillScriptProposalRouteAndTokenBoundary(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not on PATH")
	}
	env := newAssistantTestEnv(t, nil)
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	for name, content := range map[string]string{
		"SKILL.md":        "---\nname: 脚本确认路由\ndescription: 验证 UI 确认执行脚本\n---\n运行 scripts/check.js",
		"scripts/check.js": "console.log('CHECK_OK:' + process.argv.slice(2).join('|'));",
	} {
		f, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(f, content)
	}
	_ = zw.Close()

	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	fw, _ := form.CreateFormFile("file", "skill.zip")
	_, _ = fw.Write(archive.Bytes())
	_ = form.Close()
	req := httptest.NewRequest("POST", "/skills/install", &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	if err := req.ParseMultipartForm(20 << 20); err != nil {
		t.Fatal(err)
	}
	defer req.MultipartForm.RemoveAll()
	installed, err := env.service.SkillsDomain().InstallSkillUpload(owner.ID, "zip", req.MultipartForm.File["file"][0], app.SkillInstallRequest{IsPrivate: true})
	if err != nil {
		t.Fatal(err)
	}
	pin := skills.Pin{SkillID: installed.SkillID, VersionID: installed.VersionID, ContentHash: installed.ContentHash}

	const turnID = "aabbccddeeff0011"
	env.beginTurn(t, turnID, app.AssistantTurnInput{SkillPins: []skills.Pin{pin}})

	proposed, err := operations.ProposeOrRunSkillScript(context.Background(), env.service.Database(), env.service.SkillsDomain(), owner.ID, turnID, skills.ScriptRunRequest{
		CanvasID:   env.canvasID,
		Pin:        pin,
		ScriptPath: "scripts/check.js",
		Args:       []string{"arg1", "arg2"},
	})
	if err != nil {
		t.Fatal(err)
	}
	proposal := proposed.(map[string]any)["proposal"].(operations.SkillScriptProposal)
	runURL := "http://127.0.0.1:18090/api/assistant/turns/" + turnID + "/script-proposals/" + proposal.ProposalID + "/run"
	reqBody := `{"canvasId":"` + env.canvasID + `","alwaysAllowSession":true}`

	// 1. Agent host token cannot self-approve
	hostReq := httptest.NewRequest(http.MethodPost, runURL, strings.NewReader(reqBody))
	hostReq.Host = "127.0.0.1:18090"
	hostReq.RemoteAddr = "127.0.0.1:12345"
	hostReq.Header.Set("Content-Type", "application/json")
	hostReq.Header.Set("X-Beeftv-Agent-Token", assistantTestHostToken)
	hostRec := httptest.NewRecorder()
	env.router.ServeHTTP(hostRec, hostReq)
	if hostRec.Code != http.StatusForbidden || !strings.Contains(hostRec.Body.String(), "agent_token_cannot_approve") {
		t.Fatalf("expected 403 agent_token_cannot_approve for host token, got %d %s", hostRec.Code, hostRec.Body.String())
	}

	// 2. UI session confirms and executes script
	uiReq := httptest.NewRequest(http.MethodPost, runURL, strings.NewReader(reqBody))
	uiReq.Host = "127.0.0.1:18090"
	uiReq.RemoteAddr = "127.0.0.1:12345"
	uiReq.Header.Set("Content-Type", "application/json")
	uiReq.Header.Set("X-Beeftv-Ui-Session", env.uiToken)
	uiRec := httptest.NewRecorder()
	env.router.ServeHTTP(uiRec, uiReq)
	if uiRec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from UI session script confirmation, got %d %s", uiRec.Code, uiRec.Body.String())
	}
	if !strings.Contains(uiRec.Body.String(), "CHECK_OK:arg1|arg2") || !strings.Contains(uiRec.Body.String(), `"status":"completed"`) {
		t.Fatalf("unexpected confirmation response: %s", uiRec.Body.String())
	}

	// 3. turn_end stream projection includes scriptProposals for the turn
	turnEndLine := assistantOutputsLine([]byte(`{"type":"turn_end","turnId":"`+turnID+`","reply":"ok","toolCalls":[]}`+"\n"), env.service, owner.ID, env.canvasID, turnID)
	if !strings.Contains(string(turnEndLine), `"scriptProposals"`) || !strings.Contains(string(turnEndLine), proposal.ProposalID) {
		t.Fatalf("expected turn_end projection to include scriptProposals, got %s", string(turnEndLine))
	}

	// 4. Cancelled script run does not wake host
	var slowArchive bytes.Buffer
	slowZw := zip.NewWriter(&slowArchive)
	for name, content := range map[string]string{
		"SKILL.md":        "---\nname: 慢脚本取消测试\ndescription: 验证取消脚本不唤醒宿主\n---\n运行 scripts/slow.js",
		"scripts/slow.js": "setTimeout(() => console.log('DONE'), 30000);",
	} {
		f, err := slowZw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(f, content)
	}
	_ = slowZw.Close()
	var slowBody bytes.Buffer
	slowForm := multipart.NewWriter(&slowBody)
	slowFw, _ := slowForm.CreateFormFile("file", "slow.zip")
	_, _ = slowFw.Write(slowArchive.Bytes())
	_ = slowForm.Close()
	slowInstallReq := httptest.NewRequest("POST", "/skills/install", &slowBody)
	slowInstallReq.Header.Set("Content-Type", slowForm.FormDataContentType())
	if err := slowInstallReq.ParseMultipartForm(20 << 20); err != nil {
		t.Fatal(err)
	}
	defer slowInstallReq.MultipartForm.RemoveAll()
	slowInstalled, err := env.service.SkillsDomain().InstallSkillUpload(owner.ID, "zip", slowInstallReq.MultipartForm.File["file"][0], app.SkillInstallRequest{IsPrivate: true})
	if err != nil {
		t.Fatal(err)
	}
	slowPin := skills.Pin{SkillID: slowInstalled.SkillID, VersionID: slowInstalled.VersionID, ContentHash: slowInstalled.ContentHash}

	const cancelTurnID = "aabbccddeeff0022"
	env.beginTurn(t, cancelTurnID, app.AssistantTurnInput{SkillPins: []skills.Pin{slowPin}})
	_ = operations.RevokeSessionScriptAllows(env.service.Database(), owner.ID, env.canvasID, "")
	slowProposed, err := operations.ProposeOrRunSkillScript(context.Background(), env.service.Database(), env.service.SkillsDomain(), owner.ID, cancelTurnID, skills.ScriptRunRequest{
		CanvasID:   env.canvasID,
		Pin:        slowPin,
		ScriptPath: "scripts/slow.js",
	})
	if err != nil {
		t.Fatal(err)
	}
	slowProposal := slowProposed.(map[string]any)["proposal"].(operations.SkillScriptProposal)
	go func() {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if env.service.SkillsDomain().CancelScriptRuns(env.canvasID, "", cancelTurnID) > 0 {
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
	}()
	slowRunURL := "http://127.0.0.1:18090/api/assistant/turns/" + cancelTurnID + "/script-proposals/" + slowProposal.ProposalID + "/run"
	slowUIReq := httptest.NewRequest(http.MethodPost, slowRunURL, strings.NewReader(`{"canvasId":"`+env.canvasID+`"}`))
	slowUIReq.Host = "127.0.0.1:18090"
	slowUIReq.RemoteAddr = "127.0.0.1:12345"
	slowUIReq.Header.Set("Content-Type", "application/json")
	slowUIReq.Header.Set("X-Beeftv-Ui-Session", env.uiToken)
	slowUIRec := httptest.NewRecorder()
	env.router.ServeHTTP(slowUIRec, slowUIReq)
	if slowUIRec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for cancelled script proposal run, got %d %s", slowUIRec.Code, slowUIRec.Body.String())
	}
	if !strings.Contains(slowUIRec.Body.String(), `"status":"cancelled"`) || !strings.Contains(slowUIRec.Body.String(), `"woken":false`) || !strings.Contains(slowUIRec.Body.String(), `"continuationMessage":""`) {
		t.Fatalf("expected cancelled script proposal not to wake host or build continuation message, got %s", slowUIRec.Body.String())
	}
}
