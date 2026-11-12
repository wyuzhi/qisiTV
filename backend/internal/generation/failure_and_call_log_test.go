package generation

import (
	"testing"

	"qisitv/backend/internal/model"
)

func TestEnrichAPICallLogPayloadNeverTreatsTraceRequestIDOrFailedCreateAsProviderJobID(t *testing.T) {
	t.Run("HTTP 400 error payload with trace request_id keeps ProviderRequestID empty", func(t *testing.T) {
		entry := model.ApiCallLog{
			RequestKind:  "create",
			Status:       model.ApiCallStatusFailed,
			StatusCode:   400,
			ResponseBody: `{"error":{"code":"InvalidParameter","message":"invalid parameter"},"request_id":"req-trace-synthetic-1"}`,
		}
		EnrichAPICallLog(&entry, []byte(entry.ResponseBody))
		if entry.ProviderRequestID != "" {
			t.Fatalf("failed create extracted trace request_id as ProviderRequestID: %q", entry.ProviderRequestID)
		}
	})

	t.Run("HTTP 200 payload with failed status flips Status to failed and skips ProviderRequestID", func(t *testing.T) {
		entry := model.ApiCallLog{
			RequestKind:  "create",
			Status:       model.ApiCallStatusSucceeded,
			StatusCode:   200,
			ResponseBody: `{"id":"failed-job-1","status":"failed","error":{"message":"parameter rejected"},"request_id":"req-trace-2"}`,
		}
		EnrichAPICallLog(&entry, []byte(entry.ResponseBody))
		if entry.Status != model.ApiCallStatusFailed || entry.ProviderRequestID != "" {
			t.Fatalf("unexpected entry after failed payload: status=%q providerRequestID=%q", entry.Status, entry.ProviderRequestID)
		}
	})

	t.Run("accepted async create extracts data.task_id while ignoring trace request_id", func(t *testing.T) {
		entry := model.ApiCallLog{
			RequestKind:  "create",
			Status:       model.ApiCallStatusSucceeded,
			StatusCode:   200,
			ResponseBody: `{"code":"success","data":{"task_id":"task-async-accepted-1"},"request_id":"req-trace-3"}`,
		}
		EnrichAPICallLog(&entry, []byte(entry.ResponseBody))
		if entry.ProviderRequestID != "task-async-accepted-1" {
			t.Fatalf("ProviderRequestID = %q, want task-async-accepted-1", entry.ProviderRequestID)
		}
	})

	t.Run("xai-style video create path /v1/videos/generations extracts request_id on success and stays empty on failure", func(t *testing.T) {
		okEntry := model.ApiCallLog{
			RequestKind:  "create",
			Capability:   "video",
			Path:         "/v1/videos/generations",
			Status:       model.ApiCallStatusSucceeded,
			StatusCode:   200,
			ResponseBody: `{"request_id":"xai-video-job-123"}`,
		}
		EnrichAPICallLog(&okEntry, []byte(okEntry.ResponseBody))
		if okEntry.ProviderRequestID != "xai-video-job-123" {
			t.Fatalf("ProviderRequestID = %q, want xai-video-job-123", okEntry.ProviderRequestID)
		}

		failEntry := model.ApiCallLog{
			RequestKind:  "create",
			Capability:   "video",
			Path:         "/v1/videos/generations",
			Status:       model.ApiCallStatusFailed,
			StatusCode:   400,
			ResponseBody: `{"error":{"code":"invalid_request","message":"invalid duration"},"request_id":"req-trace-400"}`,
		}
		EnrichAPICallLog(&failEntry, []byte(failEntry.ResponseBody))
		if failEntry.ProviderRequestID != "" {
			t.Fatalf("failed create on /v1/videos/generations polluted ProviderRequestID: %q", failEntry.ProviderRequestID)
		}
	})

	t.Run("explicit job ID in failed create without error.code stays recoverable and is not misclassified as rejected_no_job", func(t *testing.T) {
		body := []byte(`{"status":"failed","task_id":"job-accepted-1","message":"invalid parameter"}`)
		explicitID, err := extractExplicitProviderJobID(body)
		if err != nil || explicitID != "job-accepted-1" {
			t.Fatalf("extractExplicitProviderJobID = %q, err=%v", explicitID, err)
		}
		resultErr := ProtocolResultError("invalid parameter", explicitID, body)
		if DefiniteImageInputRejection(resultErr) {
			t.Fatalf("failed create with accepted task_id must not be DefiniteImageInputRejection: %v", resultErr)
		}
	})
}
