package app

import (
	"testing"

	"qisitv/backend/internal/beefapi"
)

func TestCustomRelayOnlyInjectsBeefAPIKeyForExactConfiguredOrigin(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","baseUrl":"https://enterprise.beefapi.com","apiKey":"disk-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{
		"http://enterprise.beefapi.com/v1/chat/completions",
		"https://enterprise.beefapi.com:8443/v1/chat/completions",
		"https://127.0.0.1.attacker.example/v1/chat/completions",
		"http://127.0.0.1:9999/v1/chat/completions",
		"http://localhost:9999/v1/chat/completions",
		"https://enterprise.beefapi.com.attacker.example/v1/chat/completions",
		"https://user@enterprise.beefapi.com/v1/chat/completions",
	} {
		t.Run(target, func(t *testing.T) {
			got, err := s.ResolveCustomRelayAPIKey(target, "other-channel-key")
			if err != nil || got != "other-channel-key" {
				t.Fatalf("unrelated origin credential was replaced: error=%v", err)
			}
		})
	}
	got, err := s.ResolveCustomRelayAPIKey("https://enterprise.beefapi.com/v1/chat/completions", "")
	if err != nil || got != "disk-secret" {
		t.Fatalf("configured origin did not resolve its credential: error=%v", err)
	}
}

func TestResolveManagedBeefAPISecretsUsesStoredKeyAndDropsClientSentinel(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","baseUrl":"https://enterprise.beefapi.com","apiKey":"disk-secret","enabled":true,"models":["text-local"]}]}`)); err != nil {
		t.Fatal(err)
	}
	input := map[string]any{"config": map[string]any{"channelId": "beefapi", "credentialRef": beefapi.CredentialRef, "apiKey": "from-webview", "baseUrl": "https://enterprise.beefapi.com", "model": "text-local"}}
	resolved, err := s.resolveManagedBeefAPISecrets(input)
	if err != nil {
		t.Fatal(err)
	}
	config := resolved["config"].(map[string]any)
	if config["apiKey"] != "disk-secret" {
		t.Fatalf("apiKey = %#v", config["apiKey"])
	}
	if _, exists := config["channelId"]; exists {
		t.Fatalf("system channel id leaked: %#v", config)
	}
	if config["credentialRef"] != beefapi.CredentialRef {
		t.Fatalf("credentialRef = %#v", config["credentialRef"])
	}
}
