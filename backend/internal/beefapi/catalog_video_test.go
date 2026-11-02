package beefapi

import (
	"encoding/json"
	"testing"
)

func TestNormalizeCatalogVideoCapabilityRejectsInvalidPayloads(t *testing.T) {
	valid := sampleCatalogVideo(t, 3, 1)
	if _, ok := NormalizeCatalogVideoCapability(valid); !ok {
		t.Fatal("valid capability rejected")
	}
	for _, raw := range []string{
		"",
		"null",
		`[]`,
		`{"operations":["text_to_video"]}`,
		`{"references":{},"duration":{"selection":"range","min":1,"max":15,"step":1,"default":6},"ratios":["16:9"],"defaultRatio":"16:9","resolutions":["720p"],"defaultResolution":"720p","generateAudio":{"supported":true},"watermark":{"supported":false,"default":false},"operations":["text_to_video"],"defaultOperation":"text_to_video"}`,
		`{"references":{"maxVideos":3.5},"duration":{"selection":"range","min":1,"max":15,"step":1,"default":6},"ratios":["16:9"],"defaultRatio":"16:9","resolutions":["720p"],"defaultResolution":"720p","generateAudio":{"supported":true,"default":true},"watermark":{"supported":false,"default":false},"operations":["text_to_video"],"defaultOperation":"text_to_video"}`,
	} {
		if _, ok := NormalizeCatalogVideoCapability(json.RawMessage(raw)); ok {
			t.Fatalf("accepted invalid payload %s", raw)
		}
	}
}

func TestNormalizeCatalogVideoCapabilityKeepsExplicitZerosAndOmitsMissing(t *testing.T) {
	video, ok := NormalizeCatalogVideoCapability(sampleCatalogVideo(t, 0, 0))
	if !ok {
		t.Fatal("explicit zeros rejected")
	}
	refs := video["references"].(map[string]any)
	if refs["maxVideos"] != 0 || refs["maxAudios"] != 0 {
		t.Fatalf("zeros rewritten: %#v", refs)
	}
	partial := json.RawMessage(`{
		"references": {"maxVideos": 0},
		"duration": {"selection": "enum", "values": [5, 10], "default": 5},
		"ratios": ["16:9"], "defaultRatio": "16:9", "resolutions": [], "defaultResolution": "",
		"generateAudio": {"supported": false, "default": false}, "watermark": {"supported": false, "default": false},
		"operations": ["text_to_video"], "defaultOperation": "text_to_video"
	}`)
	video, ok = NormalizeCatalogVideoCapability(partial)
	if !ok {
		t.Fatal("partial references rejected")
	}
	refs = video["references"].(map[string]any)
	if refs["maxVideos"] != 0 {
		t.Fatalf("maxVideos = %#v", refs["maxVideos"])
	}
	if _, present := refs["maxAudios"]; present {
		t.Fatalf("omitted maxAudios persisted as %#v", refs["maxAudios"])
	}
	if _, present := video["durationSupported"]; present {
		t.Fatal("optional durationSupported invented")
	}
	if _, valid := NormalizeVersionedVideoCapability(partial, "v1"); valid {
		t.Fatal("managed catalog must explicitly declare each reference count")
	}
}

func TestNormalizeVideoOperationReferencesPreservesZeroAndRejectsInvalid(t *testing.T) {
	var video map[string]any
	if err := json.Unmarshal(sampleCatalogVideo(t, 3, 1), &video); err != nil {
		t.Fatal(err)
	}
	video["operationReferences"] = map[string]any{"image_to_video": map[string]any{"maxImages": 2, "maxVideos": 0, "maxAudios": 0}}
	body, _ := json.Marshal(video)
	got, ok := NormalizeVersionedVideoCapability(body, "v1")
	if !ok {
		t.Fatal("valid operation limits rejected")
	}
	counts := got["operationReferences"].(map[string]any)["image_to_video"].(map[string]any)
	if counts["maxVideos"] != 0 || counts["maxImages"] != 2 {
		t.Fatal("operation limits lost")
	}
	for _, invalid := range []any{[]any{}, map[string]any{"missing_operation": map[string]any{}}, map[string]any{"image_to_video": map[string]any{"maxImages": 2.5}}, map[string]any{"image_to_video": map[string]any{"minImages": 3, "maxImages": 2}}} {
		video["operationReferences"] = invalid
		body, _ := json.Marshal(video)
		if _, ok := NormalizeVersionedVideoCapability(body, "v2"); ok {
			t.Fatalf("invalid operation limits accepted: %s", body)
		}
	}
}
