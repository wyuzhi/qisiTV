package browserbridge

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

const ManagedIdleGrace = 30 * time.Second
const ManagedLeaseTTL = 45 * time.Second
const ManagedHeartbeat = 10 * time.Second

type ServiceIdentity struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Managed bool   `json:"managed"`
	Proof   string `json:"proof"`
}

func identityProof(token, challenge string, identity ServiceIdentity) string {
	h := hmac.New(sha256.New, []byte(token))
	fmt.Fprintf(h, "qisitv-service-v1\n%s\n%s\n%s\n%t", challenge, identity.Name, identity.Version, identity.Managed)
	return hex.EncodeToString(h.Sum(nil))
}

// Authenticate proves ownership of the local configuration before sending its
// bearer credential. An unrelated process on the same port cannot impersonate
// qisiTV by returning a plausible health response.
func (c *Client) Authenticate(ctx context.Context) (ServiceIdentity, error) {
	challenge := randomToken(32)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.config.Address+"/identity?challenge="+url.QueryEscape(challenge), nil)
	if err != nil {
		return ServiceIdentity{}, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return ServiceIdentity{}, err
	}
	defer resp.Body.Close()
	var identity ServiceIdentity
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 2048)).Decode(&identity) != nil || identity.Name != "qisitv-connect" || !secureEqual(identity.Proof, identityProof(c.config.AgentToken, challenge, identity)) {
		return ServiceIdentity{}, errors.New("local service identity could not be verified; stop the older qisiTV connector or check the occupied port")
	}
	if identity.Version != Version {
		return ServiceIdentity{}, fmt.Errorf("local qisiTV service version %s differs from MCP version %s; close the older connector and reload qisitv-web", identity.Version, Version)
	}
	return identity, nil
}

func (s *Server) identity(w http.ResponseWriter, r *http.Request) {
	challenge := r.URL.Query().Get("challenge")
	if r.Method != http.MethodGet || r.Header.Get("Origin") != "" || len(challenge) < 32 || len(challenge) > 128 {
		fail(w, 400, "INVALID_CHALLENGE", "A local service identity challenge is required")
		return
	}
	identity := ServiceIdentity{Name: "qisitv-connect", Version: Version, Managed: s.lifecycle != nil}
	identity.Proof = identityProof(s.agentToken, challenge, identity)
	writeJSON(w, 200, identity)
}

type leaseRegistry struct {
	mu      sync.Mutex
	leases  map[string]time.Time
	idleAt  time.Time
	ttl     time.Duration
	grace   time.Duration
	closing bool
}

func newLeaseRegistry(now time.Time, grace, ttl time.Duration) *leaseRegistry {
	return &leaseRegistry{leases: map[string]time.Time{}, idleAt: now, ttl: ttl, grace: grace}
}

func (l *leaseRegistry) update(now time.Time, id string, release bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closing {
		return false
	}
	if release {
		delete(l.leases, id)
		if len(l.leases) == 0 && l.idleAt.IsZero() {
			l.idleAt = now
		}
	} else {
		l.leases[id] = now.Add(l.ttl)
		l.idleAt = time.Time{}
	}
	return true
}

func (l *leaseRegistry) expire(now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for id, expires := range l.leases {
		if !now.Before(expires) {
			delete(l.leases, id)
		}
	}
	if len(l.leases) != 0 {
		return false
	}
	if l.idleAt.IsZero() {
		l.idleAt = now
	}
	if now.Sub(l.idleAt) >= l.grace {
		l.closing = true
		return true
	}
	return false
}

// ManageIdle must be called before serving HTTP. Browser sessions do not retain
// the service: only live MCP clients own leases, including clients in other chats.
func (s *Server) ManageIdle(ctx context.Context, grace, ttl time.Duration) <-chan struct{} {
	s.lifecycle = newLeaseRegistry(time.Now(), grace, ttl)
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				if s.lifecycle.expire(now) {
					close(done)
					return
				}
			}
		}
	}()
	return done
}

func (s *Server) lease(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ID      string `json:"id"`
		Release bool   `json:"release"`
	}
	if decodeBody(w, r, 1024, &input) != nil || len(input.ID) < 24 || len(input.ID) > 128 {
		fail(w, 400, "INVALID_LEASE", "A client lease identifier is required")
		return
	}
	if s.lifecycle != nil && !s.lifecycle.update(time.Now(), input.ID, input.Release) {
		fail(w, 503, "SERVICE_STOPPING", "The idle qisiTV service is stopping; reconnect the MCP client")
		return
	}
	writeJSON(w, 200, map[string]any{"managed": s.lifecycle != nil})
}

// HoldLease never retries canvas commands or paid work. A heartbeat failure ends
// the MCP session so a new session can explicitly reconnect and inspect state.
func (c *Client) HoldLease(ctx context.Context) (release func(), failed <-chan error, err error) {
	id := randomToken(24)
	if _, err = c.Request(ctx, http.MethodPost, "/agent/lease", map[string]any{"id": id}); err != nil {
		return nil, nil, err
	}
	leaseCtx, cancel := context.WithCancel(ctx)
	errors := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(ManagedHeartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-leaseCtx.Done():
				return
			case <-ticker.C:
				requestCtx, requestCancel := context.WithTimeout(leaseCtx, 5*time.Second)
				_, err := c.Request(requestCtx, http.MethodPost, "/agent/lease", map[string]any{"id": id})
				requestCancel()
				if err != nil {
					if leaseCtx.Err() == nil {
						errors <- err
					}
					return
				}
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			<-done
			releaseCtx, releaseCancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer releaseCancel()
			_, _ = c.Request(releaseCtx, http.MethodPost, "/agent/lease", map[string]any{"id": id, "release": true})
		})
	}, errors, nil
}
