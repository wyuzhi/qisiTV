package modelcatalog

import (
	"testing"
)

// 换默认值不能把旧默认从托管名单里删掉：已选 gpt-6-astra 的老用户还要能用。
func TestManagedAssistantModelsKeepDefaultAndPreviousDefault(t *testing.T) {
	if defaultManagedAssistantModel != "deepseek-v4.1-flash" {
		t.Fatalf("assistant default = %q, want deepseek-v4.1-flash", defaultManagedAssistantModel)
	}
	managed := map[string]bool{}
	for _, model := range managedAssistantModels {
		managed[model] = true
	}
	for _, model := range []string{defaultManagedAssistantModel, "gpt-6-astra"} {
		if !managed[model] {
			t.Fatalf("managed assistant models dropped %q: %v", model, managedAssistantModels)
		}
	}
	channel := AssistantChannel{
		ID: managedChannelID, Pinned: true, Enabled: true, APIKey: "synthetic", BaseURL: "https://example.test",
		Models: []string{"deepseek-v4.1-flash", "gpt-6-astra"},
		ModelProfiles: []AssistantModelProfile{
			{Model: "deepseek-v4.1-flash", Capability: "text", Protocol: "chat-completion"},
			{Model: "gpt-6-astra", Capability: "text", Protocol: "chat-completion"},
		},
	}
	for _, model := range []string{defaultManagedAssistantModel, "gpt-6-astra"} {
		snapshot := AssistantConfigSnapshot{AssistantModel: managedChannelID + "::" + model, Channels: []AssistantChannel{channel}}
		provider, err := ResolveAssistantProvider(snapshot, nil)
		if err != nil || provider.Model != model {
			t.Fatalf("managed model %q unavailable: %v %#v", model, err, provider)
		}
	}
}
