package assistantruntime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/localipc"
)

// HostHealth is the public probe result. It never includes the instance nonce.
type HostHealth struct {
	OK       bool
	Busy     bool
	Model    string
	Reason   string
	Instance string
}

func noRedirect(*http.Request, []*http.Request) error {
	return http.ErrUseLastResponse
}

func probeOwned(ctx context.Context, baseURL, pipePath, nonce, token string) HostHealth {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" || strings.TrimSpace(nonce) == "" {
		return HostHealth{}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/health", nil)
	if err != nil {
		return HostHealth{}
	}
	applyInstanceHeaders(req, token, nonce)
	pipePath = strings.TrimSpace(pipePath)
	transport := http.DefaultTransport
	if pipePath != "" {
		transport = localipc.NewDynamicHTTPTransport(func() string { return pipePath }, 0, false)
	} else if _, ok := http.DefaultTransport.(*http.Transport); ok {
		transport = localipc.NewDynamicHTTPTransport(nil, 0, true)
	}
	client := &http.Client{
		Timeout:       3 * time.Second,
		Transport:     transport,
		CheckRedirect: noRedirect,
	}
	resp, err := client.Do(req)
	if err != nil {
		return HostHealth{}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	var payload map[string]any
	_ = json.Unmarshal(body, &payload)
	health := HostHealth{}
	if payload != nil {
		health.Busy, _ = payload["busy"].(bool)
		health.Model, _ = payload["model"].(string)
		health.Reason, _ = payload["reason"].(string)
		health.Instance, _ = payload["instance"].(string)
	}
	if resp.StatusCode != http.StatusOK {
		return health
	}
	if health.Instance != InstanceProof(nonce) {
		return HostHealth{}
	}
	health.OK = true
	if ready, found := payload["ok"].(bool); found && !ready {
		health.OK = false
	}
	return health
}

func (h *Host) Probe(ctx context.Context) HostHealth {
	if h == nil {
		return HostHealth{}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	base, nonce := h.proc.identity()
	if base == "" || nonce == "" {
		return HostHealth{}
	}
	return probeOwned(ctx, base, h.proc.pipeEndpoint(), nonce, h.hostToken())
}

// HTTPClient returns a non-redirecting client routed over this Host's owned
// local IPC endpoint when present, falling back to loopback TCP.
func (h *Host) HTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout:       timeout,
		Transport:     h.transport(0),
		CheckRedirect: noRedirect,
	}
}

// StreamHTTPClient returns a streaming client without overall body timeout,
// preserving custom DefaultTransport interceptors in tests when no pipe is active.
func (h *Host) StreamHTTPClient(headerTimeout time.Duration) *http.Client {
	return &http.Client{
		Transport:     h.transport(headerTimeout),
		CheckRedirect: noRedirect,
	}
}

func (h *Host) transport(responseHeaderTimeout time.Duration) http.RoundTripper {
	if h != nil && h.opts.RoundTripper != nil {
		return h.opts.RoundTripper
	}
	if _, ok := http.DefaultTransport.(*http.Transport); !ok {
		if h == nil {
			return http.DefaultTransport
		}
		if pipePath, pipeOnly := h.proc.dialTarget(); pipePath == "" && !pipeOnly {
			return http.DefaultTransport
		}
	}
	return localipc.NewEndpointHTTPTransport(func() (string, bool) {
		if h == nil {
			return "", true
		}
		pipePath, pipeOnly := h.proc.dialTarget()
		return pipePath, !pipeOnly
	}, responseHeaderTimeout)
}

func (h *Host) NewChildRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	if h == nil {
		return nil, invalidArg("host_unreachable", "内置创作助手宿主未运行")
	}
	base, nonce := h.proc.identity()
	if strings.TrimSpace(base) == "" || nonce == "" {
		return nil, invalidArg("host_unreachable", "内置创作助手宿主未运行")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, body)
	if err != nil {
		return nil, err
	}
	applyInstanceHeaders(req, h.hostToken(), nonce)
	return req, nil
}
