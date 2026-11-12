package workspace

import (
	"qisitv/backend/internal/providerpreset"
	"testing"
)

func TestBrandPresetPreservesLegacyOriginAndReferences(t *testing.T) {
	for _, origin := range []string{"", "https://legacy-enterprise.example.com", "https://beeftv.app"} {
		channel, err := presetChannelMap(providerpreset.BeefTV(), map[string]any{"baseUrl": origin, "apiKey": "stored", "models": []any{"custom-model"}})
		if err != nil {
			t.Fatal(err)
		}
		if channel["baseUrl"] != "https://beeftv.app" || channel["name"] != "BeefTV" || channel["id"] != "beeftv" || channel["apiKey"] != "stored" {
			t.Fatalf("migration changed channel: %#v", channel)
		}
		if models := channel["models"].([]string); len(models) != 1 || models[0] != "custom-model" {
			t.Fatalf("models = %#v", models)
		}
	}
}
