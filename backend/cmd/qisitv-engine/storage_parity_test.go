package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"qisitv/backend/internal/desktopstorage"
	"qisitv/backend/internal/model"
)

func TestOfflineMigrationPreservesAssistantWorkflowAndIndependentProjectRoot(t *testing.T) {
	profile := closedStorageFixture(t)
	db, err := gorm.Open(sqlite.Open(filepath.Join(profile, "open_ai_canvas.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	turn := model.AssistantTurn{TurnID: "original-turn", UserID: "owner", CanvasID: "canvas", State: "completed", DurableSessionID: "durable-session", CanvasSnapshotsJSON: `{"canvas":{"revision":3}}`, Document: "original assistant result"}
	workflow := model.CanvasWorkflow{ID: "original-workflow", UserID: "owner", Name: "Original workflow", Revision: 3, DefinitionJSON: `{"steps":[{"id":"step-one"}]}`, RecipeCipher: "opaque-original-recipe"}
	for _, row := range []any{&turn, &workflow} {
		if err = db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	sqlDB, _ := db.DB()
	if err = db.Exec("PRAGMA wal_checkpoint(TRUNCATE)").Error; err != nil {
		t.Fatal(err)
	}
	if err = sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
	projectRoot := t.TempDir()
	external := filepath.Join(projectRoot, "project.qisitv.json")
	if err = os.WriteFile(external, []byte(`{"existing":"independent project folder"}`), 0600); err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(profile, "qisitv-engine.json")
	raw, _ := os.ReadFile(settingsPath)
	var settings engineSettings
	if err = json.Unmarshal(raw, &settings); err != nil {
		t.Fatal(err)
	}
	settings.ProjectDirectory = projectRoot
	raw, _ = json.Marshal(settings)
	if err = os.WriteFile(settingsPath, raw, 0600); err != nil {
		t.Fatal(err)
	}

	// When Node and the bundled host dependencies are available, create a real
	// Durable SQLite session, complete one local mock turn, then read it after
	// migration without calling the mock model again.
	node := os.Getenv("QISITV_TEST_NODE")
	if node == "" {
		node, _ = exec.LookPath("node")
	}
	probe, _ := filepath.Abs("../../../agent-host/test-support/storage-migration-probe.mjs")
	_, dependencyErr := os.Stat(filepath.Join(filepath.Dir(probe), "../node_modules/@earendil-works/pi-durable"))
	withHost := node != "" && dependencyErr == nil
	runProbe := func(action, directory string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, node, probe, action, directory)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("durable %s: %v\n%s", action, err, output)
		}
	}
	if withHost {
		runProbe("create", profile)
	} else {
		t.Log("Node host fixture unavailable; business SQLite and independent root still verified")
	}
	before, err := desktopstorage.Snapshot(profile)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "relocated")
	if _, err = migrateEngineStorage(context.Background(), profile, target); err != nil {
		t.Fatal(err)
	}
	if err = desktopstorage.VerifySnapshot(target, before, false); err != nil {
		t.Fatal(err)
	}
	if err = desktopstorage.VerifySnapshot(profile, before, false); err != nil {
		t.Fatal("original backup changed", err)
	}
	reopened, err := gorm.Open(sqlite.Open(filepath.Join(target, "open_ai_canvas.db")+"?mode=ro&immutable=1"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { sql, _ := reopened.DB(); sql.Close() }()
	var gotTurn model.AssistantTurn
	var gotWorkflow model.CanvasWorkflow
	if err = reopened.First(&gotTurn, "turn_id=?", turn.TurnID).Error; err != nil {
		t.Fatal(err)
	}
	if err = reopened.First(&gotWorkflow, "id=?", workflow.ID).Error; err != nil {
		t.Fatal(err)
	}
	if gotTurn.Document != turn.Document || gotTurn.CanvasSnapshotsJSON != turn.CanvasSnapshotsJSON || gotTurn.DurableSessionID != turn.DurableSessionID || gotWorkflow.RecipeCipher != workflow.RecipeCipher || gotWorkflow.DefinitionJSON != workflow.DefinitionJSON {
		t.Fatal("assistant/workflow state changed")
	}
	copiedSettings, _ := os.ReadFile(filepath.Join(target, "qisitv-engine.json"))
	if string(copiedSettings) != string(raw) {
		t.Fatal("independent root pointer changed")
	}
	if data, err := os.ReadFile(external); err != nil || string(data) != `{"existing":"independent project folder"}` {
		t.Fatal("external project folder modified")
	}
	if withHost {
		runProbe("verify", target)
	}
}
