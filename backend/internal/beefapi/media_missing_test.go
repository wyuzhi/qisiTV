package beefapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 查询原编号得到 404 只说明「查不到」，不能被当成「明确被拒」；提交得到的 404 才是被拒。
func TestQueryNotFoundIsMissingNotRejection(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"media_task_not_found","category":"unknown","message":"not established"}}`))
	}))
	defer server.Close()
	client := &MediaClient{BaseURL: server.URL + "/v1", APIKey: "key", AllowHTTPTest: true}
	_, err := client.Query(context.Background(), "ref-1", "image")
	if !IsMediaTaskNotFound(err) || IsDefiniteMediaRejection(err) || IsTerminalMediaTaskError(err) {
		t.Fatalf("query 404 classified wrongly: missing=%v rejected=%v terminal=%v err=%v", IsMediaTaskNotFound(err), IsDefiniteMediaRejection(err), IsTerminalMediaTaskError(err), err)
	}
	if _, err := client.Collect(context.Background(), "ref-1", "image", false); !IsMediaTaskNotFound(err) {
		t.Fatalf("collect did not stop on a missing submission: %v", err)
	}
	submitErr := &MediaHTTPError{StatusCode: http.StatusNotFound}
	if !IsDefiniteMediaRejection(submitErr) || IsMediaTaskNotFound(submitErr) {
		t.Fatal("submit 404 must stay a definite rejection")
	}
}
