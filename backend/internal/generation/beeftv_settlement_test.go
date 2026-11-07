package generation

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestExtractBeefAPIVideoSettlement(t *testing.T) {
	t.Parallel()
	s := ExtractBeefAPIVideoSettlementBytes([]byte(`{"id":"vid-1","status":"FAILURE","usage_state":"pending","reconcile_deadline":"2026-04-20T12:00:00Z"}`))
	if s.UsageState == nil || *s.UsageState != "pending" {
		t.Fatalf("usage_state = %v, want pending", s.UsageState)
	}
	if s.ReconcileDeadline == nil || *s.ReconcileDeadline != "2026-04-20T12:00:00Z" {
		t.Fatalf("reconcile_deadline = %v, want 2026-04-20T12:00:00Z", s.ReconcileDeadline)
	}

	nested := ExtractBeefAPIVideoSettlementBytes([]byte(`{"data":{"id":"vid-2","usage_state":"failed"}}`))
	if nested.UsageState == nil || *nested.UsageState != "failed" || nested.ReconcileDeadline != nil {
		t.Fatalf("nested settlement = %+v", nested)
	}

	missing := ExtractBeefAPIVideoSettlementBytes([]byte(`{"id":"vid-3","status":"failed"}`))
	if missing.UsageState != nil || missing.ReconcileDeadline != nil {
		t.Fatalf("missing settlement should be nil: %+v", missing)
	}
}

func TestExtractBeefAPIImageJobID(t *testing.T) {
	t.Parallel()
	headers := http.Header{}
	headers.Set("X-Image-Job-Id", "job-header-1")
	if got := ExtractBeefAPIImageJobID(headers, nil); got != "job-header-1" {
		t.Fatalf("got %q, want job-header-1", got)
	}

	locHeaders := http.Header{}
	locHeaders.Set("Location", "/v1/images/jobs/job-loc-2?foo=bar")
	if got := ExtractBeefAPIImageJobID(locHeaders, nil); got != "job-loc-2" {
		t.Fatalf("got %q, want job-loc-2", got)
	}

	if got := ExtractBeefAPIImageJobID(nil, []byte(`{"task_id":"job-body-3"}`)); got != "job-body-3" {
		t.Fatalf("got %q, want job-body-3", got)
	}

	if got := ExtractBeefAPIImageJobID(nil, []byte(`{"error":{"job_id":"job-err-4","message":"failed"}}`)); got != "job-err-4" {
		t.Fatalf("got %q, want job-err-4", got)
	}
}

func TestExtractBeefAPIImageSettlementAndQueryJob(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")

	absent := ExtractBeefAPIImageSettlement(map[string]interface{}{"id": "job-1", "status": "failed"})
	if absent.HasBillingState || absent.BillingState != nil {
		t.Fatalf("expected absent billing_state to stay nil, got %+v", absent)
	}

	empty := ExtractBeefAPIImageSettlement(map[string]interface{}{
		"id":                 "job-2",
		"billing_state":      "",
		"reconcile_deadline": "2026-04-20T12:00:00Z",
	})
	if !empty.HasBillingState || empty.BillingState == nil || *empty.BillingState != "" {
		t.Fatalf("expected empty billing_state to be preserved, got %+v", empty)
	}
	if empty.ReconcileDeadline == nil || *empty.ReconcileDeadline != "2026-04-20T12:00:00Z" {
		t.Fatalf("expected reconcile_deadline to be preserved, got %+v", empty)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/jobs/job-err-settled" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"job-err-settled","status":"failed","billing_state":"refunded","error":{"code":"upstream_failed","message":"failed"}}`))
	}))
	defer server.Close()

	settlement, _, err := QueryBeefAPIImageJob(WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: server.URL}), Config{
		BaseURL: server.URL,
		APIKey:  "test-key",
	}, "job-err-settled")
	if err != nil {
		t.Fatalf("QueryBeefAPIImageJob error: %v", err)
	}
	if !settlement.HasBillingState || settlement.BillingState == nil || *settlement.BillingState != "refunded" {
		t.Fatalf("settlement = %+v, want refunded", settlement)
	}
}
