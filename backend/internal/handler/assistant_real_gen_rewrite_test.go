package handler

import (
	"encoding/json"
	"testing"
)

func TestE2EGenerationUpstreamResponseURLRewrite(t *testing.T) {
	body := []byte(`{
		"id":"t1",
		"url":"https://enterprise.example/v1/videos/t1/content?signature=browser",
		"video_url":"https://enterprise.example/v1/videos/t1/content",
		"metadata":{"url":"HTTPS://ENTERPRISE.EXAMPLE/v1/videos/t1/content"},
		"cdn":"https://cdn.example/v1/videos/t1/content",
		"relative":"/v1/videos/t1/content"
	}`)
	rewritten := rewriteUpstreamResponseURLs(body, "https://enterprise.example/v1", "http://127.0.0.1:1234")
	var value map[string]any
	if err := json.Unmarshal(rewritten, &value); err != nil {
		t.Fatal(err)
	}
	if value["url"] != "http://127.0.0.1:1234/v1/videos/t1/content?signature=browser" {
		t.Fatalf("url 未改写: %v", value["url"])
	}
	if value["video_url"] != "http://127.0.0.1:1234/v1/videos/t1/content" {
		t.Fatalf("video_url 未改写: %v", value["video_url"])
	}
	metadata := value["metadata"].(map[string]any)
	if metadata["url"] != "http://127.0.0.1:1234/v1/videos/t1/content" {
		t.Fatalf("metadata.url 未改写: %v", metadata["url"])
	}
	if value["cdn"] != "https://cdn.example/v1/videos/t1/content" {
		t.Fatalf("其他域名被误改: %v", value["cdn"])
	}
	if value["relative"] != "/v1/videos/t1/content" {
		t.Fatalf("相对地址被误改: %v", value["relative"])
	}
	if string(rewriteUpstreamResponseURLs(body, "", "http://127.0.0.1:1234")) != string(body) {
		t.Fatal("没有上游基址时不应改写")
	}
}
