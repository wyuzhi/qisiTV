package beefapi

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/workspace"
)

func TestFetchedBeefAPICatalogEveryModelHasTheCorrectGenerationFamily(t *testing.T) {
	raw, err := os.ReadFile("../../../fixtures/model-catalog/beefapi-20261013.json")
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

// 默认值必须落在真实目录里的对话模型上，否则新用户连上后没有可用的助手模型。
func TestFetchedBeefAPICatalogInitializesDeepSeekAssistantDefault(t *testing.T) {
	raw, err := os.ReadFile("../../../fixtures/model-catalog/beefapi-20261013.json")
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
	if current.Config["assistantModel"] != "beeftv::"+DefaultManagedAssistantModel {
		t.Fatalf("assistant default = %v, want beeftv::%s", current.Config["assistantModel"], DefaultManagedAssistantModel)
	}
	if DefaultManagedAssistantModel != "deepseek-v4.1-flash" {
		t.Fatalf("assistant default moved to %q", DefaultManagedAssistantModel)
	}
}
