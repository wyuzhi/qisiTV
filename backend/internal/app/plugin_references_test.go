package app

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"qisitv/backend/internal/workspace"
)

type fakeReferenceStore struct {
	channels map[string]int64
	tasks    map[string]int64
	err      error
}

func (s fakeReferenceStore) ChannelModelProtocolReferences() (map[string]int64, error) {
	return s.channels, s.err
}

func (s fakeReferenceStore) TaskProviderReferences() (map[string]int64, error) {
	return s.tasks, s.err
}

// writeLocalModelConfig stores a legacy-shaped snapshot the way the desktop
// profile saves it, with a custom connection that must keep working.
func writeLocalModelConfig(t *testing.T, dataDir, body string) string {
	t.Helper()
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dataDir, workspace.LocalProviderConfigFile)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestPluginReferencesMergesSavedConfigChannelsAndTasks(t *testing.T) {
	dataDir := t.TempDir()
	path := writeLocalModelConfig(t, dataDir, `{
        "channels": [
            {"id": "jimeng", "name": "即梦", "baseUrl": "https://example.invalid", "apiKey": "placeholder-key", "enabled": true,
             "models": ["jimeng-video-3.0"], "modelProfiles": [{"model": "jimeng-video-3.0", "protocol": "volcengine-jimeng-video", "capability": "video"}]},
            {"id": "legacy", "name": "旧连接", "baseUrl": "https://legacy.invalid", "enabled": false,
             "interfaceType": "newapi", "models": ["sora-2"], "modelProfiles": [{"model": "sora-2", "protocol": "newapi", "capability": "video"}]}
        ],
        "videoModel": "jimeng::jimeng-video-3.0"
    }`)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	references, err := newPluginReferences(dataDir, fakeReferenceStore{
		channels: map[string]int64{"video-generations-json": 2},
		tasks:    map[string]int64{"xai-video": 1, "newapi": 3},
	}).ReferencedProviders()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]struct {
		configured   int64
		pendingTasks int64
	}{
		"volcengine-jimeng-video": {configured: 1},
		// interfaceType keeps the protocol of a connection saved before
		// per-model profiles, and its profile counts once more.
		"newapi":                 {configured: 2, pendingTasks: 3},
		"video-generations-json": {configured: 2},
		"xai-video":              {pendingTasks: 1},
	}
	if len(references) != len(want) {
		t.Fatalf("references = %#v", references)
	}
	for id, expected := range want {
		usage, ok := references[id]
		if !ok {
			t.Fatalf("missing reference %q in %#v", id, references)
		}
		if usage.Configured != expected.configured || usage.PendingTasks != expected.pendingTasks {
			t.Fatalf("reference %q = %#v want %#v", id, usage, expected)
		}
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("reference audit rewrote the saved model configuration")
	}
}

func TestPluginReferencesWithoutSavedConfigCountsOnlyStoreReferences(t *testing.T) {
	references, err := newPluginReferences(t.TempDir(), fakeReferenceStore{tasks: map[string]int64{"newapi": 1}}).ReferencedProviders()
	if err != nil {
		t.Fatal(err)
	}
	if len(references) != 1 || references["newapi"].PendingTasks != 1 || references["newapi"].Configured != 0 {
		t.Fatalf("references = %#v", references)
	}
}

func TestPluginReferencesReportsUnreadableInventory(t *testing.T) {
	dataDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataDir, workspace.LocalProviderConfigFile), []byte(`{"schemaVersion":2,"encryptedConfig":"not-decryptable"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newPluginReferences(dataDir, fakeReferenceStore{}).ReferencedProviders(); err == nil {
		t.Fatal("unreadable saved configuration was reported as an empty inventory")
	}
	storeErr := errors.New("task store unavailable")
	if _, err := newPluginReferences(t.TempDir(), fakeReferenceStore{err: storeErr}).ReferencedProviders(); !errors.Is(err, storeErr) {
		t.Fatalf("store failure = %v", err)
	}
}

func TestPluginReferencesWithoutStoreIsAbsent(t *testing.T) {
	if newPluginReferences(t.TempDir(), nil) != nil {
		t.Fatal("audit source must stay nil without a store, so bootstrap falls back to its previous behavior")
	}
}
