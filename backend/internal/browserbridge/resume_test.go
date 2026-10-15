package browserbridge

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func waitInactive(t *testing.T, bridge *Server, token string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		bridge.mu.Lock()
		entry := bridge.sessions[token]
		inactive := entry == nil || entry.Conn == nil
		bridge.mu.Unlock()
		if inactive {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("browser did not disconnect")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestResumeKeepsSessionAndExpiryButNeverReplaysPendingWrites(t *testing.T) {
	bridge, server := startTestServer(t)
	token := pairTest(t, bridge, server)
	entry := bridge.sessions[token]
	expiry, id := entry.Expires, entry.ID
	conn := connectTest(t, server, token)
	done := make(chan error, 1)
	go func() {
		_, err := bridge.Call(context.Background(), "canvas_create", map[string]any{"title": "once"})
		done <- err
	}()
	var command map[string]any
	if err := conn.ReadJSON(&command); err != nil {
		t.Fatal(err)
	}
	conn.Close()
	var rpc *RPCError
	if err := <-done; !errors.As(err, &rpc) || rpc.Code != "BROWSER_DISCONNECTED" {
		t.Fatalf("uncertain write: %v", err)
	}
	waitInactive(t, bridge, token)
	status, _ := requestTest(t, server, "POST", "/resume", testOrigin, "", map[string]any{"token": token})
	if status != 200 {
		t.Fatal("refresh lost authorization")
	}
	resumed := connectTest(t, server, token)
	bridge.mu.Lock()
	valid := entry.ID == id && entry.Expires.Equal(expiry) && len(entry.Pending) == 0 && entry.ProjectID == ""
	bridge.mu.Unlock()
	if !valid {
		t.Fatal("resume renewed authorization or retained stale commands/context")
	}
	resumed.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	if err := resumed.ReadJSON(&command); err == nil {
		t.Fatal("interrupted write was replayed")
	}
}

func assertTokenRejected(t *testing.T, server *httptest.Server, token string) {
	t.Helper()
	status, _ := requestTest(t, server, "POST", "/resume", testOrigin, "", map[string]any{"token": token})
	if status != 401 {
		t.Fatalf("resume accepted revoked token: %d", status)
	}
	dialer := websocket.Dialer{Subprotocols: []string{"qisitv-v1", "qisitv-auth." + token}}
	conn, response, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws", http.Header{"Origin": []string{testOrigin}})
	if conn != nil {
		conn.Close()
	}
	if err == nil || response.StatusCode != 401 {
		t.Fatal("socket accepted revoked token")
	}
}

func TestResumeAndRevokeRespectOriginActiveBrowserAndAgentBoundaries(t *testing.T) {
	bridge, server := startTestServer(t)
	token := pairTest(t, bridge, server)
	conn := connectTest(t, server, token)
	status, _ := requestTest(t, server, "POST", "/resume", testOrigin, "", map[string]any{"token": token})
	if status != 409 {
		t.Fatal("a second tab could take over the active connection")
	}
	for _, endpoint := range []string{"/resume", "/unpair"} {
		for _, origin := range []string{"", "https://evil.example", "https://www.cheeser.link"} {
			status, _ = requestTest(t, server, "POST", endpoint, origin, "", map[string]any{"token": token})
			if status != 401 && status != 403 {
				t.Fatal("different/no origin used browser authorization")
			}
		}
		status, _ = requestTest(t, server, "POST", endpoint, testOrigin, "", map[string]any{"token": testAgentToken})
		if status != 401 {
			t.Fatal("Agent credential accepted as browser authorization")
		}
	}
	status, _ = requestTest(t, server, "POST", "/unpair", testOrigin, "", map[string]any{"token": token})
	if status != 200 {
		t.Fatal("explicit disconnect did not revoke")
	}
	conn.SetReadDeadline(time.Now().Add(time.Second))
	_, _, err := conn.ReadMessage()
	if !websocket.IsCloseError(err, 4001) {
		t.Fatalf("live browser did not receive revocation: %v", err)
	}
	assertTokenRejected(t, server, token)
}

func TestExplicitSocketDisconnectRevokesButNormalCloseDoesNot(t *testing.T) {
	bridge, server := startTestServer(t)
	token := pairTest(t, bridge, server)
	conn := connectTest(t, server, token)
	conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4000, "User disconnected"), time.Now().Add(time.Second))
	conn.Close()
	waitInactive(t, bridge, token)
	assertTokenRejected(t, server, token)
}

func TestAuthorizationExpiryClosesLiveSocketAndRejectsInactiveSession(t *testing.T) {
	bridge, server := startTestServer(t)
	token := pairTest(t, bridge, server)
	bridge.sessions[token].Expires = time.Now().Add(100 * time.Millisecond)
	conn := connectTest(t, server, token)
	conn.SetReadDeadline(time.Now().Add(time.Second))
	_, _, err := conn.ReadMessage()
	if !websocket.IsCloseError(err, 4001) {
		t.Fatalf("expired socket stayed connected: %v", err)
	}
	waitInactive(t, bridge, token)
	assertTokenRejected(t, server, token)
	token = pairTest(t, bridge, server)
	bridge.sessions[token].Expires = time.Now().Add(-time.Second)
	assertTokenRejected(t, server, token)
}
