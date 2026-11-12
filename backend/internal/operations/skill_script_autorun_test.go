package operations_test

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/operations"
	"qisitv/backend/internal/repository"
	"qisitv/backend/internal/skills"
)

func TestSkillScriptAutoRunSettingReplacesProposalConfirmation(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not on PATH")
	}
	dir := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "ops-script-setting.sqlite")), &gorm.Config{})
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
		"SKILL.md":        "---\nname: 自动运行开关测试\ndescription: 验证自动运行设置\n---\n运行 scripts/echo.js",
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

	// Default is off: the proposal still waits for confirmation.
	if operations.SkillScriptAutoRunEnabled(db) {
		t.Fatal("expected auto-run setting to default to off")
	}
	offOut, err := operations.ProposeOrRunSkillScript(context.Background(), db, skillSvc, "owner", "turn-off", skills.ScriptRunRequest{
		CanvasID:   "canvas-1",
		SessionID:  "durable:44444444-4444-4444-4444-444444444444",
		Pin:        pin,
		ScriptPath: "scripts/echo.js",
		Args:       []string{"off"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if offOut.(map[string]any)["status"] != "requires_confirmation" {
		t.Fatalf("expected requires_confirmation while setting is off, got %+v", offOut)
	}

	// Turning the setting on runs the same proposal path immediately, even when
	// the turn has no durable session.
	if err := operations.SetSkillScriptAutoRun(db, true); err != nil {
		t.Fatal(err)
	}
	onOut, err := operations.ProposeOrRunSkillScript(context.Background(), db, skillSvc, "owner", "turn-on", skills.ScriptRunRequest{
		CanvasID:   "canvas-1",
		Pin:        pin,
		ScriptPath: "scripts/echo.js",
		Args:       []string{"on"},
	})
	if err != nil {
		t.Fatal(err)
	}
	onMap := onOut.(map[string]any)
	if onMap["status"] != "completed" {
		t.Fatalf("expected auto-run to complete without confirmation, got %+v", onMap)
	}
	onRes := onMap["result"].(*skills.ScriptRunResult)
	if strings.TrimSpace(onRes.Stdout) != "ECHO:on" {
		t.Fatalf("unexpected auto-run stdout: %q", onRes.Stdout)
	}

	// Turning it back off restores the confirmation card.
	if err := operations.SetSkillScriptAutoRun(db, false); err != nil {
		t.Fatal(err)
	}
	offAgain, err := operations.ProposeOrRunSkillScript(context.Background(), db, skillSvc, "owner", "turn-off-again", skills.ScriptRunRequest{
		CanvasID:   "canvas-1",
		Pin:        pin,
		ScriptPath: "scripts/echo.js",
		Args:       []string{"off-again"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if offAgain.(map[string]any)["status"] != "requires_confirmation" {
		t.Fatalf("expected requires_confirmation after disabling auto-run, got %+v", offAgain)
	}
}
