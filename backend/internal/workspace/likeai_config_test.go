package workspace

import "testing"

func TestPreferredMediaConfigSeedsWithoutWallet(t *testing.T) {
	store, err := NewLikeAIProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if len(effective.Config["channels"].([]any)) != 2 {
		t.Fatal("unexpected default channel")
	}
	for _, id := range []string{"qisi-api", "likeai"} {
		channel := requireEffectiveChannel(t, effective, id)
		if channel["apiKey"] != "" || channel["apiFormat"] != "likeai" {
			t.Fatal("invalid media default")
		}
	}
}

func TestPreferredMediaConfigPreservesAssistantSelectionAndCredential(t *testing.T) {
	store, _ := NewLikeAIProviderConfig(t.TempDir())
	_, err := store.SaveLocalModelConfigRevision([]byte(`{"channels":[{"id":"assistant","name":"My LLM","baseUrl":"https://example.com/v1","apiFormat":"openai","apiKey":"test-secret","models":["text-model"]}],"textModel":"assistant::text-model","assistantModel":"assistant::text-model"}`), 0)
	if err != nil {
		t.Fatal(err)
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	channel := requireEffectiveChannel(t, effective, "assistant")
	if channel["apiKey"] != "test-secret" || effective.Config["textModel"] != "assistant::text-model" || effective.Config["assistantModel"] != "assistant::text-model" {
		t.Fatal("independent assistant configuration lost")
	}
}
