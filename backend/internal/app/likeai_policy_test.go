package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestLikeAIPolicyPreservesIndependentAssistantChannels(t *testing.T) {
	s := NewLocal(nil, t.TempDir())
	s.UseLikeAIOnly()
	for _, protocol := range []string{"chat-completion", "claude-api", "runninghub", "openai-image"} {
		if err := s.requireActiveProvider(protocol, "https://custom.example/v1"); err != nil {
			t.Fatal(err)
		}
	}
	for _, base := range []string{"https://task.likeai.pro.attacker.example/task-api", "http://task.likeai.pro/task-api", "https://task.likeai.pro:8443/task-api", "https://task.likeai.pro/task-api?x=1"} {
		if err := s.requireActiveProvider("likeai-image", base); err == nil {
			t.Fatal("untrusted LikeAI origin accepted")
		}
	}
	for _, base := range []string{likeAIBaseURL, "https://cheeser.link/api-service/likeai"} {
		if err := s.requireActiveProvider("likeai-video", base); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAgentModelsPreserveConfiguredChannelsWithoutSecrets(t *testing.T) {
	s := NewLocal(nil, t.TempDir())
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"assistant","baseUrl":"https://example.com/v1","apiKey":"assistant-secret","models":["text-model"],"modelProfiles":[{"model":"text-model","capability":"text","protocol":"chat-completion"}]},{"id":"likeai","baseUrl":"https://task.likeai.pro/task-api","apiFormat":"likeai","apiKey":"media-secret","models":["doubao_seedance_2_5"],"modelProfiles":[{"model":"doubao_seedance_2_5","capability":"video","protocol":"likeai-video"}]}],"textModel":"assistant::text-model","assistantModel":"assistant::text-model"}`)); err != nil {
		t.Fatal(err)
	}
	s.UseLikeAIOnly()
	models, err := s.ExternalAgentModels()
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("configured models lost: %#v", models)
	}
	raw, _ := json.Marshal(models)
	if strings.Contains(string(raw), "secret") {
		t.Fatal("catalog exposed credential")
	}
}
