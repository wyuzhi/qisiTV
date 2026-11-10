package generation

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/protocol"
	"infinite-canvas/backend/internal/repository"
)

const pollPolicyFixtureProvider = `{"apiVersion":"beeftv.plugin/v2","id":"poll-fixture","name":"Fixture","version":"1.0.0","contributes":{"providers":[{"id":"poll-fixture","label":"Fixture","capabilities":["image","video","audio"],"scopes":["canvas"],"auth":{"type":"bearer","field":"apiKey"},"create":{"method":"POST","path":"/tasks"},"poll":{"method":"GET","path":"/tasks/{{taskId}}"},"response":{"taskId":{"$ref":"response.id"},"status":{"$ref":"response.status"},"images":{"$ref":"response.images"}}}]}}`

func pollPolicyFixtureAdapter(t *testing.T) protocol.Adapter {
	t.Helper()
	adapters, err := protocol.LoadInstalledProviders([]byte(pollPolicyFixtureProvider))
	if err != nil {
		t.Fatal(err)
	}
	return adapters[0]
}

func fastDeclarativePollPolicy() VideoPollPolicy {
	return VideoPollPolicy{
		RetryTransient:    true,
		MaxNotFoundMisses: 3,
		Interval:          time.Millisecond,
		Sleep:             func(context.Context, time.Duration) error { return nil },
		Notify:            func(context.Context, string, VideoPollEvent, error) {},
	}
}

// A query endpoint that keeps returning 404 only means "receipt not synced yet" for image tasks.
// Video and audio must keep ending with the upstream 404 instead of being deferred for minutes.
func TestProtocolPoll404KeepsModeOutcome(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, tc := range []struct {
		mode    string
		pending bool
	}{
		{"image", true},
		{"video", false},
		{"audio", false},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			creates, polls := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/tasks") {
					creates++
					fmt.Fprint(w, `{"id":"original","status":"pending"}`)
					return
				}
				if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/tasks/original") {
					polls++
					w.WriteHeader(http.StatusNotFound)
					fmt.Fprint(w, `{"error":{"message":"no such task"}}`)
					return
				}
				t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
				w.WriteHeader(http.StatusForbidden)
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, err := RunProtocolAdapterTaskWithPolicy(ctx, Input{Mode: tc.mode, Config: Config{BaseURL: server.URL, APIKey: "fixture"}}, pollPolicyFixtureAdapter(t), fastDeclarativePollPolicy())
			if creates != 1 || polls != 3 {
				t.Fatalf("creates=%d polls=%d err=%v", creates, polls, err)
			}
			var pending StatePendingError
			if tc.pending {
				if !errors.As(err, &pending) || pending.TaskID != "original" {
					t.Fatalf("image lost pending receipt: %v", err)
				}
				return
			}
			if errors.As(err, &pending) {
				t.Fatalf("%s 404 became pending: %v", tc.mode, err)
			}
			var httpErr HTTPError
			if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusNotFound {
				t.Fatalf("%s lost upstream 404: %v", tc.mode, err)
			}
		})
	}
}

func TestImageProtocolPollStopsAfterConsecutiveTransientFailures(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	creates, polls := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/tasks") {
			creates++
			fmt.Fprint(w, `{"id":"original","status":"pending"}`)
			return
		}
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/tasks/original") {
			polls++
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprint(w, `{"error":{"message":"fixture unavailable"}}`)
			return
		}
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	policy := DeclarativeProtocolPollPolicy("image")
	policy.Sleep = func(context.Context, time.Duration) error { return nil }
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := RunProtocolAdapterTaskWithPolicy(ctx, Input{Mode: "image", Config: Config{BaseURL: server.URL, APIKey: "fixture"}}, pollPolicyFixtureAdapter(t), policy)
	if creates != 1 {
		t.Fatalf("task was resubmitted: creates=%d", creates)
	}
	if polls != 6 {
		t.Fatalf("polls=%d want cap 6, err=%v", polls, err)
	}
	var httpErr HTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("cap returned %v, want upstream 503", err)
	}
	if !strings.Contains(httpErr.Body, "fixture unavailable") {
		t.Fatalf("lost upstream reason: %q", httpErr.Body)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("down channel must fail with the upstream error, not a timeout")
	}
}

func TestNotifyPollReceiptUsesModalityNeutralCopy(t *testing.T) {
	ctx := WithCallMeta(context.Background(), CallMeta{UserID: "user-1", TaskID: "task-1"})
	for _, tc := range []struct {
		event   VideoPollEvent
		level   string
		message string
	}{
		{VideoPollEventRetrying, "warn", "上游任务查询暂时异常，正在继续查询原任务"},
		{VideoPollEventRecovered, "info", "上游任务查询已恢复"},
	} {
		t.Run(string(tc.event), func(t *testing.T) {
			var gotUser, gotTask, gotLevel, gotMessage, gotPayload string
			NotifyPollReceipt(ctx, &repository.Repository{}, func(userID, taskID, level, msg, payload string) error {
				gotUser, gotTask, gotLevel, gotMessage, gotPayload = userID, taskID, level, msg, payload
				return nil
			}, string(tc.event), errors.New("upstream 503"))
			if gotUser != "user-1" || gotTask != "task-1" || gotLevel != tc.level || gotMessage != tc.message {
				t.Fatalf("log = user=%q task=%q level=%q message=%q", gotUser, gotTask, gotLevel, gotMessage)
			}
			if tc.event == VideoPollEventRetrying && gotPayload != "upstream 503" {
				t.Fatalf("payload = %q", gotPayload)
			}
		})
	}
}
