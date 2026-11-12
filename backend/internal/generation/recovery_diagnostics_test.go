package generation

import (
	"testing"

	"qisitv/backend/internal/model"
)

func TestRecoveryDiagnosticsPreserveHTTPFailureWithoutChangingRetryPolicy(t *testing.T) {
	err := ImageRecoveryError{Cause: HTTPError{StatusCode: 503, Body: "no available server"}}
	task := &model.Task{Stage: "正在连接上游"}
	CaptureTaskFailureDiagnostics(task, err, "unknown")
	d := task.FailureDiagnostics
	if d.Source != "upstream_http" || d.HTTPStatus != 503 || d.Summary != ClassifyHTTP(503, "", "no available server").UserMessage() {
		t.Fatalf("lost underlying HTTP failure: %+v", d)
	}
	failure := ClassifyTaskFailure(err)
	if failure.Category != CategorySubmissionUncertain || !failure.Uncertain {
		t.Fatalf("diagnostics changed submission policy: %+v", failure)
	}
}
