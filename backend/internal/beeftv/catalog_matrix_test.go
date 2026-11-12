package beeftv

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"qisitv/backend/internal/workspace"
)

func TestFetchedBeefTVCatalogEveryModelHasTheCorrectGenerationFamily(t *testing.T) {
	raw, err := os.ReadFile("../../../fixtures/model-catalog/beeftv-20261013.json")
	if err != nil {
		t.Fatal(err)
	}
	var models []struct {
		ID        string   `json:"id"`
		Endpoints []string `json:"supported_endpoint_types"`
	}
	if err := json.Unmarshal(raw, &models); err != nil {
		t.Fatal(err)
	}
	if len(models) != 47 {
		t.Fatalf("fixture size %d", len(models))
	}
	for _, model := range models {
		want := "text"
		switch {
		case model.ID == "hy-asr-3.0-preview":
			want = ""
		case strings.Contains(model.ID, "image"):
			want = "image"
		case strings.Contains(model.ID, "speech") || strings.Contains(model.ID, "music"):
			want = "audio"
		case strings.Contains(model.ID, "video") || strings.HasPrefix(model.ID, "seedance-") || model.ID == "minimax-h3-max-turbo":
			want = "video"
		}
		capability, protocol := catalogCapabilityAndProtocol(CatalogModel{ID: model.ID, SupportedEndpointTypes: model.Endpoints})
		if capability != want || (want != "" && protocol == "") {
			t.Fatalf("%s: capability=%s protocol=%s expected=%s", model.ID, capability, protocol, want)
		}
	}
}

// Media catalog authorization leaves the independent assistant choice unchanged.
func TestFetchedBeefTVCatalogPreservesMissingAssistantSelection(t *testing.T) {
	raw, err := os.ReadFile("../../../fixtures/model-catalog/beeftv-20261013.json")
	if err != nil {
		t.Fatal(err)
	}
	var wire []struct {
		ID        string   `json:"id"`
		Endpoints []string `json:"supported_endpoint_types"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	models := make([]CatalogModel, 0, len(wire))
	for _, model := range wire {
		models = append(models, CatalogModel{ID: model.ID, SupportedEndpointTypes: model.Endpoints})
	}
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := applyCatalog(store, models, "", "42", "9001"); err != nil {
		t.Fatal(err)
	}
	current, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if _, selected := current.Config["assistantModel"]; selected {
		t.Fatalf("catalog connection implicitly chose an assistant: %v", current.Config["assistantModel"])
	}
}
