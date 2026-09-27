package app

import (
	"encoding/json"
	"qisitv/backend/internal/model"
	"testing"
)

func TestLocalAgentRunUsesDesktopManagedProvider(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","baseUrl":"https://enterprise.beefapi.example","apiKey":"test-key","enabled":true,"models":["text-local"]}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.CanvasProject{ID: "local-agent-canvas", UserID: "user", PayloadJSON: `{"nodes":[],"connections":[]}`}).Error; err != nil {
		t.Fatal(err)
	}
	req := agentTestRequest()
	req.CanvasID = "local-agent-canvas"
	req.Model = "text-local"
	req.ChannelID = ""
	req.ChannelModelKey = ""
	req.IdempotencyKey = "local-agent-admission-test"
	run, err := s.CreateCloudAgentRun("user", req, "")
	if err != nil {
		t.Fatal(err)
	}
	var task model.Task
	if err := db.First(&task, "id = ?", run.ID).Error; err != nil {
		t.Fatal(err)
	}
	var input struct {
		Config map[string]any `json:"config"`
	}
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	if input.Config["model"] != "text-local" || input.Config["baseUrl"] != "https://enterprise.beefapi.com" || input.Config["apiKey"] == "" {
		t.Fatalf("provider config missing: %#v", input.Config)
	}
	if _, ok := input.Config["channelId"]; ok {
		t.Fatalf("local sentinel leaked: %#v", input.Config)
	}
}
