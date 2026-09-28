package browserbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestIdentityProofAuthenticatesBeforeSendingCredential(t *testing.T) {
	_, server := startTestServer(t)
	client := NewClient(Config{Address: server.URL, AgentToken: testAgentToken})
	identity, err := client.Authenticate(context.Background())
	if err != nil || identity.Name != "qisitv-connect" || identity.Managed {
		t.Fatalf("trusted manual service: %+v %v", identity, err)
	}
	var leakedCredential bool
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leakedCredential = r.Header.Get("Authorization") != ""
		_ = json.NewEncoder(w).Encode(ServiceIdentity{Name: "qisitv-connect", Version: Version, Proof: "not-a-proof"})
	}))
	defer fake.Close()
	if _, err := NewClient(Config{Address: fake.URL, AgentToken: testAgentToken}).Authenticate(context.Background()); err == nil {
		t.Fatal("unrelated local process was trusted")
	}
	if leakedCredential {
		t.Fatal("credential was sent before service identity was checked")
	}
	identity.Proof = identityProof(testAgentToken, "old-challenge", identity)
	if secureEqual(identity.Proof, identityProof(testAgentToken, "fresh-challenge", identity)) {
		t.Fatal("replayed identity challenge accepted")
	}
}

func TestLeaseOwnershipExpiryAndIdleShutdown(t *testing.T) {
	now := time.Now()
	registry := newLeaseRegistry(now, 30*time.Second, 45*time.Second)
	if !registry.update(now, "client-a", false) || !registry.update(now, "client-b", false) {
		t.Fatal("lease acquisition failed")
	}
	registry.update(now.Add(time.Second), "client-a", true)
	registry.update(now.Add(35*time.Second), "client-b", false)
	if registry.expire(now.Add(40 * time.Second)) {
		t.Fatal("closing one MCP terminated another client's service")
	}
	registry.update(now.Add(41*time.Second), "client-b", true)
	if registry.expire(now.Add(70 * time.Second)) {
		t.Fatal("idle grace was skipped")
	}
	if !registry.expire(now.Add(71*time.Second)) || registry.update(now.Add(72*time.Second), "client-c", false) {
		t.Fatal("idle shutdown did not atomically stop accepting leases")
	}

	crashed := newLeaseRegistry(now, 30*time.Second, 45*time.Second)
	crashed.update(now, "crashed-client", false)
	if crashed.expire(now.Add(44*time.Second)) || crashed.expire(now.Add(45*time.Second)) {
		t.Fatal("crashed client's lease skipped expiry/grace")
	}
	if !crashed.expire(now.Add(75 * time.Second)) {
		t.Fatal("crashed client retained service forever")
	}
	unclaimed := newLeaseRegistry(now, 30*time.Second, 45*time.Second)
	if !unclaimed.expire(now.Add(30 * time.Second)) {
		t.Fatal("startup with no MCP clients was not reclaimed")
	}
}

func TestMCPPairWorksWithoutBrowserAndDoesNotLeakAgentSecret(t *testing.T) {
	bridge, httpServer := startTestServer(t)
	server := NewMCPServer(NewClient(Config{Address: httpServer.URL, AgentToken: testAgentToken}))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer serverSession.Close()
	clientSession, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil).Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer clientSession.Close()
	reply, err := clientSession.CallTool(ctx, &mcp.CallToolParams{Name: "qisitv_pair", Arguments: map[string]any{}})
	if err != nil || reply.IsError {
		t.Fatalf("pair without browser: %+v %v", reply, err)
	}
	text := reply.Content[0].(*mcp.TextContent).Text
	if strings.Contains(text, testAgentToken) || strings.Contains(strings.ToLower(text), "agenttoken") {
		t.Fatal("pairing reply disclosed Agent credential")
	}
	var pair map[string]any
	if err := json.Unmarshal([]byte(text), &pair); err != nil {
		t.Fatal(err)
	}
	if pair["code"] != bridge.code || pair["website"] != "https://cheeser.link/qisitv/#/local" || pair["expiresAt"] == nil {
		t.Fatalf("incomplete pairing reply: %s", text)
	}
	status, _ := requestTest(t, httpServer, "POST", "/pair", testOrigin, "", map[string]any{"code": pair["code"]})
	if status != 200 {
		t.Fatal("MCP-provided code was not accepted by browser pairing")
	}
	status, _ = requestTest(t, httpServer, "POST", "/pair", testOrigin, "", map[string]any{"code": pair["code"]})
	if status != 403 {
		t.Fatal("MCP-provided code was reusable")
	}
	if err := validateArgs("qisitv_pair", map[string]any{"unexpected": true}, false); err == nil {
		t.Fatal("pair tool accepted arbitrary arguments")
	}
}

func TestLifecycleEndpointsKeepOriginAndAgentAuthBoundaries(t *testing.T) {
	bridge, server := startTestServer(t)
	bridge.lifecycle = newLeaseRegistry(time.Now(), time.Minute, time.Minute)
	for _, test := range []struct{ origin, token string }{{testOrigin, testAgentToken}, {"", "wrong-token"}} {
		status, _ := requestTest(t, server, "POST", "/agent/lease", test.origin, test.token, map[string]any{"id": strings.Repeat("x", 32)})
		if status != 401 {
			t.Fatal("unauthorized lease accepted")
		}
	}
	status, reply := requestTest(t, server, "POST", "/agent/lease", "", testAgentToken, map[string]any{"id": strings.Repeat("x", 32)})
	if status != 200 || reply["managed"] != true {
		t.Fatal("authorized lease was rejected")
	}
	encoded, _ := json.Marshal(reply)
	if bytes.Contains(encoded, []byte(testAgentToken)) {
		t.Fatal("lease exposed Agent credential")
	}
	status, _ = requestTest(t, server, "GET", "/identity?challenge="+strings.Repeat("a", 32), testOrigin, "", nil)
	if status != 400 {
		t.Fatal("website requested Agent identity proof")
	}
}

func TestRepeatedBrowserPairingDoesNotExhaustManagedService(t *testing.T) {
	bridge, server := startTestServer(t)
	for range 12 {
		pairTest(t, bridge, server)
	}
	if len(bridge.sessions) != 8 {
		t.Fatal("pending pairing capacity was not bounded")
	}
	for range 12 {
		token := pairTest(t, bridge, server)
		conn := connectTest(t, server, token)
		_ = conn.Close()
		deadline := time.Now().Add(time.Second)
		for {
			bridge.mu.Lock()
			_, retained := bridge.sessions[token]
			bridge.mu.Unlock()
			if !retained {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("disconnected browser retained its pairing token")
			}
			time.Sleep(time.Millisecond)
		}
	}
	var active []*websocket.Conn
	for range 8 {
		active = append(active, connectTest(t, server, pairTest(t, bridge, server)))
	}
	code, _ := bridge.NewPairCode()
	status, _ := requestTest(t, server, "POST", "/pair", testOrigin, "", map[string]any{"code": code})
	if status != 409 || len(bridge.Sessions()) != 8 {
		t.Fatal("new pairing evicted an active browser")
	}
}
