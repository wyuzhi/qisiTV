package workspace

import (
	"encoding/json"
	"errors"
	"testing"

	"qisitv/backend/internal/channelurl"
)

func TestPreferredMediaConfigSeedsWithoutWallet(t *testing.T) {
	store, err := NewProviderConfig(t.TempDir())
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
	store, _ := NewProviderConfig(t.TempDir())
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

func TestLikeAIExistingConnectionsKeepTheirCredentialsAtTheirOwnAddress(t *testing.T) {
	store, err := NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old := []byte(`{"channels":[{"id":"likeai","apiFormat":"likeai","baseUrl":"https://task.likeai.pro/task-api","apiKey":"old-fixture","headers":[{"name":"X-Partner-Key","value":"header-fixture"}]},{"id":"qisi-api","apiFormat":"likeai","baseUrl":"https://cheeser.link/api-service/likeai","apiKey":"qisi-fixture"}]}`)
	if err := store.SaveLocalModelConfig(old); err != nil {
		t.Fatal(err)
	}
	state, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	prior := requireEffectiveChannel(t, state, "likeai")
	fresh := requireEffectiveChannel(t, state, "likeai-service")
	qisi := requireEffectiveChannel(t, state, "qisi-api")
	if prior["baseUrl"] != channelurl.LegacyLikeAIBaseURL || prior["apiKey"] != "old-fixture" || fresh["baseUrl"] != channelurl.LikeAIBaseURL || fresh["apiKey"] != "" || len(fresh["headers"].([]any)) != 0 || qisi["baseUrl"] != channelurl.QisiAPIBaseURL || qisi["apiKey"] != "qisi-fixture" {
		t.Fatal("existing connection or new credentials changed")
	}
	for _, stored := range []string{"likeai", "qisi-api"} {
		for _, secret := range []map[string]any{{"apiKey": RedactedSecret}, {"headers": []any{map[string]any{"name": "X-Partner-Key", "value": RedactedSecret}}}} {
			secret["id"], secret["apiFormat"], secret["baseUrl"] = stored, "likeai", channelurl.LikeAIBaseURL
			changed, _ := json.Marshal(map[string]any{"channels": []any{secret}})
			if err := store.SaveLocalModelConfig(changed); !errors.Is(err, ErrUnmatchedRedactedSecret) {
				t.Fatal("masked credential was reused after changing the address", err)
			}
		}
	}
}
