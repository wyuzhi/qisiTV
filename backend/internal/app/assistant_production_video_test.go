package app

import (
	"testing"

	"infinite-canvas/backend/internal/operations"
)

// 节点上确认过的视频参数必须原样进入生成配置：分辨率不能丢，显式 false 的声音也不能变成空值。
func TestAssistantProductionVideoConfigKeepsResolutionAndAudio(t *testing.T) {
	svc, _, _ := newAssistantTurnService(t)
	if err := svc.SaveLocalModelConfig([]byte(`{"videoModel":"custom::video-model","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["video-model"],"modelProfiles":[{"model":"video-model","capability":"video","protocol":"seedance-videos-compatible"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	options := map[string]string{"size": "9:16", "seconds": "5", "vquality": "720p", "generateAudio": "false"}
	config, err := svc.assistantGenerationConfig(operations.GenerationTarget{Kind: "video", ModelKey: "custom::video-model", Parameters: options})
	if err != nil {
		t.Fatal(err)
	}
	for parameter, key := range map[string]string{"size": "size", "seconds": "videoSeconds", "vquality": "vquality", "generateAudio": "videoGenerateAudio"} {
		if config[key] != options[parameter] {
			t.Fatalf("confirmed video setting %s lost before generation: %+v", parameter, config)
		}
	}
	if config["model"] != "video-model" || config["interfaceType"] != "seedance-videos-compatible" {
		t.Fatalf("video model/protocol changed: %+v", config)
	}
}
