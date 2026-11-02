package plugins

import (
	"encoding/json"
	"testing"
)

func TestUpgradeReferenceRemoval(t *testing.T) {
	for _, provider := range []string{"same-package", "newapi"} {
		packageID := "same-package"
		if provider == "newapi" {
			packageID = "openai-videos"
		}
		for _, reference := range []string{provider, "openai-video"} {
			if provider != "newapi" && reference != provider {
				continue
			}
			for _, kept := range []bool{false, true} {
				name := provider + "/" + reference + "/removed"
				if kept {
					name = provider + "/" + reference + "/kept"
				}
				t.Run(name, func(t *testing.T) {
					release := t.TempDir()
					t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
					nextID := "replacement"
					if kept {
						nextID = provider
					}
					shipPackage(t, release, retentionManifest(packageID, nextID, "2.0.0"))
					stored := storedOfficialRecord(t, retentionManifest(packageID, provider, "1.0.0"), true)
					runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), staticReferences{reference: {PendingTasks: 1}})
					if err != nil {
						t.Fatal(err)
					}
					item, ok := ByID(runtime.List(), packageID)
					wantVersion := "1.0.0"
					if kept {
						wantVersion = "2.0.0"
					}
					if !ok || item.Manifest.Version != wantVersion || (item.Retention != nil) == kept {
						t.Fatalf("wrong removal decision: version=%q retention=%+v", item.Manifest.Version, item.Retention)
					}
					if _, ok := runtime.Registry().Resolve(reference); !ok {
						t.Fatal("task lost its protocol")
					}
				})
			}
		}
	}
}

func TestFailedAuditAllowsUpgradeKeepingProviderIDs(t *testing.T) {
	// 包名和 provider 不同也不能误判为删除了 ID。
	release := t.TempDir()
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
	shipPackage(t, release, retentionManifestWithPoll("openai-videos", "newapi", "2.0.0", "/fixed/{{taskId}}"))
	stored := storedOfficialRecord(t, retentionManifestWithPoll("openai-videos", "newapi", "1.0.0", "/old/{{taskId}}"), false)
	runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), failingReferences{})
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(runtime.List(), "openai-videos")
	if !ok || item.Manifest.Version != "2.0.0" || item.Retention != nil || item.Status != StatusDisabled {
		t.Fatalf("compatible update failed or enabled a disabled plugin: %+v", item)
	}
}

func TestUpgradeMultiProviderOnlyChecksRemovedReferences(t *testing.T) {
	for _, removedInUse := range []bool{false, true} {
		name := "removed-unused"
		if removedInUse {
			name = "removed-pending"
		}
		t.Run(name, func(t *testing.T) {
			release := t.TempDir()
			t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
			var old, extra map[string]any
			if err := json.Unmarshal(retentionManifest("multi", "kept", "1.0.0"), &old); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(retentionManifest("extra", "removed", "1.0.0"), &extra); err != nil {
				t.Fatal(err)
			}
			contributes := old["contributes"].(map[string]any)
			contributes["providers"] = append(contributes["providers"].([]any), extra["contributes"].(map[string]any)["providers"].([]any)...)
			raw, err := json.Marshal(old)
			if err != nil {
				t.Fatal(err)
			}
			stored := storedOfficialRecord(t, raw, true)
			shipPackage(t, release, retentionManifest("multi", "kept", "2.0.0"))
			refs := staticReferences{"kept": {Configured: 1, PendingTasks: 1}}
			if removedInUse {
				refs["removed"] = ReferenceUsage{PendingTasks: 1}
			}
			runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), refs)
			if err != nil {
				t.Fatal(err)
			}
			item, _ := ByID(runtime.List(), "multi")
			want := "2.0.0"
			if removedInUse {
				want = "1.0.0"
			}
			if item.Manifest.Version != want {
				t.Fatalf("version=%s want=%s", item.Manifest.Version, want)
			}
			if _, ok := runtime.Registry().Resolve("kept"); !ok {
				t.Fatal("kept provider missing")
			}
			if _, ok := runtime.Registry().Resolve("removed"); ok != removedInUse {
				t.Fatal("removed provider retention incorrect")
			}
		})
	}
}
