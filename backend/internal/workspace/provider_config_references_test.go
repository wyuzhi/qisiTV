package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSavedProtocolReferencesCountsChannelsAndProfiles(t *testing.T) {
	dir := t.TempDir()
	body := `{"schemaVersion":1,"revision":4,"config":{
        "channels":[
            {"id":"jimeng","apiKey":"placeholder","interfaceType":"volcengine-jimeng-video","models":["jimeng-video-3.0"],"modelProfiles":[{"model":"jimeng-video-3.0","protocol":"volcengine-jimeng-video","capability":"video"}]},
            {"id":"relay","apiKey":"placeholder","models":["a","b"],"modelProfiles":[{"model":"a","protocol":"video-generations-json"},{"model":"b","protocol":"video-generations-json"},{"model":"c","protocol":""}]},
            {"id":"no-protocol","apiKey":"placeholder","models":["plain"]}
        ]
    }}`
	path := filepath.Join(dir, LocalProviderConfigFile)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	counts, err := store.SavedProtocolReferences()
	if err != nil {
		t.Fatal(err)
	}
	if counts["volcengine-jimeng-video"] != 2 {
		t.Fatalf("jimeng references = %d want 2 (interfaceType + profile)", counts["volcengine-jimeng-video"])
	}
	if counts["video-generations-json"] != 2 {
		t.Fatalf("relay references = %d want 2", counts["video-generations-json"])
	}
	// A profile without a protocol field and a listed model without a profile
	// both run with the legacy text default, so the audit must keep it.
	if counts["chat-completion"] != 2 {
		t.Fatalf("legacy default references = %d want 2 (profile c + model plain)", counts["chat-completion"])
	}
	if len(counts) != 3 {
		t.Fatalf("unexpected protocol references: %#v", counts)
	}
	for _, value := range counts {
		if value <= 0 {
			t.Fatalf("non-positive reference count: %#v", counts)
		}
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("reference audit rewrote the stored configuration")
	}
}

func TestSavedProtocolReferencesReadsEncryptedSnapshot(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"placeholder-key","models":["m"],"modelProfiles":[{"model":"m","protocol":"xai-video"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	counts, err := store.SavedProtocolReferences()
	if err != nil {
		t.Fatal(err)
	}
	if counts["xai-video"] != 1 {
		t.Fatalf("references = %#v", counts)
	}
	// The encrypted migration still happens on the normal read path, not here.
	if _, err := os.Stat(filepath.Join(dir, LocalProviderConfigFile+".bak")); err == nil {
		t.Fatal("audit rotated the configuration backup")
	}
}

func TestSavedProtocolReferencesWithoutConfigIsEmpty(t *testing.T) {
	store, err := NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	counts, err := store.SavedProtocolReferences()
	if err != nil {
		t.Fatal(err)
	}
	if len(counts) != 0 {
		t.Fatalf("references = %#v", counts)
	}
}

func TestSavedProtocolReferencesFailsClosedOnCorruptConfig(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, LocalProviderConfigFile), []byte(`{"schemaVersion":2,"encryptedConfig":"broken"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SavedProtocolReferences(); err == nil {
		t.Fatal("corrupt configuration was reported as an empty reference set")
	}
}

// TestSavedProtocolReferencesReadsRecoverableBackup covers the case where only the
// backup survives: the normal read path recovers from it, so the audit must count
// it too instead of reporting "no configuration" and letting the plugin go.
func TestSavedProtocolReferencesReadsRecoverableBackup(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"placeholder-key","models":["m"],"modelProfiles":[{"model":"m","protocol":"agnes-video"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	// A second save rotates the previous document into the backup; then the
	// primary disappears, which is exactly the state loadDocument() recovers from.
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"placeholder-key","models":["m"],"modelProfiles":[{"model":"m","protocol":"agnes-video"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, LocalProviderConfigFile)); err != nil {
		t.Fatal(err)
	}
	counts, err := store.SavedProtocolReferences()
	if err != nil {
		t.Fatal(err)
	}
	if counts["agnes-video"] != 1 {
		t.Fatalf("backup references = %#v", counts)
	}
	// The audit stays read-only: it must not recreate or rewrite either file.
	if _, err := os.Stat(filepath.Join(dir, LocalProviderConfigFile)); !os.IsNotExist(err) {
		t.Fatal("audit recreated the primary configuration file")
	}
}

// TestSavedProtocolReferencesWithoutBothFilesIsEmpty keeps a genuine first run
// empty rather than conservative.
func TestSavedProtocolReferencesWithoutBothFilesIsEmpty(t *testing.T) {
	store, err := NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	counts, err := store.SavedProtocolReferences()
	if err != nil {
		t.Fatal(err)
	}
	if len(counts) != 0 {
		t.Fatalf("references = %#v", counts)
	}
}

// TestSavedProtocolReferencesCountsLegacyDefaultsAndSkipsPending covers the two
// states a profile without a protocol can be in: a legacy profile still runs with
// its capability's default (audio → openai-audio), while a profile the host left
// unconfigured on purpose (protocolPending) runs with nothing.
func TestSavedProtocolReferencesCountsLegacyDefaultsAndSkipsPending(t *testing.T) {
	dir := t.TempDir()
	body := `{"schemaVersion":1,"revision":1,"config":{"channels":[
        {"id":"voice","apiKey":"placeholder","models":["custom-voice","gpt-image-3"],"modelProfiles":[
            {"model":"custom-voice","capability":"audio"},
            {"model":"gpt-image-3","capability":"image","protocolPending":true}
        ]},
        {"id":"gemini","apiKey":"placeholder","apiFormat":"gemini","models":["reasoner"],"modelProfiles":[{"model":"reasoner","capability":"text"}]}
    ]}}`
	if err := os.WriteFile(filepath.Join(dir, LocalProviderConfigFile), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	counts, err := store.SavedProtocolReferences()
	if err != nil {
		t.Fatal(err)
	}
	if counts["openai-audio"] != 1 || len(counts) != 1 {
		t.Fatalf("references = %#v want only openai-audio:1", counts)
	}
}
