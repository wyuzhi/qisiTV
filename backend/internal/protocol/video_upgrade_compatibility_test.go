package protocol

import (
	"context"
	"encoding/json"
	"testing"
)

// 维护升级必须继续识别旧回执；同一个协议 ID 不能代替这些回归。
func TestVideoUpgradeReadsLegacyReceipts(t *testing.T) {
	for _, id := range []string{"luma-dream-machine", "runway-video"} {
		t.Run(id, func(t *testing.T) {
			adapter := officialPackageAdapter(t, id+PluginPackageExtension, id)
			const url = "https://example.invalid/original.mp4"
			for name, fields := range map[string]map[string]any{
				"video_url":                       {"video_url": url},
				"videoUrl":                        {"videoUrl": url},
				"result_url":                      {"result_url": url},
				"url":                             {"url": url},
				"data.video_url":                  {"data": map[string]any{"video_url": url}},
				"output.url":                      {"output": map[string]any{"url": url}},
				"output metadata with legacy URL": {"output": map[string]any{"status": "done"}, "video_url": url},
			} {
				t.Run(name, func(t *testing.T) {
					fields["status"] = "completed"
					body, err := json.Marshal(fields)
					if err != nil {
						t.Fatal(err)
					}
					state, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "original"}, body)
					if err != nil || state.TaskID != "original" || state.Status != StatusSucceeded || state.Result == nil || len(state.Result.Videos) != 1 || state.Result.Videos[0].URL != url {
						t.Fatalf("legacy receipt lost: state=%+v err=%v", state, err)
					}
				})
			}
			for _, field := range []string{"fail_reason", "message", "error.message"} {
				t.Run(field, func(t *testing.T) {
					body := map[string]any{"status": "failed", field: "original failure"}
					if field == "error.message" {
						delete(body, field)
						body["error"] = map[string]any{"message": "original failure"}
					}
					raw, err := json.Marshal(body)
					if err != nil {
						t.Fatal(err)
					}
					state, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "original"}, raw)
					if err != nil || state.Status != StatusFailed || state.Message != "original failure" {
						t.Fatalf("legacy error lost: state=%+v err=%v", state, err)
					}
				})
			}
			state, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "original"}, []byte(`{"status":"completed","output":{"status":"done"}}`))
			if err != nil || state.Result != nil {
				t.Fatalf("missing media became a result: %+v %v", state, err)
			}
		})
	}
}
