package app

import (
	"context"
	"os"
	"testing"

	"qisitv/backend/internal/beeftv"
	"qisitv/backend/internal/protocol"
)

func TestManagedGeminiCatalogCredentialProviderChain(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beeftv","baseUrl":"https://beeftv.app","apiKey":"test-only-key"}]}`)); err != nil {
		t.Fatal(err)
	}
	manifest, err := os.ReadFile("../../../plugin-packages/google-gemini-generate-content/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	adapters, err := protocol.LoadInstalledProviders(manifest)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := protocol.NewRegistry(adapters...)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"gemini-generate-content", "google-gemini-generate-content"} {
		resolved, err := s.resolveManagedBeefTVSecrets(map[string]any{"config": map[string]any{"channelId": "beeftv", "credentialRef": beeftv.CredentialRef, "interfaceType": id}})
		if err != nil {
			t.Fatal(err)
		}
		config := resolved["config"].(map[string]any)
		if config["apiKey"] != "test-only-key" || config["baseUrl"] != "https://beeftv.app" {
			t.Fatal("managed credential did not resolve")
		}
		adapter, ok := registry.Resolve(config["interfaceType"].(string))
		if !ok || adapter.Metadata().ID != "gemini-generate-content" {
			t.Fatalf("provider %q did not resolve", id)
		}
		agent, ok := adapter.(protocol.AgentAdapter)
		if !ok {
			t.Fatal("Gemini text adapter unavailable")
		}
		spec, err := agent.BuildAgent(context.Background(), protocol.AgentRequestContext{Model: "gemini-test"})
		if err != nil {
			t.Fatal(err)
		}
		if spec.Path != "/v1beta/models/gemini-test:generateContent" {
			t.Fatalf("unexpected native path %q", spec.Path)
		}
	}
}

func TestCustomRelayOnlyInjectsBeefTVKeyForExactConfiguredOrigin(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beeftv","baseUrl":"https://beeftv.app","apiKey":"disk-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{
		"http://beeftv.app/v1/chat/completions",
		"https://beeftv.app:8443/v1/chat/completions",
		"https://127.0.0.1.attacker.example/v1/chat/completions",
		"http://127.0.0.1:9999/v1/chat/completions",
		"http://localhost:9999/v1/chat/completions",
		"https://beeftv.app.attacker.example/v1/chat/completions",
		"https://user@beeftv.app/v1/chat/completions",
		"https://legacy-enterprise.example.com/v1/chat/completions",
	} {
		t.Run(target, func(t *testing.T) {
			got, err := s.ResolveCustomRelayAPIKey(target, "other-channel-key")
			if err != nil || got != "other-channel-key" {
				t.Fatalf("unrelated origin credential was replaced: error=%v", err)
			}
		})
	}
	got, err := s.ResolveCustomRelayAPIKey("https://beeftv.app/v1/chat/completions", "")
	if err != nil || got != "disk-secret" {
		t.Fatalf("configured origin did not resolve its credential: error=%v", err)
	}
	byokGot, err := s.ResolveCustomRelayAPIKey("https://beeftv.app/v1/chat/completions", "custom-byok")
	if err != nil || byokGot != "custom-byok" {
		t.Fatalf("same-origin BYOK key was replaced by managed credential: got=%q error=%v", byokGot, err)
	}
}

func TestResolveManagedBeefTVSecretsUsesStoredKeyAndDropsClientSentinel(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beeftv","baseUrl":"https://beeftv.app","apiKey":"disk-secret","enabled":true,"models":["text-local"]}]}`)); err != nil {
		t.Fatal(err)
	}
	input := map[string]any{"config": map[string]any{"channelId": "beeftv", "credentialRef": beeftv.CredentialRef, "apiKey": "from-webview", "baseUrl": "https://beeftv.app", "model": "text-local"}}
	resolved, err := s.resolveManagedBeefTVSecrets(input)
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
	if config["credentialRef"] != beeftv.CredentialRef {
		t.Fatalf("credentialRef = %#v", config["credentialRef"])
	}
	unmanaged := map[string]any{"config": map[string]any{"apiKey": "custom-byok", "baseUrl": "https://beeftv.app", "model": "text-local"}}
	unmanagedResolved, err := s.resolveManagedBeefTVSecrets(unmanaged)
	if err != nil {
		t.Fatal(err)
	}
	unmanagedConfig := unmanagedResolved["config"].(map[string]any)
	if unmanagedConfig["apiKey"] != "custom-byok" || unmanagedConfig["credentialRef"] != nil {
		t.Fatalf("same-origin BYOK config was rewritten to managed credential: %#v", unmanagedConfig)
	}
}

func TestChannelCatalogManagedCredentialPinsOrigin(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	if err := s.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beeftv","baseUrl":"https://beeftv.app","apiKey":"test-only-key"}]}`)); err != nil {
		t.Fatal(err)
	}
	for _, input := range []ChannelModelsRequest{
		{CredentialRef: beeftv.CredentialRef, ChannelID: "other", BaseURL: "https://attacker.example/v1"},
		{ChannelID: beeftv.ChannelID, BaseURL: "https://attacker.example/v1"},
	} {
		if err := s.resolveChannelModelsRequest(&input); err != nil {
			t.Fatal(err)
		}
		if input.BaseURL != "https://beeftv.app" || input.APIKey != "test-only-key" {
			t.Fatal("stored credential not bound to configured origin")
		}
	}
	for _, input := range []ChannelModelsRequest{
		{BaseURL: "https://beeftv.app/v1", APIKey: "custom-key"},
		{ChannelID: "other", BaseURL: "https://custom.example/v1", APIKey: "custom-key"},
	} {
		wantBase, wantKey := input.BaseURL, input.APIKey
		if err := s.resolveChannelModelsRequest(&input); err != nil {
			t.Fatal(err)
		}
		if input.BaseURL != wantBase || input.APIKey != wantKey {
			t.Fatal("unrelated custom channel changed")
		}
	}
}
