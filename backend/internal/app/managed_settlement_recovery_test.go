package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"qisitv/backend/internal/beefapi"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

func TestManagedFailedImagePendingBillingKeepsQueryingUntilRefunded(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, pending := range []string{"reserved", "precharged"} {
		t.Run(pending, func(t *testing.T) {
			svc, db, task, row, _ := imageSubmissionFixture(t, false)
			noResult := localtask.RecoveryNoResult
			task.Status, task.RecoveryOutcome, task.BeefBillingState = model.TaskStatusFailed, &noResult, &pending
			task.InputJSON = `{"mode":"image","config":{"credentialRef":"beefapi-enterprise"}}`
			if err := db.Save(&task).Error; err != nil {
				t.Fatal(err)
			}
			var refunded atomic.Bool
			var gets, posts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					posts.Add(1)
					http.Error(w, "no create", 500)
					return
				}
				gets.Add(1)
				billing := pending
				if refunded.Load() {
					billing = "refunded"
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"task_ref": r.URL.Path[len("/v1/media/tasks/"):], "media_type": "image", "status": "failed", "outputs": []any{}, "billing_state": billing})
			}))
			defer server.Close()
			wire, _ := svc.imageSubmissionWire(row)
			wire.URL, wire.ReplayProtocol, wire.MediaType, wire.ChannelID = server.URL+"/v1/media/tasks", beefapi.MediaProtocolVersion, "image", beefapi.ChannelID
			row.QueryCipher, _ = svc.managedImageQueryCipher(task, wire)
			row.SendCount = 1
			if err := db.Save(row).Error; err != nil {
				t.Fatal(err)
			}
			ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: server.URL})
			candidates, err := svc.repo.FailedImagesForRecovery("", 8)
			if err != nil || len(candidates) != 1 {
				t.Fatalf("pending task omitted: %d %v", len(candidates), err)
			}
			if err := svc.recoverFailedImage(ctx, task); err != nil {
				t.Fatal(err)
			}
			latest, _ := svc.repo.Task(task.ID)
			if latest.NextPollAt == nil || !latest.MediaSettlementPending() || localtask.ComputeOutcome(*latest, "", localtask.OutcomeFacts{}).Regenerate != "blocked" {
				t.Fatal("pending reserve stopped polling or unlocked")
			}
			refunded.Store(true)
			if err := svc.recoverFailedImage(ctx, *latest); err != nil {
				t.Fatal(err)
			}
			latest, _ = svc.repo.Task(task.ID)
			if latest.NextPollAt != nil || latest.BeefBillingState == nil || *latest.BeefBillingState != "refunded" || localtask.ComputeOutcome(*latest, "", localtask.OutcomeFacts{}).Regenerate != "allowed" || gets.Load() != 2 || posts.Load() != 0 {
				t.Fatalf("refund not converged: task=%+v gets=%d posts=%d", latest, gets.Load(), posts.Load())
			}
		})
	}
}
