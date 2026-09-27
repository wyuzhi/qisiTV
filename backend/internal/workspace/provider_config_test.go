package workspace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPreRenameRedactedConfigPreservesConfiguredSecret(t *testing.T) {
	old := map[string]any{"apiKey": "fixture-secret"}
	for _, placeholder := range []string{"__BEEFTV_REDACTED__", RedactedSecret} {
		incoming := map[string]any{"apiKey": placeholder}
		preserveSecrets(incoming, old)
		if incoming["apiKey"] != "fixture-secret" {
			t.Fatal("rename overwrote configured secret")
		}
	}
}

func TestProviderConfigMigratesLegacyBeefAPIStateWithoutLosingLocalChoices(t *testing.T) {
	dir := t.TempDir()
	legacy := `{
        "channels":[{"id":"beefapi","name":"BeefAPI old","baseUrl":"https://old.invalid","apiKey":"local-secret","headers":[{"name":"X-Site","value":"desktop"}],"enabled":false,"models":["legacy-model"],"modelProfiles":[{"model":"seedance-2.0-fast","protocol":"newapi-channel-1","capability":"video"}]}],
        "imageModel":"beefapi::gpt-image-2","videoModel":"beefapi::seedance-2.0-fast","textModel":"beefapi::gpt-5.6-sol","audioModel":"beefapi::minimax-music-v3.0"
    }`
	if err := os.WriteFile(filepath.Join(dir, LocalProviderConfigFile), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}

	effective, health, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if health != ConfigHealthMigrated {
		t.Fatalf("health = %q", health)
	}
	channel := requireEffectiveChannel(t, effective, "beefapi")
	if channel["name"] != "BeefAPI" || channel["baseUrl"] != "https://enterprise.beefapi.com" {
		t.Fatalf("preset-owned identity was not repaired: %#v", channel)
	}
	if channel["apiKey"] != "local-secret" || channel["enabled"] != false {
		t.Fatalf("local channel state was not preserved: %#v", channel)
	}
	headers, _ := channel["headers"].([]any)
	if len(headers) != 1 {
		t.Fatalf("local headers were not preserved: %#v", channel["headers"])
	}
	profiles, _ := channel["modelProfiles"].([]any)
	if len(profiles) != 1 {
		t.Fatalf("fetched model profiles were not preserved: %#v", profiles)
	}
	models, _ := channel["models"].([]string)
	if len(models) != 1 || models[0] != "legacy-model" {
		t.Fatalf("fetched model catalog was not preserved: %#v", models)
	}
	for key, want := range map[string]string{
		"imageModel": "beefapi::gpt-image-2", "videoModel": "beefapi::seedance-2.0-fast",
		"textModel": "beefapi::gpt-5.6-sol", "audioModel": "beefapi::minimax-music-v3.0",
	} {
		if effective.Config[key] != want {
			t.Fatalf("%s = %#v", key, effective.Config[key])
		}
	}
}

func TestProviderConfigSeedsBeefAPIWhenLocalStateIsMissing(t *testing.T) {
	store, err := NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	effective, health, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if health != ConfigHealthDefault {
		t.Fatalf("health = %q", health)
	}
	channel := requireEffectiveChannel(t, effective, "beefapi")
	if channel["apiKey"] != "" || channel["enabled"] != true {
		t.Fatalf("unexpected seeded local state: %#v", channel)
	}
}

func TestProviderConfigRecoversLastValidBackup(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","apiKey":"first-secret","enabled":true}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","apiKey":"second-secret","enabled":true}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, LocalProviderConfigFile), []byte(`{"schemaVersion":`), 0o600); err != nil {
		t.Fatal(err)
	}

	effective, health, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if health != ConfigHealthRecovered {
		t.Fatalf("health = %q", health)
	}
	if got := requireEffectiveChannel(t, effective, "beefapi")["apiKey"]; got != "first-secret" {
		t.Fatalf("recovered apiKey = %#v", got)
	}
}

func TestProviderConfigCommittedRevisionOnlyAdvancesAfterValidWrite(t *testing.T) {
	store, err := NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","apiKey":"secret","enabled":true}]}`)); err != nil {
		t.Fatal(err)
	}
	first, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":`)); err == nil {
		t.Fatal("invalid config was accepted")
	}
	second, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 || second.Revision != first.Revision {
		t.Fatalf("revisions = %d then %d", first.Revision, second.Revision)
	}
}

func requireEffectiveChannel(t *testing.T, effective EffectiveModelConfig, id string) map[string]any {
	t.Helper()
	raw, ok := effective.Config["channels"].([]any)
	if !ok {
		body, _ := json.Marshal(effective.Config["channels"])
		t.Fatalf("channels are not an array: %s", body)
	}
	for _, item := range raw {
		channel, _ := item.(map[string]any)
		if channel["id"] == id {
			return channel
		}
	}
	t.Fatalf("channel %q missing", id)
	return nil
}
