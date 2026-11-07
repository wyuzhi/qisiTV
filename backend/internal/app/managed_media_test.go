package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func TestManagedImageOldLocalConclusionMustBeCheckedWithAPI(t *testing.T) {
	for _, state := range []string{"failed", "404", "identity-missing"} {
		t.Run(state, func(t *testing.T) {
			svc, db, task, row, _ := imageSubmissionFixture(t, false)
			task.Status, task.InputJSON = model.TaskStatusFailed, `{"config":{"channelId":"beeftv","credentialRef":"beeftv"}}`
			old := localtask.RecoveryUnrecoverable
			task.RecoveryOutcome = &old
			if err := db.Save(&task).Error; err != nil {
				t.Fatal(err)
			}
			attempt, _ := svc.repo.LatestRouteAttempt(task.ID)
			attempt.ChannelID = beefapi.ChannelID
			if err := svc.repo.SaveRouteAttempt(attempt); err != nil {
				t.Fatal(err)
			}
			posts, gets := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					posts++
					w.WriteHeader(500)
					return
				}
				gets++
				if state == "404" {
					http.NotFound(w, r)
					return
				}
				ref := strings.TrimPrefix(r.URL.Path, "/v1/media/tasks/")
				_ = json.NewEncoder(w).Encode(map[string]any{"task_ref": ref, "media_type": "image", "task_id": "original-job", "status": "failed", "outputs": []any{}, "billing_state": "settled", "error": map[string]any{"code": "provider_failed", "category": "async_failed", "message": "original task failed"}})
			}))
			defer server.Close()
			wire, _ := svc.imageSubmissionWire(row)
			wire.URL, wire.ChannelID = server.URL+"/v1/images/generations", beefapi.ChannelID
			row.QueryCipher, _ = svc.managedImageQueryCipher(task, wire)
			row.RequestCipher, row.SendCount = "", 1
			if state == "identity-missing" {
				row.QueryCipher = ""
			}
			if err := db.Save(row).Error; err != nil {
				t.Fatal(err)
			}
			candidates, err := svc.repo.FailedImagesForRecovery("", 8)
			if err != nil || len(candidates) != 1 {
				t.Fatalf("old managed task omitted: %v %d", err, len(candidates))
			}
			ctx, cancel := context.WithTimeout(generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: server.URL}), 100*time.Millisecond)
			defer cancel()
			err = svc.recoverFailedImage(ctx, task)
			latest, _ := svc.repo.Task(task.ID)
			if posts != 0 {
				t.Fatal("recovery created a new task")
			}
			if state == "failed" {
				if err != nil || gets != 1 || latest.RecoveryOutcome == nil || *latest.RecoveryOutcome != localtask.RecoveryNoResult || latest.BeefBillingState == nil || *latest.BeefBillingState != "settled" {
					t.Fatalf("API failure not retained: err=%v gets=%d task=%+v", err, gets, latest)
				}
			} else if state == "404" {
				// 原请求已过保存期，用原 Key 仍查不到原编号：既不能补交也无法确认，
				// 结论为「无法取回」（重新生成前确认），并留出间隔继续向 BeefAPI 复查。
				if gets == 0 || latest.RecoveryOutcome == nil || *latest.RecoveryOutcome != localtask.RecoveryUnrecoverable || latest.NextPollAt == nil || time.Until(*latest.NextPollAt) < 30*time.Minute {
					t.Fatalf("missing expired submission not concluded: err=%v gets=%d task=%+v", err, gets, latest)
				}
			} else if err == nil || latest.RecoveryOutcome != nil || latest.NextPollAt == nil {
				t.Fatalf("unknown task retained local terminal conclusion: err=%v task=%+v", err, latest)
			}
		})
	}
}

func TestManagedImageManualAndCredentialOnlyOldConclusionQueriesOriginalTask(t *testing.T) {
	for _, mode := range []string{"manual", "credential-only-scan", "third-party-same-host"} {
		t.Run(mode, func(t *testing.T) {
			svc, db, task, row, _ := imageSubmissionFixture(t, false)
			task.Status, task.InputJSON = model.TaskStatusFailed, `{"config":{"credentialRef":"beeftv"}}`
			if mode == "third-party-same-host" {
				task.InputJSON = `{"config":{"baseUrl":"https://beeftv.app","apiKey":"third-party"}}`
			}
			old := localtask.RecoveryUnrecoverable
			task.RecoveryOutcome = &old
			if err := db.Save(&task).Error; err != nil {
				t.Fatal(err)
			}
			attempt, _ := svc.repo.LatestRouteAttempt(task.ID)
			attempt.ChannelID = ""
			if err := svc.repo.SaveRouteAttempt(attempt); err != nil {
				t.Fatal(err)
			}
			gets, posts := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					posts++
					w.WriteHeader(500)
					return
				}
				gets++
				ref := strings.TrimPrefix(r.URL.Path, "/v1/media/tasks/")
				_ = json.NewEncoder(w).Encode(map[string]any{"task_ref": ref, "media_type": "image", "task_id": "historical-job", "status": "failed", "outputs": []any{}, "billing_state": "refunded"})
			}))
			defer server.Close()
			wire, _ := svc.imageSubmissionWire(row)
			wire.URL, wire.ChannelID = server.URL+"/v1/images/generations", ""
			raw, _ := json.Marshal(wire)
			row.RequestCipher, _ = svc.encryptSettingSecret(string(raw))
			row.QueryCipher, row.SendCount = "", 1
			if mode == "third-party-same-host" {
				row.QueryCipher, _ = svc.managedImageQueryCipher(task, wire)
			}
			if err := db.Save(row).Error; err != nil {
				t.Fatal(err)
			}
			ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: server.URL})
			if mode == "credential-only-scan" {
				if err := svc.recoverFailedImages(ctx, 8); err != nil {
					t.Fatal(err)
				}
			} else if _, err := svc.recoverFailedImageForUser(ctx, task.UserID, task.ID); err != nil {
				t.Fatal(err)
			}
			latest, _ := svc.repo.Task(task.ID)
			if posts != 0 {
				t.Fatal("recovery submitted a generation")
			}
			if mode == "third-party-same-host" {
				if gets != 0 || latest.RecoveryOutcome == nil || *latest.RecoveryOutcome != old {
					t.Fatalf("third-party task adopted as managed: gets=%d task=%+v", gets, latest)
				}
			} else if gets != 1 || latest.RecoveryOutcome == nil || *latest.RecoveryOutcome != localtask.RecoveryNoResult || latest.BeefBillingState == nil || *latest.BeefBillingState != "refunded" {
				t.Fatalf("original query lost: gets=%d task=%+v", gets, latest)
			}
		})
	}
}

func TestManagedImageExpiredRequestKeepsOnlySmallQueryIdentity(t *testing.T) {
	for _, mode := range []string{"new-protocol", "legacy-wire", "already-missing"} {
		t.Run(mode, func(t *testing.T) {
			svc, db, task, row, _ := imageSubmissionFixture(t, false)
			task.InputJSON = `{"mode":"image","config":{"channelId":"beeftv"}}`
			if err := db.Save(&task).Error; err != nil {
				t.Fatal(err)
			}
			wire, _ := svc.imageSubmissionWire(row)
			gets, posts := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					posts++
					w.WriteHeader(500)
					return
				}
				gets++
				ref := strings.TrimPrefix(r.URL.Path, "/v1/media/tasks/")
				_ = json.NewEncoder(w).Encode(beefapi.MediaTask{TaskRef: ref, MediaType: "image", Status: "completed", Outputs: []beefapi.MediaOutput{{Kind: "image", URL: "https://127.0.0.1/image.png"}}})
			}))
			defer server.Close()
			wire.URL, wire.ChannelID = server.URL+"/v1/images/generations", beefapi.ChannelID
			wire.Body = []byte(strings.Repeat("large-original-media", 1<<18))
			if mode == "new-protocol" {
				wire.URL, wire.ReplayProtocol = server.URL+"/v1/media/tasks", beefapi.MediaProtocolVersion
			}
			raw, _ := json.Marshal(wire)
			row.RequestCipher, _ = svc.encryptSettingSecret(string(raw))
			row.QueryCipher, row.CreatedAt, row.SendCount = "", time.Now().Add(-48*time.Hour), 1
			if mode == "new-protocol" {
				row.QueryCipher, _ = svc.managedImageQueryCipher(task, wire)
			}
			if mode == "already-missing" {
				row.RequestCipher = ""
			}
			if err := db.Save(row).Error; err != nil {
				t.Fatal(err)
			}
			if err := svc.expireImageSubmissionRequests(); err != nil {
				t.Fatal(err)
			}
			row, _ = svc.repo.ImageSubmission(row.AttemptID, task.ID, task.UserID)
			if row.RequestCipher != "" || row.SendCount != 1 {
				t.Fatal("large request/send fence changed")
			}
			if mode != "already-missing" {
				plain, err := svc.decryptSettingSecret(row.QueryCipher)
				if err != nil || len(plain) > 4096 || strings.Contains(plain, "large-original-media") {
					t.Fatalf("query retained body: len=%d err=%v", len(plain), err)
				}
			}
			ctx, cancel := context.WithTimeout(generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: server.URL}), time.Second)
			defer cancel()
			result, handled, err := svc.collectManagedImage(ctx, task, row)
			if !handled || posts != 0 {
				t.Fatal("managed request fell through to resend")
			}
			if mode == "already-missing" {
				if err == nil || gets != 0 {
					t.Fatal("missing identity invented a result")
				}
			} else if err != nil || result == nil || gets != 1 {
				t.Fatalf("GET recovery failed: %v gets=%d", err, gets)
			}
		})
	}
}

func TestManagedRouteRestartCannotCreateReplacementAttempt(t *testing.T) {
	for _, media := range []string{"canvas_image", "canvas_video", "canvas_audio"} {
		svc, db, task, _, _ := imageSubmissionFixture(t, false)
		task.Type, task.LogicalModelID, task.InputJSON = media, "logical-fixture", `{"config":{"channelId":"beeftv"}}`
		if err := db.Save(&task).Error; err != nil {
			t.Fatal(err)
		}
		attempt, _ := svc.repo.LatestRouteAttempt(task.ID)
		attempt.DispatchState = "rejected_no_job"
		if err := svc.repo.SaveRouteAttempt(attempt); err != nil {
			t.Fatal(err)
		}
		if next, err := svc.beginTaskRouteAttempt(&task); next != nil || err == nil {
			t.Fatalf("%s created replacement: %+v %v", media, next, err)
		}
		all, _ := svc.repo.RouteAttempts(task.ID, task.RouteRun)
		if len(all) != 1 {
			t.Fatal("new attempt persisted")
		}
	}
}

func TestManagedImageDeliveryKeepsPublicPolicyAfterInputRedaction(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	svc, db, _, _ := creationTestService(t)
	for _, managed := range []bool{true, false} {
		id := "byok-delivery"
		ref := ""
		if managed {
			id, ref = "managed-delivery", beefapi.CredentialRef
		}
		input, _ := json.Marshal(map[string]any{"mode": "image", "config": map[string]any{"credentialRef": ref, "apiKey": "original-secret", "baseUrl": "https://127.0.0.1", "interfaceType": "openai-image", "headers": []any{map[string]any{"name": "X-Private", "value": "provider-secret"}}}})
		task := model.Task{ID: id, UserID: "user", Type: "canvas_image", Status: model.TaskStatusSucceeded, InputJSON: string(input)}
		redacted, err := svc.completionInputJSON(task, []byte(`{"images":[{"url":"https://127.0.0.1/image.png"}]}`))
		if err != nil {
			t.Fatal(err)
		}
		task.InputJSON = redacted
		if err := db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
		adapter := generationDeliveryMediaAdapter{service: svc}
		got, err := adapter.managedArtifact(task.UserID, task.ID+":0")
		if err != nil || got != managed {
			t.Fatalf("redacted managed=%v err=%v", got, err)
		}
		headers, err := adapter.imageDownloadHeaders(task.UserID, task.ID+":0", "image", "https://127.0.0.1/image.png")
		if err != nil || managed && len(headers) != 0 || !managed && headers.Get("Authorization") != "Bearer original-secret" {
			t.Fatalf("headers policy: managed=%v headers=%v err=%v", managed, headers, err)
		}
		if managed {
			if _, _, _, _, _, _, _, err := adapter.decodeGenerationArtifact(task.UserID, task.ID+":0", "image", "https://127.0.0.1/image.png"); err == nil {
				t.Fatal("redacted managed delivery allowed private storage")
			}
		}
	}
}

func TestManagedMediaSQLiteRestartQueriesOriginalAttemptOnly(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, mode := range []string{"429", "lost-response"} {
		t.Run(mode, func(t *testing.T) {
			var ready atomic.Bool
			var posts, gets, models atomic.Int32
			firstCtx, cancelFirst := context.WithCancel(context.Background())
			defer cancelFirst()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/v1/models":
					models.Add(1)
					w.Header().Set(beefapi.MediaProtocolHeader, beefapi.MediaProtocolVersion)
					_ = json.NewEncoder(w).Encode(map[string]any{"media_protocol": beefapi.MediaDiscovery{Version: beefapi.MediaProtocolVersion, SupportedMediaTypes: []string{"image"}, TaskSubmitURL: "/v1/media/tasks", TaskQueryURLTemplate: "/v1/media/tasks/{task_ref}", UploadsURL: "/v1/media/uploads"}})
				case r.Method == http.MethodPost && r.URL.Path == "/v1/media/tasks":
					posts.Add(1)
					if mode == "lost-response" {
						conn, _, _ := w.(http.Hijacker).Hijack()
						_ = conn.Close()
						return
					}
					w.WriteHeader(http.StatusTooManyRequests)
				case r.Method == http.MethodGet:
					gets.Add(1)
					if !ready.Load() {
						http.NotFound(w, r)
						cancelFirst()
						return
					}
					ref := r.URL.Path[len("/v1/media/tasks/"):]
					_ = json.NewEncoder(w).Encode(map[string]any{"task_ref": ref, "media_type": "image", "status": "completed", "outputs": []any{map[string]any{"kind": "image", "url": "https://127.0.0.1/result.png", "metadata": map[string]any{"name": "kept", "z_index": 1}}}, "usage": map[string]any{"tokens": 8}, "billing_state": "settled"})
				default:
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
				}
			}))
			defer server.Close()
			path, dataDir := filepath.Join(t.TempDir(), "workspace.db"), t.TempDir()
			svc, db := newManagedImageDirectService(t, path, dataDir)
			input := generation.Input{Mode: "image", Prompt: "fixture", Config: generation.Config{CredentialRef: beefapi.CredentialRef, APIKey: "fixture", BaseURL: server.URL, Model: "unlisted-future-model", InterfaceType: "unlisted-future-protocol"}}
			body, _ := json.Marshal(input)
			task := model.Task{ID: "restart-task", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusRunning, LeaseOwner: "owner", InputJSON: string(body)}
			expires := time.Now().Add(time.Hour)
			task.LeaseExpiresAt = &expires
			attempt := &model.RouteAttempt{ID: "restart-attempt", TaskID: task.ID, ChannelID: beefapi.ChannelID, Status: "dispatching", DispatchState: "submission_unknown", StartedAt: time.Now()}
			for _, row := range []any{&task, attempt} {
				if err := db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			bind := func(ctx context.Context) context.Context {
				ctx = generation.WithEndpoints(ctx, generation.Endpoints{BeefAPIVideoBaseURL: server.URL})
				ctx = svc.bindGenerationRuntime(ctx, generation.CallMeta{UserID: task.UserID, TaskID: task.ID, TaskType: task.Type})
				return context.WithValue(withProviderSubmissionKey(ctx, attempt), imageTaskContext{}, task)
			}
			_, err := generation.Execute(bind(firstCtx), input)
			if err == nil || posts.Load() != 1 {
				t.Fatalf("first create err=%v posts=%d", err, posts.Load())
			}
			row, err := svc.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
			if err != nil || row.SendCount != 1 {
				t.Fatalf("send fence=%+v err=%v", row, err)
			}
			closeDB(t, db)
			svc, db = newManagedImageDirectService(t, path, dataDir)
			defer closeDB(t, db)
			ready.Store(true)
			ctx, cancel := context.WithTimeout(bind(context.Background()), time.Second)
			defer cancel()
			result, handled, err := svc.recoverImageSubmission(ctx, task)
			if err != nil || !handled || result == nil || posts.Load() != 1 || models.Load() != 1 {
				t.Fatalf("restart err=%v handled=%v posts=%d models=%d", err, handled, posts.Load(), models.Load())
			}
			stored, _ := svc.repo.Task(task.ID)
			if stored.BeefBillingState == nil || *stored.BeefBillingState != "settled" {
				t.Fatal("settlement lost after restart")
			}
			attempt.DispatchState = "rejected_no_job"
			if err := svc.repo.SaveRouteAttempt(attempt); err != nil {
				t.Fatal(err)
			}
			if next, err := svc.retryRejectedImageAttempt(&task, attempt, providerHTTPError{StatusCode: 429, Body: `{"error":{"code":"rate_limit_exceeded"}}`}); err != nil || next != nil {
				t.Fatal("managed throttle created a replacement attempt")
			}
			t.Logf("post_count=%d query_count=%d models_count=%d persisted_send_count=%d", posts.Load(), gets.Load(), models.Load(), row.SendCount)
		})
	}
}

func TestManagedLegacyFrozenImageRecoveryOnlyGET(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	svc, _, task, row, _ := imageSubmissionFixture(t, false)
	wire, err := svc.imageSubmissionWire(row)
	if err != nil {
		t.Fatal(err)
	}
	ref := wire.Header.Get("Idempotency-Key")
	posts, gets := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			posts++
			t.Error("legacy recovery attempted mutation")
			w.WriteHeader(500)
			return
		}
		gets++
		if r.URL.Path != "/v1/media/tasks/"+ref {
			t.Error("legacy key changed")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"task_ref": ref, "media_type": "image", "status": "completed", "outputs": []any{map[string]any{"kind": "image", "url": "https://127.0.0.1/image.png", "metadata": map[string]any{"z_index": 4, "name": "original"}}}, "usage": map[string]any{"count": 1}})
	}))
	defer server.Close()
	wire.URL = server.URL + "/v1/images/generations"
	wire.ChannelID = ""
	protected := map[string]any{"mode": "image", "config": map[string]any{"credentialRef": beefapi.CredentialRef, "apiKey": "sensitive-fixture", "headers": []any{map[string]any{"name": "X-Private", "value": "sensitive-header"}}}}
	if err := svc.protectTaskSecrets(protected); err != nil {
		t.Fatal(err)
	}
	inputBytes, _ := json.Marshal(protected)
	task.InputJSON = string(inputBytes)
	raw, _ := json.Marshal(wire)
	row.RequestCipher, err = svc.encryptSettingSecret(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.DB().Save(row).Error; err != nil {
		t.Fatal(err)
	}
	ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: server.URL})
	ctx = context.WithValue(withProviderAnalytics(ctx, svc, task), imageTaskContext{}, task)
	result, handled, err := svc.collectManagedImage(ctx, task, row)
	if err != nil || !handled || posts != 0 || gets != 1 || result["imageLayers"].([]map[string]any)[0]["name"] != "original" {
		t.Fatalf("err=%v handled=%v posts=%d gets=%d result=%#v", err, handled, posts, gets, result)
	}
}

func TestManagedImageEndedTaskDoesNotEnterRecovery(t *testing.T) {
	svc, _, task, _, _ := imageSubmissionFixture(t, false)
	attempt, _ := svc.repo.LatestRouteAttempt(task.ID)
	attempt.ChannelID = beefapi.ChannelID
	if err := svc.repo.SaveRouteAttempt(attempt); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name     string
		err      error
		deferred bool
	}{
		{"api reported failure", &beefapi.MediaTaskError{Code: "media_generation_failed", Category: "upstream", Message: "failed"}, false},
		{"result unknown keeps recovery active", &beefapi.MediaTaskError{Code: "media_result_unknown", Category: "unknown", Message: "unknown"}, true},
		{"delivery pending keeps recovery active", &beefapi.MediaTaskError{Code: "media_delivery_pending", Category: "pending", Message: "pending"}, true},
		{"failed before sending", generation.RequestPreparationError{Cause: context.DeadlineExceeded}, false},
		{"submission rejected", &beefapi.MediaHTTPError{StatusCode: http.StatusBadRequest}, false},
		{"throttled", &beefapi.MediaHTTPError{StatusCode: http.StatusTooManyRequests}, true},
		{"timed out", context.DeadlineExceeded, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := svc.shouldDeferImageRecovery(task, tc.err, false); got != tc.deferred {
				t.Fatalf("defer=%v, want %v", got, tc.deferred)
			}
			if !tc.deferred {
				info := routeFailureInfo(tc.err)
				if !info.TerminalProviderFailure && !info.ExplicitRejection && !info.PreparationFailed {
					t.Fatalf("ended error must not fall into submission_unknown route state: %+v", info)
				}
				candidate := task
				candidate.Status = model.TaskStatusRunning
				candidate.RecoveryOutcome = nil
				if err := svc.repo.DB().Save(&candidate).Error; err != nil {
					t.Fatal(err)
				}
				outcomeResult := executionFailureOutcome(svc.terminalCoordinator(), &candidate, tc.err, false, false, false)
				if !outcomeResult.Applied || candidate.RecoveryOutcome == nil || *candidate.RecoveryOutcome != localtask.RecoveryNoResult || candidate.Stage != "任务失败" {
					t.Fatalf("Applied=%v Stage=%q RecoveryOutcome=%v, want Applied=true Stage=任务失败 RecoveryOutcome=%q", outcomeResult.Applied, candidate.Stage, candidate.RecoveryOutcome, localtask.RecoveryNoResult)
				}
				failed := candidate
				failed.LeaseOwner = ""
				if err := svc.repo.FinishFailedImageRecovery(failed, candidate.RecoveryOutcome, nil); err != nil {
					t.Fatal(err)
				}
				stored, err := svc.repo.Task(candidate.ID)
				if err != nil || stored.RecoveryOutcome == nil || *stored.RecoveryOutcome != localtask.RecoveryNoResult {
					t.Fatalf("stored RecoveryOutcome=%v err=%v", stored.RecoveryOutcome, err)
				}
				outcome := localtask.ComputeOutcome(*stored, "", localtask.OutcomeFacts{HasImageReceipt: true, DispatchState: "accepted"})
				if outcome.Phase != "failed" || outcome.Reason != "no_result" {
					t.Fatalf("outcome=%+v, want phase=failed reason=no_result", outcome)
				}
			}
		})
	}
}

func TestCustomBYOKOnEnterpriseOriginSendsImageGenerationAndReplaysSameKey(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	s.workerID = newID()
	localCfg, _ := json.Marshal(map[string]any{
		"channels": []any{
			map[string]any{"id": beefapi.ChannelID, "enabled": true, "baseUrl": "https://beeftv.app/v1", "apiKey": "disk-managed-secret"},
			map[string]any{"id": "custom-byok", "enabled": true, "baseUrl": "https://beeftv.app/v1", "apiKey": "sk-custom-byok"},
		},
	})
	if err := s.SaveLocalModelConfig(localCfg); err != nil {
		t.Fatal(err)
	}
	rawInput := map[string]any{
		"mode": "image",
		"config": map[string]any{
			"baseUrl":       "https://beeftv.app/v1",
			"apiKey":        "sk-custom-byok",
			"model":         "gpt-image-2",
			"interfaceType": "openai-image",
		},
	}
	resolved, err := s.resolveManagedBeefAPISecrets(rawInput)
	if err != nil {
		t.Fatal(err)
	}
	resolvedCfg := resolved["config"].(map[string]any)
	if resolvedCfg["apiKey"] != "sk-custom-byok" || resolvedCfg["baseUrl"] != "https://beeftv.app/v1" || resolvedCfg["credentialRef"] != nil {
		t.Fatalf("BYOK config was rewritten to managed credential: %#v", resolvedCfg)
	}
	catalogReq := ChannelModelsRequest{ChannelID: "custom-byok", BaseURL: "https://beeftv.app/v1", APIKey: "sk-custom-byok"}
	if err := s.resolveChannelModelsRequest(&catalogReq); err != nil {
		t.Fatal(err)
	}
	if catalogReq.APIKey != "sk-custom-byok" || catalogReq.BaseURL != "https://beeftv.app/v1" || catalogReq.CredentialRef != "" {
		t.Fatalf("BYOK channel catalog request was rewritten: %+v", catalogReq)
	}
	inputBytes, _ := json.Marshal(resolved)
	expires := time.Now().Add(time.Hour)
	task := model.Task{
		ID:             "byok-enterprise-image",
		UserID:         "user",
		Type:           "canvas_image",
		Status:         model.TaskStatusRunning,
		LeaseOwner:     "owner",
		LeaseExpiresAt: &expires,
		InputJSON:      string(inputBytes),
	}
	attempt := &model.RouteAttempt{ID: "byok-attempt", TaskID: task.ID, Status: "dispatching", DispatchState: "submission_unknown", StartedAt: time.Now()}
	for _, row := range []any{&task, attempt} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	body := `{"model":"gpt-image-2","prompt":"draw a cat","n":1}`
	ctx := withProviderSubmissionKey(withProviderAnalytics(context.Background(), s, task), attempt)
	ctx = generation.WithImageReplayProtocol(ctx, generation.ImageReplayProtocol)
	ctx = context.WithValue(ctx, imageTaskContext{}, task)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://beeftv.app/v1/images/generations", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer sk-custom-byok")
	row, handled, err := prepareImageSubmission(s, req)
	if err != nil || !handled {
		t.Fatalf("prepare: handled=%v err=%v", handled, err)
	}
	if row.QueryCipher != "" {
		t.Fatalf("BYOK request acquired managed QueryCipher: %q", row.QueryCipher)
	}
	wire, err := s.imageSubmissionWire(row)
	if err != nil {
		t.Fatal(err)
	}
	if wire.ChannelID != "custom-byok" {
		t.Fatalf("wire.ChannelID=%q, want custom-byok", wire.ChannelID)
	}
	sends := 0
	firstKey := ""
	data, _, err := s.sendImageSubmissionWith(context.Background(), task, row, func(r *http.Request, admit func() error) ([]byte, string, error) {
		if err := admit(); err != nil {
			return nil, "", err
		}
		sends++
		sentBody, readErr := io.ReadAll(r.Body)
		if readErr != nil {
			t.Fatal(readErr)
		}
		key := r.Header.Get("Idempotency-Key")
		if sends == 1 {
			firstKey = key
		}
		if key == "" || key != firstKey || r.URL.String() != "https://beeftv.app/v1/images/generations" || r.Header.Get("Authorization") != "Bearer sk-custom-byok" || string(sentBody) != body {
			t.Fatalf("send %d altered identity: url=%q auth=%q key=%q body=%q", sends, r.URL.String(), r.Header.Get("Authorization"), key, string(sentBody))
		}
		if sends == 1 {
			return nil, "", io.ErrUnexpectedEOF
		}
		return []byte(`{"data":[{"url":"https://example.invalid/cat.png"}]}`), "application/json", nil
	}, noImageWait)
	if err != nil || sends != 2 || len(data) == 0 {
		t.Fatalf("sends=%d len=%d err=%v", sends, len(data), err)
	}
	disabledCfg, _ := json.Marshal(map[string]any{
		"channels": []any{
			map[string]any{"id": "custom-byok", "enabled": false, "baseUrl": "https://beeftv.app/v1", "apiKey": "sk-custom-byok"},
		},
	})
	if err := s.SaveLocalModelConfig(disabledCfg); err != nil {
		t.Fatal(err)
	}
	row.ResponseAccepted = false
	if err := db.Save(row).Error; err != nil {
		t.Fatal(err)
	}
	_, _, err = s.sendImageSubmissionWith(context.Background(), task, row, func(_ *http.Request, admit func() error) ([]byte, string, error) {
		if err := admit(); err != nil {
			return nil, "", err
		}
		sends++
		return []byte(`{"data":[{"url":"https://example.invalid/cat.png"}]}`), "application/json", nil
	}, noImageWait)
	if !errors.Is(err, errImageRecoveryIdentityUnavailable) || sends != 2 {
		t.Fatalf("disabled custom channel still replayed: sends=%d err=%v", sends, err)
	}
}
