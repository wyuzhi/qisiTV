package handler

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestExternalModelConfigRedactionRoundTripAndCAS(t *testing.T) {
	router, store := newModelConfigTestRouter(t)
	call := func(method string, body any) *httptest.ResponseRecorder {
		data, _ := json.Marshal(body)
		r := httptest.NewRequest(method, "/api/workspace/model-config", bytes.NewReader(data))
		r.Header.Set("Content-Type", "application/json")
		r = WithExternalBusinessPrincipal(r, false)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	config := map[string]any{"channels": []any{map[string]any{"id": "custom", "name": "Custom", "baseUrl": "https://example.invalid/v1", "apiKey": "test-custom-key", "secretKey": "test-custom-secret", "headers": map[string]any{"Authorization": "Bearer test-only-header"}, "enabled": true}}}
	first := call("PUT", map[string]any{"config": config, "expectedRevision": 0})
	if first.Code != 200 {
		t.Fatal(first.Code, first.Body.String())
	}
	get := call("GET", nil)
	if get.Code != 200 {
		t.Fatal(get.Code, get.Body.String())
	}
	for _, s := range []string{"test-custom-key", "test-custom-secret", "test-only-header"} {
		if bytes.Contains(get.Body.Bytes(), []byte(s)) {
			t.Fatal("custom credential leaked")
		}
	}
	redacted := modelConfigResponseData(t, get)
	// 前端要靠这两个标记区分「没填」和「已保存但不返回」；缺失就会把可用连接拦下来。
	marked := channelByID(t, redacted["config"], "custom")
	if marked["hasApiKey"] != true || marked["hasSecretKey"] != true {
		t.Fatalf("custom credential state missing: %#v", marked)
	}
	roundTrip := call("PUT", map[string]any{"config": redacted["config"], "expectedRevision": redacted["revision"]})
	if roundTrip.Code != 200 {
		t.Fatal(roundTrip.Code, roundTrip.Body.String())
	}
	stored, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	channels := stored.Config["channels"].([]any)
	found := false
	for _, value := range channels {
		channel := value.(map[string]any)
		if channel["id"] == "custom" {
			found = true
			if channel["apiKey"] != "test-custom-key" || channel["secretKey"] != "test-custom-secret" {
				t.Fatal("redacted roundtrip erased credentials")
			}
			// 回读标记只对客户端有意义，落到存储里会在密钥被清除后继续骗人。
			if _, ok := channel["hasApiKey"]; ok {
				t.Fatalf("credential state leaked into storage: %#v", channel)
			}
			if _, ok := channel["hasSecretKey"]; ok {
				t.Fatalf("credential state leaked into storage: %#v", channel)
			}
		}
	}
	if !found {
		t.Fatal("custom channel removed")
	}
	if stale := call("PUT", map[string]any{"config": redacted["config"], "expectedRevision": 0}); stale.Code != 409 {
		t.Fatal("stale external configuration accepted", stale.Code)
	}
	if noCAS := call("PUT", map[string]any{"config": redacted["config"]}); noCAS.Code != 400 {
		t.Fatal("external configuration bypassed CAS")
	}
}

func TestExternalModelConfigReportsWhichCredentialsExist(t *testing.T) {
	router, _ := newModelConfigTestRouter(t)
	call := func(method string, body any) *httptest.ResponseRecorder {
		data, _ := json.Marshal(body)
		r := httptest.NewRequest(method, "/api/workspace/model-config", bytes.NewReader(data))
		r.Header.Set("Content-Type", "application/json")
		r = WithExternalBusinessPrincipal(r, false)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	// 只有 API Key 的连接：后端没有 SK 可以沿用，前端必须让用户补填。
	keyOnly := map[string]any{"channels": []any{
		map[string]any{"id": "custom", "name": "Custom", "baseUrl": "https://example.invalid/v1", "apiKey": "test-only-key", "secretKey": "", "enabled": true},
	}}
	if put := call("PUT", map[string]any{"config": keyOnly, "expectedRevision": 0}); put.Code != 200 {
		t.Fatal(put.Code, put.Body.String())
	}
	redacted := modelConfigResponseData(t, call("GET", nil))
	channel := channelByID(t, redacted["config"], "custom")
	if channel["hasApiKey"] != true {
		t.Fatalf("saved api key not reported: %#v", channel)
	}
	if _, ok := channel["hasSecretKey"]; ok {
		t.Fatalf("missing secret key reported as saved: %#v", channel)
	}
	if channel["apiKey"] != "" || channel["secretKey"] != "" {
		t.Fatalf("credential leaked: %#v", channel)
	}
}

func channelByID(t *testing.T, config any, id string) map[string]any {
	t.Helper()
	data, _ := config.(map[string]any)
	channels, _ := data["channels"].([]any)
	for _, raw := range channels {
		if channel, ok := raw.(map[string]any); ok && channel["id"] == id {
			return channel
		}
	}
	t.Fatalf("channel %q missing: %#v", id, channels)
	return nil
}
