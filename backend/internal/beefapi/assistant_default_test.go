package beefapi

import (
	"context"
	"encoding/json"
	"os"
	"qisitv/backend/internal/workspace"
	"testing"
)

// 连接媒体服务不应选择或更改独立助手模型。
const assistantDefaultKey = ""

func assistantDefaultCatalog() []map[string]any {
	return []map[string]any{
		{"id": "deepseek-v4.1-flash", "model_type": "text"},
		{"id": "gpt-6-astra", "model_type": "text"},
		{"id": "claude-opus-5-5", "model_type": "text"},
	}
}

func saveAssistantSelection(t *testing.T, store *workspace.ProviderConfig, selection string) {
	t.Helper()
	current, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	current.Config["assistantModel"] = selection
	body, _ := json.Marshal(current.Config)
	if err := store.SaveLocalModelConfig(body); err != nil {
		t.Fatal(err)
	}
}

func loadAssistantSelection(t *testing.T, store *workspace.ProviderConfig) string {
	t.Helper()
	current, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	selection, _ := current.Config["assistantModel"].(string)
	return selection
}

func TestAssistantDefaultSurvivesStateWriteFailureAndColdRecovery(t *testing.T) {
	fake := &fakeEnterprise{models: assistantDefaultCatalog()}
	svc, store, dir := testService(t, fake)
	svc.persistFn = func(state persistedState) error {
		if state.Status == StateConnected {
			return os.ErrPermission
		}
		return saveState(dir, state)
	}
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, svc, StateStoreError)
	svc.Close()
	disk, err := loadState(dir)
	if err != nil || !disk.AssistantDefaultPending {
		t.Fatal("missing pending recovery fixture", err)
	}
	if selection := loadAssistantSelection(t, store); selection != assistantDefaultKey {
		t.Fatalf("catalog default = %q, want %q", selection, assistantDefaultKey)
	}
	saveAssistantSelection(t, store, "beefapi::claude-opus-5-5")
	reopened, err := workspace.NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	cold, err := New(Options{DataDir: dir, Origin: svc.origin, Provider: reopened, HTTPClient: svc.httpClient})
	if err != nil {
		t.Fatal(err)
	}
	defer cold.Close()
	if err := cold.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if selection := loadAssistantSelection(t, reopened); selection != "beefapi::claude-opus-5-5" {
		t.Fatalf("cold recovery overwrote manual choice: %q", selection)
	}
	// 同一账号重新授权：目录里仍有用户选的模型，就继续用它。
	fresh := []CatalogModel{{ID: "deepseek-v4.1-flash", ModelType: "text"}, {ID: "gpt-6-astra", ModelType: "text"}, {ID: "claude-opus-5-5", ModelType: "text"}}
	if err := applyCatalog(reopened, fresh, "42", "42", "9002"); err != nil {
		t.Fatal(err)
	}
	if selection := loadAssistantSelection(t, reopened); selection != "beefapi::claude-opus-5-5" {
		t.Fatalf("new authorization overwrote saved choice: %q", selection)
	}
	// 新目录不再提供该模型时也保留原选择，由界面提示重新选择；不自动换模型。
	if err := applyCatalog(reopened, []CatalogModel{{ID: "deepseek-v4.1-flash", ModelType: "text"}}, "42", "42", "9003"); err != nil {
		t.Fatal(err)
	}
	if selection := loadAssistantSelection(t, reopened); selection != "beefapi::claude-opus-5-5" {
		t.Fatalf("authorization replaced an unavailable saved choice: %q", selection)
	}
}

func TestCatalogFailureRecoveryPreservesSelectedAssistant(t *testing.T) {
	fake := &fakeEnterprise{models: assistantDefaultCatalog()}
	svc, store, _ := testService(t, fake)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, svc, StateConnected)
	if selection := loadAssistantSelection(t, store); selection != assistantDefaultKey {
		t.Fatalf("fresh authorization default = %q, want %q", selection, assistantDefaultKey)
	}
	saveAssistantSelection(t, store, "beefapi::claude-opus-5-5")
	fake.mu.Lock()
	fake.catalogFail = true
	fake.mu.Unlock()
	if err := svc.finalizeSavedCredential(context.Background(), ""); err == nil {
		t.Fatal("expected catalog failure")
	}
	fake.mu.Lock()
	fake.catalogFail = false
	fake.mu.Unlock()
	if err := svc.finalizeSavedCredential(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	if selection := loadAssistantSelection(t, store); selection != "beefapi::claude-opus-5-5" {
		t.Fatalf("catalog recovery overwrote user choice: %q", selection)
	}
}

func TestAuthorizationPreservesAssistantSelectionAndCatalogRefresh(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	models := []CatalogModel{
		{ID: "claude-opus-5-5", ModelType: "text", SupportedEndpointTypes: []string{"openai"}},
		{ID: "gpt-6-astra", ModelType: "text", SupportedEndpointTypes: []string{"openai"}},
		{ID: "deepseek-v4.1-flash", ModelType: "text", SupportedEndpointTypes: []string{"openai"}},
	}
	if err := applyCatalog(store, models, "", "42", "9001"); err != nil {
		t.Fatal(err)
	}
	if selection := loadAssistantSelection(t, store); selection != assistantDefaultKey {
		t.Fatalf("authorization did not choose DeepSeek Flash: %q", selection)
	}
	saveAssistantSelection(t, store, "beefapi::claude-opus-5-5")
	if err := applyCatalog(store, models, "42", "42", ""); err != nil {
		t.Fatal(err)
	}
	if selection := loadAssistantSelection(t, store); selection != "beefapi::claude-opus-5-5" {
		t.Fatalf("refresh overwrote user choice: %q", selection)
	}
	if err := applyCatalog(store, models[:1], "42", "42", "9001"); err != nil {
		t.Fatal(err)
	}
	if selection := loadAssistantSelection(t, store); selection != "beefapi::claude-opus-5-5" {
		t.Fatalf("repeated authorization reused a cached catalog: %q", selection)
	}
}

// 新授权的初始化只补空缺：已保存的选择在新目录里仍可用时保留，换账号也一样。
func TestFreshAuthorizationOnlyFillsMissingAssistantSelection(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	full := []CatalogModel{{ID: "deepseek-v4.1-flash", ModelType: "text"}, {ID: "claude-opus-5-5", ModelType: "text"}}
	if err := applyCatalog(store, full, "", "42", "9001"); err != nil {
		t.Fatal(err)
	}
	if selection := loadAssistantSelection(t, store); selection != assistantDefaultKey {
		t.Fatalf("first authorization default = %q", selection)
	}
	saveAssistantSelection(t, store, "beefapi::claude-opus-5-5")
	for _, tc := range []struct {
		name                  string
		previousAccount, next string
		authorization         string
	}{
		{name: "same account reauthorization", previousAccount: "42", next: "42", authorization: "9002"},
		{name: "account switch", previousAccount: "42", next: "99", authorization: "9003"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := applyCatalog(store, full, tc.previousAccount, tc.next, tc.authorization); err != nil {
				t.Fatal(err)
			}
			if selection := loadAssistantSelection(t, store); selection != "beefapi::claude-opus-5-5" {
				t.Fatalf("saved choice replaced by default: %q", selection)
			}
		})
	}
	// 新账号目录不再提供用户选的模型：同样保留原选择，由用户自己重新选。
	if err := applyCatalog(store, []CatalogModel{{ID: "deepseek-v4.1-flash", ModelType: "text"}}, "99", "77", "9004"); err != nil {
		t.Fatal(err)
	}
	if selection := loadAssistantSelection(t, store); selection != "beefapi::claude-opus-5-5" {
		t.Fatalf("unavailable saved choice was replaced: %q", selection)
	}
}

// 目录里没有默认模型时不虚构模型，也不清掉已有选择。
func TestAuthorizationDefaultRequiresCatalogModel(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	models := []CatalogModel{{ID: "claude-opus-5-5", ModelType: "text"}}
	if err := applyCatalog(store, models, "", "42", "9001"); err != nil {
		t.Fatal(err)
	}
	current, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := current.Config["assistantModel"]; exists {
		t.Fatalf("fabricated assistant default without catalog model: %v", current.Config["assistantModel"])
	}
	saveAssistantSelection(t, store, "beefapi::claude-opus-5-5")
	if err := applyCatalog(store, models, "", "42", "9002"); err != nil {
		t.Fatal(err)
	}
	if selection := loadAssistantSelection(t, store); selection != "beefapi::claude-opus-5-5" {
		t.Fatalf("missing default cleared a saved choice: %q", selection)
	}
}
