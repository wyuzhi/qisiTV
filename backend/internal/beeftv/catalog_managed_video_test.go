package beeftv

import (
	"encoding/json"
	"os"
	"testing"

	"infinite-canvas/backend/internal/workspace"
)

func TestManagedVideoCatalogHandlerFixtures(t *testing.T) {
	for _, file := range []string{"managed-video-catalog.json", "managed-video-catalog-live.json"} {
		body, err := os.ReadFile("testdata/" + file)
		if err != nil {
			t.Fatal(err)
		}
		var payload struct {
			Data []struct {
				ID      string          `json:"id"`
				Video   json.RawMessage `json:"video_capabilities"`
				Version string          `json:"video_capabilities_version"`
			} `json:"data"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		for _, row := range payload.Data {
			if row.Version == "" {
				continue
			}
			t.Run(file+"/"+row.ID, func(t *testing.T) {
				store, err := workspace.NewProviderConfig(t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				model := CatalogModel{ID: row.ID, VideoCapabilities: row.Video, VideoCapabilitiesVersion: row.Version}
				if err := applyCatalog(store, []CatalogModel{model}, "", "account-a", ""); err != nil {
					t.Fatal(err)
				}
				profile := catalogProfile(t, store, row.ID)
				if profile["protocol"] != "openai-videos" || profile["capability"] != "video" || profile["videoCapabilitiesVersion"] != row.Version {
					t.Fatalf("server declaration not recognized: %#v", profile)
				}
				original, _ := json.Marshal(profile["capabilityConfig"])
				// A missing version must not replace the same account's good snapshot,
				// including paid-tier names formerly dropped during every refresh.
				model.VideoCapabilitiesVersion = " "
				model.SupportedEndpointTypes = []string{"openai"}
				if err := applyCatalog(store, []CatalogModel{model}, "account-a", "account-a", ""); err != nil {
					t.Fatal(err)
				}
				profile = catalogProfile(t, store, row.ID)
				next, _ := json.Marshal(profile["capabilityConfig"])
				if string(original) != string(next) || profile["videoCapabilitiesVersion"] != row.Version || profile["capability"] != "video" || profile["protocol"] != "openai-videos" {
					t.Fatal("partial refresh destroyed the saved declaration")
				}
				if err := applyCatalog(store, []CatalogModel{model}, "account-a", "account-b", ""); err != nil {
					t.Fatal(err)
				}
				profile = catalogProfile(t, store, row.ID)
				if profile["capabilityConfig"] != nil || profile["videoCapabilitiesVersion"] != nil {
					t.Fatal("another account inherited the previous declaration")
				}
			})
		}
	}
}
