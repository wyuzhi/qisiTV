package beeftv

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/workspace"
)

func channelIDs(t *testing.T, raw any) []string {
	t.Helper()
	channels, _ := raw.([]any)
	ids := make([]string, 0, len(channels))
	for _, item := range channels {
		channel, _ := item.(map[string]any)
		id, _ := channel["id"].(string)
		ids = append(ids, id)
	}
	return ids
}

// A v2.1.x workspace saved the official channel as "beefapi". Reconnecting
// must leave only the current official channel in front and keep the user's
// own channels.
func TestReconnectDropsThePreRenameOfficialChannel(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	saved, _ := json.Marshal(map[string]any{"channels": []any{
		map[string]any{"id": "beefapi", "pinned": true, "credentialRef": "beefapi-enterprise", "models": []any{"seedream-x"}},
		map[string]any{"id": "channel-2", "baseUrl": "https://api.example.com", "models": []any{"m"}},
	}})
	if err := store.SaveLocalModelConfig(saved); err != nil {
		t.Fatal(err)
	}
	if err := applyCatalog(store, []CatalogModel{{ID: "seedream-x", SupportedEndpointTypes: []string{"image-generation"}}}, "", "42", ""); err != nil {
		t.Fatal(err)
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	ids := channelIDs(t, effective.Config["channels"])
	if len(ids) == 0 || ids[0] != ChannelID {
		t.Fatalf("official channel is not first after reconnect: %v", ids)
	}
	for _, id := range ids {
		if id == "beefapi" {
			t.Fatalf("pre-rename official channel survived reconnect: %v", ids)
		}
	}
	if ids[len(ids)-1] != "channel-2" {
		t.Fatalf("user channel was lost: %v", ids)
	}
	// The web client reads old "beefapi::model" references through this list.
	official := findChannel(effective.Config["channels"].([]any), ChannelID)
	if legacy, _ := json.Marshal(official["legacyIds"]); string(legacy) != `["beefapi"]` {
		t.Fatalf("official channel legacyIds = %s", legacy)
	}
}

func TestStalePageCannotWriteThePreRenameChannelBack(t *testing.T) {
	existing := map[string]any{"channels": []any{map[string]any{"id": ChannelID, "models": []any{"m"}}}}
	incoming := map[string]any{"channels": []any{
		map[string]any{"id": "beefapi", "pinned": true, "credentialRef": "beefapi-enterprise"},
		map[string]any{"id": ChannelID},
		map[string]any{"id": "channel-2", "baseUrl": "https://my-proxy.example.com"},
	}}
	PreserveManagedChannel(incoming, existing, true)
	ids := channelIDs(t, incoming["channels"])
	if len(ids) != 2 || ids[0] != ChannelID || ids[1] != "channel-2" {
		t.Fatalf("channels after save = %v", ids)
	}
}

// Before reconnecting, the saved config already carries the empty official
// preset, but nothing is connected; saving settings must not remove the old
// entry yet.
func TestSaveBeforeReconnectKeepsSavedChannels(t *testing.T) {
	existing := map[string]any{"channels": []any{map[string]any{"id": ChannelID, "pinned": true, "models": []any{}}}}
	incoming := map[string]any{"channels": []any{
		map[string]any{"id": "beefapi", "pinned": true, "credentialRef": "beefapi-enterprise"},
		map[string]any{"id": ChannelID, "pinned": true},
	}}
	PreserveManagedChannel(incoming, existing, false)
	if ids := channelIDs(t, incoming["channels"]); len(ids) != 2 || ids[0] != "beefapi" {
		t.Fatalf("channels before reconnect = %v", ids)
	}
}
