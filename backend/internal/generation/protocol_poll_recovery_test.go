package generation

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"qisitv/backend/internal/protocol"
)

func TestImageProtocolPollRecoveryNeverResubmits(t *testing.T) {
	for _, tc := range []struct {
		name      string
		statuses  []int
		pending   bool
		permanent bool
	}{
		{"transient", []int{503, 525, 200}, false, false},
		{"temporary missing", []int{404, 200}, false, false},
		{"missing receipt", []int{404, 404, 404}, true, false},
		{"unauthorized", []int{401}, false, true},
		{"forbidden", []int{403}, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
			creates, polls := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodPost && r.URL.Path == "/v1/tasks" {
					creates++
					fmt.Fprint(w, `{"id":"original","status":"pending"}`)
					return
				}
				if r.Method != http.MethodGet || r.URL.Path != "/v1/tasks/original" || polls >= len(tc.statuses) {
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusForbidden)
					return
				}
				status := tc.statuses[polls]
				polls++
				if status != http.StatusOK {
					w.Header().Set("Retry-After", "7")
					w.WriteHeader(status)
					fmt.Fprint(w, `{"error":{"message":"fixture unavailable"}}`)
					return
				}
				fmt.Fprint(w, `{"id":"original","status":"succeeded","images":[{"url":"https://93.184.216.34/result.png"}]}`)
			}))
			defer server.Close()
			adapters, err := protocol.LoadInstalledProviders([]byte(`{"apiVersion":"beeftv.plugin/v2","id":"poll-fixture","name":"Fixture","version":"1.0.0","contributes":{"providers":[{"id":"poll-fixture","label":"Fixture","capabilities":["image"],"scopes":["canvas"],"auth":{"type":"bearer","field":"apiKey"},"create":{"method":"POST","path":"/tasks"},"poll":{"method":"GET","path":"/tasks/{{taskId}}"},"response":{"taskId":{"$ref":"response.id"},"status":{"$ref":"response.status"},"images":{"$ref":"response.images"}}}]}}`))
			if err != nil {
				t.Fatal(err)
			}
			policy := DeclarativeProtocolPollPolicy("image")
			var delays []time.Duration
			var events []VideoPollEvent
			policy.Sleep = func(_ context.Context, delay time.Duration) error { delays = append(delays, delay); return nil }
			policy.Notify = func(_ context.Context, id string, event VideoPollEvent, _ error) {
				if id != "original" {
					t.Errorf("changed task identity: %s", id)
				}
				events = append(events, event)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			result, err := RunProtocolAdapterTaskWithPolicy(ctx, Input{Mode: "image", Config: Config{BaseURL: server.URL, APIKey: "fixture"}}, adapters[0], policy)
			if creates != 1 || polls != len(tc.statuses) {
				t.Fatalf("creates=%d polls=%d err=%v", creates, polls, err)
			}
			if tc.pending {
				var pending StatePendingError
				if !errors.As(err, &pending) || pending.TaskID != "original" || !ClassifyTaskFailure(err).Uncertain {
					t.Fatalf("lost uncertain receipt: %v", err)
				}
			} else if tc.permanent {
				if err == nil || len(delays) != 0 || len(events) != 0 {
					t.Fatalf("permanent rejection retried: %v %v %v", err, delays, events)
				}
			} else {
				if err != nil || result["mode"] != "image" {
					t.Fatalf("result=%v err=%v", result, err)
				}
				if !reflect.DeepEqual(events, []VideoPollEvent{VideoPollEventRetrying, VideoPollEventRecovered}) {
					t.Fatalf("events=%v", events)
				}
			}
			for _, delay := range delays {
				if delay < 7*time.Second {
					t.Errorf("Retry-After ignored: %v", delay)
				}
			}
		})
	}
}
