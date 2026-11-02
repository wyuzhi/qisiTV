package outbound

import (
	"context"
	"golang.org/x/net/dns/dnsmessage"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestManagedPublicHTTPSIgnoresBYOKLANPolicy(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "localhost,10.0.0.1")
	for _, target := range []string{"https://127.0.0.1/a", "https://10.0.0.1/a", "https://[::1]/a", "https://100.64.0.1/a", "https://169.254.169.254/a", "https://192.0.2.1/a", "http://8.8.8.8/a"} {
		if _, err := ValidatePublicHTTPSURLContext(context.Background(), target); err == nil {
			t.Fatalf("accepted %s", target)
		}
	}
	if _, err := ValidateOutboundURL("http://127.0.0.1/a"); err != nil {
		t.Fatalf("changed BYOK: %v", err)
	}
	if _, err := publicHTTPSTransport.DialContext(context.Background(), "tcp", "10.0.0.1:443"); err == nil {
		t.Fatal("direct dial accepted private target")
	}
}

func TestManagedPublicHTTPSAllowsStorageVendorsWithoutDomainList(t *testing.T) {
	for _, host := range []string{"bucket.cos.ap-shanghai.myqcloud.com", "bucket.r2.cloudflarestorage.com", "bucket.tos-ap-southeast-1.bytepluses.com", "future-storage.example"} {
		_, err := validatePublicHTTPSURLContext(context.Background(), "https://"+host+"/owned?signature=fixture", func(_ context.Context, got string) ([]net.IP, error) {
			if got != host {
				t.Fatal("changed hostname")
			}
			return []net.IP{net.ParseIP("8.8.8.8")}, nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestManagedPublicHTTPSRetainsConfiguredProxyAndRejectsPrivateTarget(t *testing.T) {
	connects := 0
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { connects++; w.WriteHeader(http.StatusBadGateway) }))
	defer proxy.Close()
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("NO_PROXY", "")
	client := OutboundHTTPClient(0)
	req, _ := http.NewRequestWithContext(WithPublicHTTPS(context.Background()), http.MethodGet, "https://8.8.8.8/object", nil)
	_, _ = client.Do(req)
	if connects != 1 {
		t.Fatalf("configured proxy unused: %d", connects)
	}
	req, _ = http.NewRequestWithContext(WithPublicHTTPS(context.Background()), http.MethodGet, "https://127.0.0.1/object", nil)
	if _, err := client.Do(req); err == nil || connects != 1 {
		t.Fatal("proxy exempted target policy")
	}
	t.Setenv("NO_PROXY", "8.8.8.8")
	req, _ = http.NewRequest(http.MethodGet, "https://8.8.8.8/object", nil)
	if selected, err := publicHTTPSTransport.Proxy(req.Clone(context.Background())); err != nil || selected != nil {
		t.Fatalf("NO_PROXY/local behavior changed: %v %v", selected, err)
	}
}

type publicHTTPSRedirectTransport func(*http.Request) (*http.Response, error)

func (f publicHTTPSRedirectTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestManagedPublicHTTPSRejectsPrivateRedirect(t *testing.T) {
	requests := 0
	client := OutboundHTTPClient(0)
	client.Transport = publicHTTPSRedirectTransport(func(req *http.Request) (*http.Response, error) {
		requests++
		return &http.Response{StatusCode: http.StatusFound, Header: http.Header{"Location": []string{"https://127.0.0.1/private"}}, Body: io.NopCloser(strings.NewReader("")), Request: req}, nil
	})
	req, _ := http.NewRequestWithContext(WithPublicHTTPS(context.Background()), http.MethodGet, "https://8.8.8.8/object", nil)
	if _, err := client.Do(req); err == nil || requests != 1 {
		t.Fatalf("private redirect dispatched: %d %v", requests, err)
	}
}

func TestManagedPublicHTTPSBlocksDNSRebindingAtDirectDial(t *testing.T) {
	listener, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var lookups atomic.Int32
	go func() {
		buffer := make([]byte, 2048)
		for {
			n, peer, err := listener.ReadFrom(buffer)
			if err != nil {
				return
			}
			var query dnsmessage.Message
			if query.Unpack(buffer[:n]) != nil || len(query.Questions) != 1 {
				continue
			}
			response := dnsmessage.Message{Header: dnsmessage.Header{ID: query.Header.ID, Response: true, Authoritative: true, RecursionAvailable: true}, Questions: query.Questions}
			if query.Questions[0].Type == dnsmessage.TypeA {
				ip := [4]byte{8, 8, 8, 8}
				if lookups.Add(1) >= 3 {
					ip = [4]byte{127, 0, 0, 1}
				}
				response.Answers = []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: query.Questions[0].Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 0}, Body: &dnsmessage.AResource{A: ip}}}
			}
			wire, _ := response.Pack()
			_, _ = listener.WriteTo(wire, peer)
		}
	}()
	previousResolver := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "udp", listener.LocalAddr().String())
	}}
	defer func() { net.DefaultResolver = previousResolver }()
	previousTransport := publicHTTPSTransport
	publicHTTPSTransport = newOutboundTransport(resolvePublicHost)
	publicHTTPSTransport.Proxy = nil
	defer func() { publicHTTPSTransport.CloseIdleConnections(); publicHTTPSTransport = previousTransport }()
	ctx := WithPublicHTTPS(context.Background())
	if _, err := ValidatePublicHTTPSURLContext(ctx, "https://rebind.example/object"); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://rebind.example/object", nil)
	if _, err := OutboundHTTPClient(time.Second).Do(req); err == nil || lookups.Load() < 3 {
		t.Fatalf("rebound target dispatched: lookups=%d error=%v", lookups.Load(), err)
	}
}
