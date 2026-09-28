package workspace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLikeAIConfigSeedsOnlyActiveProvider(t *testing.T) {
	store, err := NewLikeAIProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	effective, health, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	channels := effective.Config["channels"].([]any)
	if health != ConfigHealthDefault || len(channels) != 1 {
		t.Fatalf("unexpected initial config: %#v", effective)
	}
	channel := requireEffectiveChannel(t, effective, "likeai")
	if channel["apiKey"] != "" || channel["baseUrl"] != LikeAIBaseURL || channel["apiFormat"] != "likeai" {
		t.Fatalf("invalid LikeAI defaults: %#v", channel)
	}
}

func TestLikeAIConfigKeepsHistoricalChannelsOnDiskOnly(t *testing.T) {
	dir := t.TempDir()
	legacy := `{"channels":[{"id":"beefapi","apiKey":"old-key","models":["old-model"]},{"id":"likeai","baseUrl":"https://stale.example","apiKey":"local-key","models":["doubao_seedance_2_5"],"modelProfiles":[{"model":"doubao_seedance_2_5","protocol":"likeai-video","capability":"video"}]}],"videoModel":"likeai::doubao_seedance_2_5","textModel":"beefapi::old-model"}`
	path := filepath.Join(dir, LocalProviderConfigFile)
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	store, _ := NewLikeAIProviderConfig(dir)
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if len(effective.Config["channels"].([]any)) != 1 {
		t.Fatal("inactive channel exposed")
	}
	channel := requireEffectiveChannel(t, effective, "likeai")
	if channel["apiKey"] != "local-key" || channel["baseUrl"] != LikeAIBaseURL || len(channel["models"].([]any)) != 1 {
		t.Fatal("active provider lost")
	}
	if effective.Config["videoModel"] != "likeai::doubao_seedance_2_5" || effective.Config["textModel"] != "" {
		t.Fatal("wrong defaults exposed")
	}
	before, _ := os.ReadFile(path)
	if string(before) != legacy {
		t.Fatal("reading config modified original")
	}
	channel["apiKey"] = RedactedSecret
	channel["enabled"] = false
	body, _ := json.Marshal(effective.Config)
	if _, err := store.SaveLocalModelConfigRevision(body, effective.Revision); err != nil {
		t.Fatal(err)
	}
	document, _, err := store.loadDocument()
	if err != nil {
		t.Fatal(err)
	}
	persisted := document.Config["channels"].([]any)
	if len(persisted) != 2 || persisted[0].(map[string]any)["apiKey"] != "old-key" {
		t.Fatal("historical provider was removed or changed")
	}
	if persisted[1].(map[string]any)["apiKey"] != "local-key" {
		t.Fatal("redacted active key was lost")
	}
}
