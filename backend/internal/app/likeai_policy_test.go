package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"qisitv/backend/internal/model"
)

func TestLikeAIOnlyPolicyRejectsOtherProvidersBeforeAdmission(t *testing.T) {
	s := NewLocal(nil, t.TempDir())
	s.UseLikeAIOnly()
	for _, config := range []map[string]any{
		{"interfaceType": "openai-image", "baseUrl": "https://enterprise.beefapi.com"},
		{"interfaceType": "likeai-image", "baseUrl": "https://task.likeai.pro.attacker.example/task-api"},
		{"interfaceType": "likeai-image", "baseUrl": "http://task.likeai.pro/task-api"},
		{"interfaceType": "likeai-image", "baseUrl": "https://task.likeai.pro:8443/task-api"},
		{"interfaceType": "likeai-image", "baseUrl": "https://task.likeai.pro/task-api?x=1"},
		{"interfaceType": "runninghub", "baseUrl": "https://www.runninghub.cn"},
	} {
		_, err := s.CreateTask("local", CreateTaskRequest{Type: "canvas_image", Prompt: "test", Input: map[string]any{"config": config}})
		if err == nil || !strings.Contains(err.Error(), "LikeAI") {
			t.Fatalf("provider admitted: %v", err)
		}
		_, err = s.resolveProviderConfig(providerConfig{BaseURL: stringValue(config["baseUrl"]), InterfaceType: stringValue(config["interfaceType"])})
		if err == nil {
			t.Fatal("historical provider execution resumed")
		}
	}
	if err := s.requireActiveProvider("likeai-image", "https://task.likeai.pro/task-api"); err != nil {
		t.Fatal(err)
	}
	_, err := s.FetchChannelModelCatalog(context.Background(), &model.User{ID: "local"}, ChannelModelsRequest{APIFormat: "openai", BaseURL: "https://enterprise.beefapi.com", APIKey: "fixture"})
	if err == nil || !strings.Contains(err.Error(), "LikeAI") {
		t.Fatal("legacy catalog accepted")
	}
}

func TestLikeAIOnlyAgentModelsPreserveCurrentCatalog(t *testing.T) {
	s := NewLocal(nil, t.TempDir())
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","apiKey":"old-secret","models":["old-model"],"modelProfiles":[{"model":"old-model","capability":"image","protocol":"openai-image"}]},{"id":"likeai","apiKey":"active-secret","models":["doubao_seedance_2_5","image-model"],"modelProfiles":[{"model":"doubao_seedance_2_5","capability":"video","protocol":"likeai-video"},{"model":"image-model","capability":"image","protocol":"likeai-image"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	s.UseLikeAIOnly()
	models, err := s.ExternalAgentModels()
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("models = %#v", models)
	}
	for _, model := range models {
		if model["channelId"] != "likeai" {
			t.Fatal("inactive model exposed")
		}
	}
	raw, _ := json.Marshal(models)
	if strings.Contains(string(raw), "secret") {
		t.Fatal("catalog exposed a secret")
	}
	config, found := s.localAgentProviderConfig("doubao_seedance_2_5", "likeai")
	if !found || config["apiKey"] != "active-secret" {
		t.Fatal("Agent cannot resolve existing LikeAI config")
	}
	if _, found := s.localAgentProviderConfig("old-model", "beefapi"); found {
		t.Fatal("Agent can resolve inactive provider")
	}
}
