// Package browserbridge forwards local Agent commands to an explicitly paired browser.
// The browser owns the project files; the connector never opens a project database.
package browserbridge

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const DefaultPort = 17372
const Version = "0.1.0"
const MaxAssetBytes = 32 << 20
const maxMessageBytes = 46 << 20

type RPCError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *RPCError) Error() string { return e.Code + ": " + e.Message }

type response struct {
	ID          string    `json:"id"`
	Result      any       `json:"result,omitempty"`
	Error       *RPCError `json:"error,omitempty"`
	Type        string    `json:"type,omitempty"`
	ProjectID   string    `json:"projectId,omitempty"`
	ProjectName string    `json:"projectName,omitempty"`
}
type session struct {
	ID          string
	Token       string
	Origin      string
	Expires     time.Time
	Conn        *websocket.Conn
	WriteMu     sync.Mutex
	ProjectID   string
	ProjectName string
	Pending     map[string]chan response
}
type SessionInfo struct {
	SessionID   string `json:"sessionId"`
	ProjectID   string `json:"projectId,omitempty"`
	ProjectName string `json:"projectName,omitempty"`
}

type Server struct {
	mu          sync.Mutex
	agentToken  string
	port        int
	code        string
	codeExpires time.Time
	attempts    int
	sessions    map[string]*session
	CallTimeout time.Duration
}

func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func NewServer(agentToken string, port int) *Server {
	s := &Server{agentToken: agentToken, port: port, sessions: make(map[string]*session), CallTimeout: 90 * time.Second}
	s.NewPairCode()
	return s
}
func (s *Server) NewPairCode() (string, time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.code, s.codeExpires, s.attempts = strings.ToUpper(randomToken(6)), time.Now().Add(10*time.Minute), 0
	return s.code, s.codeExpires
}
func allowedOrigin(origin string) bool {
	switch origin {
	case "https://cheeser.link", "https://www.cheeser.link", "http://127.0.0.1:5174", "http://localhost:5174", "http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:4321", "http://localhost:4321":
		return true
	default:
		return false
	}
}
func secureEqual(a, b string) bool {
	return len(a) > 0 && len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": &RPCError{Code: code, Message: message}})
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil || port != strconv.Itoa(s.port) || (host != "127.0.0.1" && host != "localhost") {
		fail(w, 403, "INVALID_HOST", "Connector accepts only its loopback host and port")
		return
	}
	remote, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || !net.ParseIP(remote).IsLoopback() {
		fail(w, 403, "INVALID_PEER", "Loopback requests only")
		return
	}
	origin := r.Header.Get("Origin")
	if origin != "" {
		if !allowedOrigin(origin) {
			fail(w, 403, "INVALID_ORIGIN", "Website origin is not allowed")
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method == http.MethodOptions {
		if origin == "" {
			fail(w, 403, "ORIGIN_REQUIRED", "Website origin required")
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	switch r.URL.Path {
	case "/health":
		if r.Method != http.MethodGet {
			fail(w, 405, "METHOD_NOT_ALLOWED", "GET required")
			return
		}
		writeJSON(w, 200, map[string]any{"name": "qisitv-connect", "version": Version, "connected": len(s.Sessions())})
	case "/pair":
		s.pair(w, r)
	case "/ws":
		s.websocket(w, r)
	case "/agent/call", "/agent/pair-code", "/agent/sessions":
		if origin != "" || !secureEqual(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), s.agentToken) {
			fail(w, 401, "UNAUTHORIZED", "Local Agent authentication required")
			return
		}
		if r.URL.Path == "/agent/sessions" && r.Method == http.MethodGet {
			writeJSON(w, 200, map[string]any{"sessions": s.Sessions()})
			return
		}
		if r.Method != http.MethodPost {
			fail(w, 405, "METHOD_NOT_ALLOWED", "POST required")
			return
		}
		if r.URL.Path == "/agent/pair-code" {
			code, expiry := s.NewPairCode()
			writeJSON(w, 200, map[string]any{"code": code, "expiresAt": expiry})
			return
		}
		var input struct {
			Operation string         `json:"operation"`
			Args      map[string]any `json:"args"`
		}
		if err := decodeBody(w, r, maxMessageBytes, &input); err != nil {
			fail(w, 400, "INVALID_REQUEST", "Invalid or oversized Agent command")
			return
		}
		result, err := s.Call(r.Context(), input.Operation, input.Args)
		if err != nil {
			var rpc *RPCError
			if !errors.As(err, &rpc) {
				rpc = &RPCError{Code: "COMMAND_FAILED", Message: err.Error()}
			}
			writeJSON(w, 400, map[string]any{"error": rpc})
			return
		}
		writeJSON(w, 200, map[string]any{"result": result})
	default:
		fail(w, 404, "NOT_FOUND", "Unknown connector endpoint")
	}
}
func decodeBody(w http.ResponseWriter, r *http.Request, max int64, out any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, max))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("one JSON object required")
	}
	return nil
}
func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.Header.Get("Origin") == "" {
		fail(w, 403, "ORIGIN_REQUIRED", "Pair from the qisiTV website")
		return
	}
	var input struct {
		Code string `json:"code"`
	}
	if decodeBody(w, r, 1024, &input) != nil {
		fail(w, 400, "INVALID_REQUEST", "Pairing code required")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.attempts >= 5 || time.Now().After(s.codeExpires) || s.code == "" {
		fail(w, 403, "PAIR_CODE_EXPIRED", "Run qisitv-connect pair-code for a new code")
		return
	}
	s.attempts++
	if !secureEqual(strings.TrimSpace(input.Code), s.code) {
		fail(w, 403, "INVALID_PAIR_CODE", "Incorrect pairing code")
		return
	}
	s.code = ""
	for token, session := range s.sessions {
		if time.Now().After(session.Expires) && session.Conn == nil {
			delete(s.sessions, token)
		}
	}
	if len(s.sessions) >= 8 {
		fail(w, 409, "SESSION_LIMIT", "Restart the connector to revoke old browser sessions")
		return
	}
	token := randomToken(32)
	entry := &session{ID: randomToken(12), Token: token, Origin: r.Header.Get("Origin"), Expires: time.Now().Add(12 * time.Hour), Pending: make(map[string]chan response)}
	s.sessions[token] = entry
	writeJSON(w, 200, map[string]any{"token": token, "sessionId": entry.ID, "expiresAt": entry.Expires})
}
func (s *Server) websocket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || r.URL.RawQuery != "" {
		fail(w, 400, "INVALID_REQUEST", "WebSocket credentials must use the subprotocol, never the URL")
		return
	}
	var token string
	for _, protocol := range websocket.Subprotocols(r) {
		if strings.HasPrefix(protocol, "qisitv-auth.") {
			token = strings.TrimPrefix(protocol, "qisitv-auth.")
		}
	}
	s.mu.Lock()
	entry := s.sessions[token]
	if entry == nil || entry.Origin != r.Header.Get("Origin") || time.Now().After(entry.Expires) {
		s.mu.Unlock()
		fail(w, 401, "UNAUTHORIZED", "Pair this browser again")
		return
	}
	if entry.Conn != nil {
		s.mu.Unlock()
		fail(w, 409, "ALREADY_CONNECTED", "This paired session already has an open browser")
		return
	}
	upgrader := websocket.Upgrader{Subprotocols: []string{"qisitv-v1"}, CheckOrigin: func(r *http.Request) bool { return allowedOrigin(r.Header.Get("Origin")) }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.mu.Unlock()
		return
	}
	entry.Conn = conn
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		entry.Conn = nil
		for id, ch := range entry.Pending {
			ch <- response{Error: &RPCError{Code: "BROWSER_DISCONNECTED", Message: "Browser disconnected; write outcome may be unknown. Read the project before any new edit; do not retry automatically."}}
			delete(entry.Pending, id)
		}
		s.mu.Unlock()
		_ = conn.Close()
	}()
	conn.SetReadLimit(maxMessageBytes)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Minute))
		var reply response
		if err := conn.ReadJSON(&reply); err != nil {
			return
		}
		s.mu.Lock()
		if reply.Type == "hello" {
			entry.ProjectID = reply.ProjectID
			entry.ProjectName = reply.ProjectName
		}
		if ch, exists := entry.Pending[reply.ID]; exists {
			delete(entry.Pending, reply.ID)
			ch <- reply
		}
		s.mu.Unlock()
		if reply.Type == "ping" {
			entry.WriteMu.Lock()
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			err = conn.WriteJSON(map[string]any{"type": "pong"})
			entry.WriteMu.Unlock()
			if err != nil {
				return
			}
		}
	}
}
func (s *Server) Sessions() []SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := []SessionInfo{}
	for _, entry := range s.sessions {
		if entry.Conn != nil {
			list = append(list, SessionInfo{SessionID: entry.ID, ProjectID: entry.ProjectID, ProjectName: entry.ProjectName})
		}
	}
	return list
}
func (s *Server) Call(ctx context.Context, operation string, args map[string]any) (any, error) {
	if args == nil {
		args = map[string]any{}
	}
	if operation == "canvas_list_sessions" {
		return map[string]any{"sessions": s.Sessions()}, nil
	}
	if err := validateWireArgs(operation, args); err != nil {
		return nil, &RPCError{Code: "INVALID_ARGUMENTS", Message: err.Error()}
	}
	s.mu.Lock()
	var target *session
	wanted, _ := args["sessionId"].(string)
	for _, entry := range s.sessions {
		if entry.Conn == nil || time.Now().After(entry.Expires) {
			continue
		}
		if wanted != "" && entry.ID != wanted {
			continue
		}
		if target != nil {
			s.mu.Unlock()
			return nil, &RPCError{Code: "AMBIGUOUS_TARGET", Message: "Multiple websites are connected. Call canvas_list_sessions and pass the intended sessionId."}
		}
		target = entry
	}
	if target == nil {
		s.mu.Unlock()
		return nil, &RPCError{Code: "BROWSER_NOT_CONNECTED", Message: "Open qisiTV in your browser and pair the local connector first."}
	}
	id := randomToken(16)
	ch := make(chan response, 1)
	target.Pending[id] = ch
	conn := target.Conn
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(target.Pending, id); s.mu.Unlock() }()
	forward := make(map[string]any, len(args))
	for key, value := range args {
		if key != "sessionId" {
			forward[key] = value
		}
	}
	target.WriteMu.Lock()
	_ = conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
	err := conn.WriteJSON(map[string]any{"id": id, "operation": operation, "args": forward})
	target.WriteMu.Unlock()
	if err != nil {
		return nil, &RPCError{Code: "DELIVERY_UNCERTAIN", Message: "Command delivery failed. Read the latest project before editing; do not retry automatically."}
	}
	timer := time.NewTimer(s.CallTimeout)
	defer timer.Stop()
	select {
	case reply := <-ch:
		if reply.Error != nil {
			return nil, reply.Error
		}
		return reply.Result, nil
	case <-ctx.Done():
		return nil, &RPCError{Code: "CALL_CANCELLED", Message: "Agent stopped waiting. The browser may still finish the command; do not retry automatically."}
	case <-timer.C:
		return nil, &RPCError{Code: "CALL_TIMEOUT", Message: fmt.Sprintf("Browser did not reply within %s. The command may have succeeded; inspect the project or task list before another write.", s.CallTimeout)}
	}
}
