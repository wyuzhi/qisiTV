package providerpreset

import (
	"encoding/json"
	"os"
	"testing"
)

// savedProtocolCase lists what the web client's resolveModelRequestConfig
// submits with for each saved shape, so the startup audit that keeps the plugin
// alive is checked against the same answers. When the client starts reading
// protocol_defaults.json it can run these cases too.
type savedProtocolCase struct {
	Name    string `json:"name"`
	Channel struct {
		Scope         string `json:"scope"`
		APIFormat     string `json:"apiFormat"`
		InterfaceType string `json:"interfaceType"`
	} `json:"channel"`
	Profile struct {
		Model           string `json:"model"`
		Capability      string `json:"capability"`
		Protocol        string `json:"protocol"`
		ProtocolPending bool   `json:"protocolPending"`
	} `json:"profile"`
	Want string `json:"want"`
}

func TestSavedModelProtocolMatchesSharedCases(t *testing.T) {
	body, err := os.ReadFile("testdata/saved_protocol_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []savedProtocolCase
	if err := json.Unmarshal(body, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no shared cases")
	}
	for _, item := range cases {
		t.Run(item.Name, func(t *testing.T) {
			got := SavedModelProtocol(
				SavedChannel{Scope: item.Channel.Scope, APIFormat: item.Channel.APIFormat, InterfaceType: item.Channel.InterfaceType},
				SavedModel{Model: item.Profile.Model, Capability: item.Profile.Capability, Protocol: item.Profile.Protocol, ProtocolPending: item.Profile.ProtocolPending},
			)
			if got != item.Want {
				t.Fatalf("SavedModelProtocol = %q want %q", got, item.Want)
			}
		})
	}
}

func TestInferModelCapability(t *testing.T) {
	for model, want := range map[string]string{
		"minimax-music-2.0": "audio",
		"gpt-image-3":       "image",
		"seedance-2.5":      "video",
		"gpt-4.1-mini":      "text",
		"minimax-m2":        "text",
	} {
		if got := InferModelCapability(model); got != want {
			t.Fatalf("InferModelCapability(%q) = %q want %q", model, got, want)
		}
	}
}
