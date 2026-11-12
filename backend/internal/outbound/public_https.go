package outbound

import (
	"context"
	"qisitv/backend/internal/desktopnet"
	"net"
	"net/http"
	"net/url"
	"strings"
)

type publicHTTPSContextKey struct{}

// WithPublicHTTPS validates media and storage URLs against the outbound host
// policy: HTTPS is required for public hosts, while local/private hosts and
// Fake-IP/TUN routes follow CANVAS_ALLOW_PRIVATE_UPSTREAMS (#177).
func WithPublicHTTPS(ctx context.Context) context.Context {
	return context.WithValue(ctx, publicHTTPSContextKey{}, true)
}

func requiresPublicHTTPS(ctx context.Context) bool {
	value, _ := ctx.Value(publicHTTPSContextKey{}).(bool)
	return value
}

func resolvePublicHost(ctx context.Context, host string) ([]net.IP, error) {
	host = normalizeOutboundHost(host)
	allowPrivateHost := allowPrivateUpstreams() || AllowedPrivateUpstreamHost(host)
	addresses, err := resolveOutboundHostWithPolicy(ctx, host, allowPrivateHost)
	if err != nil {
		return nil, err
	}
	if !allowPrivateHost {
		for _, ip := range addresses {
			if blockedCustomRelayIP(ip) {
				return nil, BadAuthRequest("媒体地址不允许访问内网或保留地址")
			}
		}
	}
	return addresses, nil
}

func ValidatePublicHTTPSURLContext(ctx context.Context, raw string) (*url.URL, error) {
	return validatePublicHTTPSURLContext(ctx, raw, resolvePublicHost)
}

func validatePublicHTTPSURLContext(ctx context.Context, raw string, resolve func(context.Context, string) ([]net.IP, error)) (*url.URL, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, BadAuthRequest("媒体地址需要安全的 HTTPS 链接")
	}
	if parsed.Scheme == "http" && !(allowPrivateUpstreams() || AllowedPrivateUpstreamHost(parsed.Hostname())) {
		return nil, BadAuthRequest("媒体地址需要安全的 HTTPS 链接")
	}
	if _, err := resolve(ctx, parsed.Hostname()); err != nil {
		return nil, err
	}
	return parsed, nil
}

var publicHTTPSTransport = newOutboundTransport(resolvePublicHost)

type outboundPolicyTransport struct{}

// RequestNetworkRoute describes the transport selected for diagnostics without
// exposing proxy credentials or assuming every client uses our transport.
func RequestNetworkRoute(req *http.Request, transport http.RoundTripper) string {
	proxy := desktopnet.Proxy
	switch value := transport.(type) {
	case *http.Transport:
		proxy = value.Proxy
	case outboundPolicyTransport:
	default:
		return ""
	}
	if proxy != nil {
		if selected, err := proxy(req); err == nil && selected != nil {
			return "proxy"
		}
	}
	return "direct"
}

func (outboundPolicyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if !requiresPublicHTTPS(req.Context()) {
		return outboundTransport.RoundTrip(req)
	}
	// Validate on every dispatch, including pooled connections and redirects.
	// Direct new connections resolve once more and dial only checked IPs.
	if _, err := ValidatePublicHTTPSURLContext(req.Context(), req.URL.String()); err != nil {
		return nil, err
	}
	return publicHTTPSTransport.RoundTrip(req)
}
