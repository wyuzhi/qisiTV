package generation

import (
	"context"
	"testing"

	"infinite-canvas/backend/internal/providerpreset"
)

func TestDomesticGatewayVideoContractDoesNotGrantHostedCredentials(t *testing.T) {
	for _, base := range []string{"https://beeftv.app", "https://beeftv.app/v1"} {
		if !IsBeefTVVideoConfig(context.Background(), Config{BaseURL: base}) {
			t.Fatalf("official video gateway rejected: %s", base)
		}
		if !providerpreset.IsBeefTVEndpoint(base) {
			t.Fatalf("official endpoint rejected: %s", base)
		}
	}
	for _, base := range []string{"https://legacy.example.com/v1", "https://LEGACY.EXAMPLE.COM:443/v1", "https://legacy-enterprise.example.com/v1", "http://beeftv.app/v1", "https://beeftv.app.attacker.test/v1", "https://attacker.test/beeftv.app", "https://user@beeftv.app/v1", "https://beeftv.app:444/v1"} {
		if IsBeefTVVideoConfig(context.Background(), Config{BaseURL: base}) {
			t.Fatalf("unexpected video gateway: %s", base)
		}
		if providerpreset.IsBeefTVEndpoint(base) {
			t.Fatalf("unexpected hosted-account endpoint: %s", base)
		}
	}
	input := Input{Prompt: "change the ball", Config: Config{BaseURL: "https://beeftv.app/v1", InterfaceType: "newapi", Model: "seedance-2.5", VideoSeconds: "4", VQuality: "480", Size: "16:9", VideoGenerateAudio: "false", VideoWatermark: "false"}, Metadata: map[string]any{"videoEditOperation": "inpaint"}, ReferenceVideos: []Media{{URL: "https://example.com/ref.mp4"}}}
	body, err := BeefTVVideoRequestBody(input)
	if err != nil {
		t.Fatal(err)
	}
	meta := body["metadata"].(map[string]interface{})
	content := body["content"].([]map[string]interface{})
	if len(content) != 1 || content[0]["type"] != "video_url" || content[0]["role"] != "reference_video" || body["seconds"] != "4" || body["aspect_ratio"] != "16:9" || meta["operation"] != "inpaint" || meta["generate_audio"] != false || meta["watermark"] != false {
		t.Fatalf("edit controls were lost: %#v", body)
	}
}

func TestBeefTVTextVideoPreservesWatermarkSwitch(t *testing.T) {
	for _, enabled := range []string{"true", "false"} {
		body, err := BeefTVVideoRequestBody(Input{Config: Config{Model: "seedance-2.5", VideoSeconds: "4", VQuality: "480", Size: "16:9", VideoWatermark: enabled}})
		if err != nil {
			t.Fatal(err)
		}
		if body["metadata"].(map[string]any)["watermark"] != (enabled == "true") {
			t.Fatalf("watermark=%s was lost: %#v", enabled, body)
		}
	}
}
