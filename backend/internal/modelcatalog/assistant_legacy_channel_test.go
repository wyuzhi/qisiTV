package modelcatalog

import "testing"

// Canvas nodes saved before v2.2.0 name the official channel by its former ID.
// After reconnecting removes that entry, the assistant must still propose them
// on the official channel, not report the model unavailable or pick another.
func TestAssistantResolvesNodesSavedUnderTheFormerOfficialID(t *testing.T) {
	snapshot := AssistantConfigSnapshot{Channels: []AssistantChannel{
		{ID: "channel-2", Enabled: true, Models: []string{"shared-image"}, ModelProfiles: []AssistantModelProfile{{Model: "shared-image", Capability: "image", Protocol: "openai-image"}}},
		{ID: "beeftv", Enabled: true, Pinned: true, LegacyIDs: []string{"beefapi"}, Models: []string{"shared-image"}, ModelProfiles: []AssistantModelProfile{{Model: "shared-image", Capability: "image", Protocol: "openai-image"}}},
	}}
	choice := ResolveAssistantGenerationModel(snapshot, "image", "beefapi::shared-image")
	if choice.ModelKey != "beeftv::shared-image" || !choice.FromNode {
		t.Fatalf("choice = %#v", choice)
	}
	// The current ID still wins over a legacy one.
	snapshot.Channels = append(snapshot.Channels, AssistantChannel{ID: "beefapi", Enabled: true, Models: []string{"shared-image"}, ModelProfiles: []AssistantModelProfile{{Model: "shared-image", Capability: "image", Protocol: "openai-image"}}})
	if choice := ResolveAssistantGenerationModel(snapshot, "image", "beefapi::shared-image"); choice.ModelKey != "beefapi::shared-image" {
		t.Fatalf("current ID did not win: %#v", choice)
	}
}

func TestAssistantChatModelSavedUnderTheFormerOfficialIDUsesTheOfficialChannel(t *testing.T) {
	channels := []AssistantChannel{
		{ID: "channel-2", Enabled: true, Models: []string{"chat-x"}},
		{ID: "beeftv", Enabled: true, LegacyIDs: []string{"beefapi"}, Models: []string{"chat-x"}},
	}
	if channel, ok := FindAssistantChannel(channels, "beefapi", "chat-x"); !ok || channel.ID != "beeftv" {
		t.Fatalf("channel = %#v ok=%v", channel, ok)
	}
}
