package localipc

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func testEndpoint(t *testing.T, label string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		return AgentHostEndpoint()
	}
	// macOS sun_path limit is 104 bytes; keep temp socket path compact.
	dir, err := filepath.EvalSymlinks("/tmp")
	if err != nil {
		dir = "/tmp"
	}
	return filepath.Join(dir, fmt.Sprintf("btv-%s-%d.sock", sanitizeToken(label, 8), time.Now().UnixNano()%1_000_000_000))
}

func TestValidWindowsPipeName(t *testing.T) {
	if !validWindowsPipeName(`\\.\pipe\beeftv-ws-abcdef123456-42`) {
		t.Fatal("expected valid windows pipe name to pass")
	}
	for _, bad := range []string{
		"",
		`\\.\pipe\other-app`,
		`\\192.168.1.2\pipe\beeftv-ws-123`,
		`\\.\pipe\beeftv-..\escape`,
		`\\.\pipe\beeftv-a/b`,
		`C:\temp\beeftv.pipe`,
	} {
		if validWindowsPipeName(bad) {
			t.Fatalf("expected %q to be rejected", bad)
		}
	}
}

func TestHTTPStreamingAndConcurrencyOverLocalIPC(t *testing.T) {
	endpoint := testEndpoint(t, "stream")
	listener, err := Listen(endpoint)
	if err != nil {
		t.Fatalf("Listen(%s): %v", endpoint, err)
	}
	defer listener.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/echo", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = fmt.Fprintf(w, "host=%s remote=%s", r.Host, r.RemoteAddr)
	})
	mux.HandleFunc("/stream", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		flusher, _ := w.(http.Flusher)
		for i := range 3 {
			_, _ = fmt.Fprintf(w, "{\"seq\":%d}\n", i)
			if flusher != nil {
				flusher.Flush()
			}
			time.Sleep(10 * time.Millisecond)
		}
	})
	srv := &http.Server{Handler: mux}
	defer srv.Close()
	go func() { _ = srv.Serve(listener) }()

	client := &http.Client{
		Transport: NewDynamicHTTPTransport(func() string { return endpoint }, 5*time.Second, false),
		Timeout:   5 * time.Second,
	}

	var wg sync.WaitGroup
	errs := make(chan error, 12)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Port 1 is intentionally unreachable over TCP, proving requests traverse local IPC.
			resp, reqErr := client.Get("http://127.0.0.1:1/echo")
			if reqErr != nil {
				errs <- reqErr
				return
			}
			defer resp.Body.Close()
			raw, _ := io.ReadAll(resp.Body)
			got := string(raw)
			if got != "host=127.0.0.1:1 remote=127.0.0.1:0" {
				errs <- fmt.Errorf("unexpected echo payload: %q", got)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for reqErr := range errs {
		t.Fatal(reqErr)
	}

	streamResp, err := client.Get("http://127.0.0.1:1/stream")
	if err != nil {
		t.Fatalf("stream request failed: %v", err)
	}
	defer streamResp.Body.Close()
	scanner := bufio.NewScanner(streamResp.Body)
	var lines []string
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if len(lines) != 3 || !strings.Contains(lines[2], `"seq":2`) {
		t.Fatalf("unexpected stream lines: %v", lines)
	}

	// Closing listener must unblock Accept promptly.
	done := make(chan struct{})
	go func() {
		_ = listener.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("listener.Close timed out")
	}

	if runtime.GOOS == "windows" {
		ep2 := testEndpoint(t, "dup")
		l1, err := Listen(ep2)
		if err != nil {
			t.Fatalf("first Listen failed: %v", err)
		}
		defer l1.Close()
		if l2, err := Listen(ep2); err == nil {
			_ = l2.Close()
			t.Fatal("expected duplicate first-instance pipe Listen to fail")
		}
	}
}

func TestDynamicTransportFallsBackToNetworkWhenConfigured(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/ok", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("tcp-ok"))
	})
	tcpListener, err := ListenTCPForTest()
	if err != nil {
		t.Fatalf("tcp listen: %v", err)
	}
	defer tcpListener.Close()
	srv := &http.Server{Handler: mux}
	defer srv.Close()
	go func() { _ = srv.Serve(tcpListener) }()

	missingEndpoint := testEndpoint(t, "missing")
	client := &http.Client{
		Transport: NewDynamicHTTPTransport(func() string { return missingEndpoint }, 2*time.Second, true),
		Timeout:   2 * time.Second,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+tcpListener.Addr().String()+"/ok", nil)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("expected TCP fallback to succeed, got %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if string(raw) != "tcp-ok" {
		t.Fatalf("unexpected body: %q", string(raw))
	}
}
