//go:build windows

package localipc

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestWindowsPipeReadDeadlinePreservesNetErrorAndConnection(t *testing.T) {
	endpoint := testEndpoint(t, "deadline")
	listener, err := Listen(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() { c, _ := listener.Accept(); accepted <- c }()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	client, err := DialContext(ctx, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var server net.Conn
	select {
	case server = <-accepted:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if server == nil {
		t.Fatal("pipe accept failed")
	}
	defer server.Close()
	if err := server.SetReadDeadline(time.Now().Add(20 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	_, err = server.Read(make([]byte, 5))
	if timeout, ok := err.(net.Error); !ok || !timeout.Timeout() || !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("pipe read deadline must be a net.Error preserving its cause: %T %v", err, err)
	}
	if err := server.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Write([]byte("ready")); err != nil {
		t.Fatal(err)
	}
	var payload [5]byte
	if _, err := io.ReadFull(server, payload[:]); err != nil || string(payload[:]) != "ready" {
		t.Fatalf("clearing the read deadline must preserve the connection: %q %v", payload, err)
	}
}

func TestWindowsPipeHTTPKeepAliveDoesNotCancelNextRequest(t *testing.T) {
	endpoint := testEndpoint(t, "keepalive")
	listener, err := Listen(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var connections atomic.Int32
	server := &http.Server{
		ConnState: func(_ net.Conn, state http.ConnState) {
			if state == http.StateNew {
				connections.Add(1)
			}
		},
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, err := io.ReadAll(r.Body); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			// Allow the server's background read to observe the previous deadline.
			time.Sleep(10 * time.Millisecond)
			if err := r.Context().Err(); err != nil {
				http.Error(w, err.Error(), 499)
				return
			}
			_, _ = io.WriteString(w, "live")
		}),
	}
	defer server.Close()
	go func() { _ = server.Serve(listener) }()
	transport := NewDynamicHTTPTransport(func() string { return endpoint }, time.Second, false)
	transport.DisableKeepAlives = false
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPost} {
		var body io.Reader
		if method == http.MethodPost {
			body = strings.NewReader(`{"message":"live"}`)
		}
		req, err := http.NewRequest(method, "http://127.0.0.1:1/round-trip", body)
		if err != nil {
			t.Fatal(err)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		payload, readErr := io.ReadAll(res.Body)
		res.Body.Close()
		if readErr != nil || res.StatusCode != 200 || string(payload) != "live" {
			t.Fatalf("%s on reused pipe: status=%d body=%q error=%v", method, res.StatusCode, payload, readErr)
		}
	}
	if connections.Load() != 1 {
		t.Fatalf("expected one reused pipe, got %d", connections.Load())
	}
}
