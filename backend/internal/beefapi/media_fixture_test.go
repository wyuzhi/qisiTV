package beefapi

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Fixtures are serialized by BeefAPI ResolveManagedImageTask, not reconstructed
// client-side DTO examples. Synthetic signatures are used for parsing only.
func TestManagedMediaServerProjectionFixtures(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	paths, err := filepath.Glob("testdata/managed-media/task-*.json")
	if err != nil || len(paths) != 6 {
		t.Fatalf("fixture count=%d err=%v", len(paths), err)
	}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			task, err := decodeMediaTask(data, "persisted-attempt", "image")
			if err != nil {
				t.Fatal(err)
			}
			if task.Outputs == nil {
				t.Fatal("server must serialize an empty array")
			}
			if task.AdjustmentQuota == nil || *task.AdjustmentQuota != 0 {
				t.Fatal("explicit zero settlement lost")
			}
			if task.Status == "completed" && task.ResultReceipt == nil {
				for i := range task.Outputs {
					task.Outputs[i].URL = "https://127.0.0.1/synthetic.png"
				}
				result, err := (&MediaClient{AllowHTTPTest: true}).Result(context.Background(), task, false)
				if err != nil {
					t.Fatal(err)
				}
				layers := result["imageLayers"].([]map[string]any)
				if layers[0]["layer_index"] != float64(0) || layers[1]["custom_zero"] != float64(0) || layers[1]["name"] != "subject" {
					t.Fatalf("metadata lost: %#v", layers)
				}
				var usage map[string]any
				_ = json.Unmarshal(task.Usage, &usage)
				if usage["total_tokens"] != float64(42) || task.BillingState == nil || *task.BillingState != "settled" {
					t.Fatal("usage or settlement lost")
				}
			}
		})
	}
}

func TestManagedMediaServerModelFixture(t *testing.T) {
	data, err := os.ReadFile("testdata/managed-media/models-discovery-capabilities.json")
	if err != nil {
		t.Fatal(err)
	}
	var raw struct {
		MediaProtocol MediaDiscovery `json:"media_protocol"`
		Data          []struct {
			ID      string          `json:"id"`
			Image   json.RawMessage `json:"image_capabilities"`
			Version string          `json:"image_capabilities_version"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if raw.MediaProtocol.Version != MediaProtocolVersion || len(raw.Data) != 1 || raw.Data[0].ID != "unknown-image-public-id" {
		t.Fatal("server discovery contract did not parse")
	}
	capability, ok := NormalizeCatalogImageCapability(raw.Data[0].Image)
	if !ok || raw.Data[0].Version == "" || capability["references"].(map[string]any)["maxImageBytes"] != float64(0) || len(capability["quality"].(map[string]any)["values"].([]any)) != 0 {
		t.Fatal("server zero/empty capability contract was not preserved")
	}
}

func TestManagedMediaEnterpriseHandlerCapabilityFixtures(t *testing.T) {
	paths, err := filepath.Glob("testdata/managed-media/models-enterprise-*.json")
	if err != nil || len(paths) != 4 {
		t.Fatalf("fixture count=%d err=%v", len(paths), err)
	}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var raw struct {
				Data []struct {
					Image   json.RawMessage `json:"image_capabilities"`
					Version string          `json:"image_capabilities_version"`
				} `json:"data"`
			}
			if err := json.Unmarshal(data, &raw); err != nil {
				t.Fatal(err)
			}
			if len(raw.Data) != 3 {
				t.Fatalf("models=%d", len(raw.Data))
			}
			for _, item := range raw.Data {
				capability, ok := NormalizeCatalogImageCapability(item.Image)
				if !ok || len(item.Version) != 64 || capability["references"].(map[string]any)["maxImageBytes"] != float64(0) {
					t.Fatalf("server enterprise capability lost: version=%q capability=%#v", item.Version, capability)
				}
			}
		})
	}
}
