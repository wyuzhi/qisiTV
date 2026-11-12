package canvasworkflow

import (
	"encoding/json"
	"testing"
)

// Workflows saved before v2.2.0 recorded the official channel as "@beefapi".
// They must keep running on the official channel and show its models.
func TestWorkflowsSavedUnderTheFormerOfficialIDStayOfficial(t *testing.T) {
	for _, id := range []string{"@beeftv", "@beefapi"} {
		if !IsOfficialWorkflowChannel(id) {
			t.Fatalf("%s is not treated as the official channel", id)
		}
	}
	for _, id := range []string{"", "beeftv", "beefapi", "channel-2", "@channel-2"} {
		if IsOfficialWorkflowChannel(id) {
			t.Fatalf("%q is treated as the official channel", id)
		}
	}
}

// Describe and upscale steps saved before the rename store the official
// channel in the node config; decoding the saved definition reads it as the
// current official channel. User channels are untouched.
func TestSavedWorkflowNodesUnderTheFormerOfficialIDReadAsOfficial(t *testing.T) {
	var d Definition
	raw := `{"nodes":[
		{"id":"describe","config":{"modelOption":"beefapi::vision-x"}},
		{"id":"upscale","config":{"channelId":"beefapi","preset":"image|m"}},
		{"id":"own","config":{"modelOption":"channel-2::vision-x","channelId":"channel-2"}}
	]}`
	if err := json.Unmarshal([]byte(raw), &d); err != nil {
		t.Fatal(err)
	}
	if got := d.Nodes[0].Config["modelOption"]; got != "beeftv::vision-x" {
		t.Fatalf("describe modelOption = %v", got)
	}
	if got := d.Nodes[1].Config["channelId"]; got != "beeftv" {
		t.Fatalf("upscale channelId = %v", got)
	}
	if d.Nodes[2].Config["modelOption"] != "channel-2::vision-x" || d.Nodes[2].Config["channelId"] != "channel-2" {
		t.Fatalf("user channel node changed: %#v", d.Nodes[2].Config)
	}
	if request, _ := UpscaleRequest(d.Nodes[1]); request.ChannelID != "beeftv" {
		t.Fatalf("upscale request channel = %q", request.ChannelID)
	}
}
