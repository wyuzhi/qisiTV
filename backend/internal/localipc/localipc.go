// Package localipc provides same-user local IPC endpoints and HTTP transports
// (Windows Named Pipes in production on Windows, Unix domain sockets in tests)
// so built-in child processes and the local CLI do not depend on TCP loopback
// ports when endpoint security software intercepts dynamic 127.0.0.1 ports.
package localipc

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const windowsPipePrefix = `\\.\pipe\beeftv-`

// WorkspaceEndpoint returns the platform default local IPC endpoint for a
// desktop workspace, or empty when local IPC is not enabled by default.
func WorkspaceEndpoint(dataDir string) string {
	if override := strings.TrimSpace(os.Getenv("CANVAS_DESKTOP_IPC_ENDPOINT")); override != "" && ValidEndpoint(override) {
		return override
	}
	return platformWorkspaceEndpoint(dataDir)
}

// AgentHostEndpoint returns a fresh local IPC endpoint for an owned agent-host
// child using an independent cryptographic random identifier (never derived
// from the authentication instance nonce), or empty when inherited TCP FDs are used.
func AgentHostEndpoint() string {
	id := randomEndpointID()
	if override := strings.TrimSpace(os.Getenv("BEEFTV_AGENT_IPC_DIR")); override != "" {
		candidate := filepath.Join(override, "beeftv-agent-"+id[:16]+".sock")
		if ValidEndpoint(candidate) {
			return candidate
		}
	}
	return platformAgentHostEndpoint(id)
}

// TightenEndpointSecurity locks down the OS permissions of an endpoint created
// by a child runtime (such as Node/libuv) before any credentials are sent over it.
func TightenEndpointSecurity(endpoint string) error {
	return tightenPlatformSecurity(strings.TrimSpace(endpoint))
}

// IsTransientSecurityError reports whether err from TightenEndpointSecurity
// merely indicates the child process has not finished creating the pipe yet
// (as opposed to a permanent permission or configuration failure).
func IsTransientSecurityError(err error) bool {
	if err == nil {
		return false
	}
	return isTransientPlatformSecurityError(err)
}

// ValidEndpoint validates that endpoint is a well-formed BeefTV local IPC path.
func ValidEndpoint(endpoint string) bool {
	trimmed := strings.TrimSpace(endpoint)
	if trimmed == "" || strings.ContainsRune(trimmed, 0) {
		return false
	}
	return validPlatformEndpoint(trimmed)
}

type requiredEndpointKey struct{}

// WithRequiredEndpoint attaches a mandatory local IPC endpoint to ctx. An HTTP
// transport built by this package will dial ONLY that endpoint for the request
// and fail closed without falling back to TCP if the pipe is unavailable.
func WithRequiredEndpoint(ctx context.Context, endpoint string) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	trimmed := strings.TrimSpace(endpoint)
	if trimmed == "" {
		return ctx
	}
	return context.WithValue(ctx, requiredEndpointKey{}, trimmed)
}

func requiredEndpointFromContext(ctx context.Context) (string, bool) {
	if ctx == nil {
		return "", false
	}
	val, ok := ctx.Value(requiredEndpointKey{}).(string)
	return strings.TrimSpace(val), ok && strings.TrimSpace(val) != ""
}

// NewEndpointHTTPTransport builds an HTTP transport whose dial target and
// TCP-fallback policy are resolved dynamically on every dial (never snapshotted
// at client construction time). HTTP proxies are always bypassed.
func NewEndpointHTTPTransport(resolve func() (endpoint string, allowNetworkFallback bool), responseHeaderTimeout time.Duration) *http.Transport {
	var clone *http.Transport
	if base, ok := http.DefaultTransport.(*http.Transport); ok {
		clone = base.Clone()
	} else {
		clone = &http.Transport{}
	}
	clone.Proxy = nil
	clone.ResponseHeaderTimeout = responseHeaderTimeout
	clone.DisableKeepAlives = true
	dialer := &net.Dialer{
		Timeout:   30 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	clone.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if ctxEndpoint, required := requiredEndpointFromContext(ctx); required {
			if !ValidEndpoint(ctxEndpoint) {
				return nil, errors.New("invalid local IPC endpoint")
			}
			return DialContext(ctx, ctxEndpoint)
		}
		endpoint, allowFallback := "", true
		if resolve != nil {
			endpoint, allowFallback = resolve()
			endpoint = strings.TrimSpace(endpoint)
		}
		if ValidEndpoint(endpoint) {
			conn, err := DialContext(ctx, endpoint)
			if err == nil {
				return conn, nil
			}
			if !allowFallback {
				return nil, err
			}
		} else if !allowFallback {
			return nil, errors.New("local IPC endpoint unavailable")
		}
		return dialer.DialContext(ctx, network, addr)
	}
	return clone
}

// NewDynamicHTTPTransport builds an HTTP transport for local workspace or child
// calls. It never uses HTTP proxies, dials the resolved local IPC endpoint when
// present, and only falls back to direct loopback TCP when fallbackToNetwork is true.
func NewDynamicHTTPTransport(resolveEndpoint func() string, responseHeaderTimeout time.Duration, fallbackToNetwork bool) *http.Transport {
	return NewEndpointHTTPTransport(func() (string, bool) {
		if resolveEndpoint == nil {
			return "", fallbackToNetwork
		}
		return resolveEndpoint(), fallbackToNetwork
	}, responseHeaderTimeout)
}

func randomEndpointID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		sum := sha256.Sum256([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
		return hex.EncodeToString(sum[:12])
	}
	return hex.EncodeToString(raw[:12])
}

func canonicalDataDirDigest(dataDir string) string {
	cleaned := filepath.Clean(strings.TrimSpace(dataDir))
	if abs, err := filepath.Abs(cleaned); err == nil {
		cleaned = abs
	}
	if resolved, err := filepath.EvalSymlinks(cleaned); err == nil {
		cleaned = resolved
	}
	sum := sha256.Sum256([]byte(strings.ToLower(cleaned)))
	return hex.EncodeToString(sum[:12])
}

func sanitizeToken(raw string, maxLen int) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(raw) {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
			if maxLen > 0 && b.Len() >= maxLen {
				break
			}
		}
	}
	if b.Len() == 0 {
		return "local"
	}
	return b.String()
}

func validWindowsPipeName(endpoint string) bool {
	if len(endpoint) <= len(windowsPipePrefix) || len(endpoint) > 200 {
		return false
	}
	if !strings.EqualFold(endpoint[:len(windowsPipePrefix)], windowsPipePrefix) {
		return false
	}
	name := endpoint[len(`\\.\pipe\`):]
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			continue
		}
		return false
	}
	return !strings.Contains(name, "..")
}

type loopbackPipeConn struct {
	net.Conn
}

func (c loopbackPipeConn) LocalAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0}
}

func (c loopbackPipeConn) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0}
}
