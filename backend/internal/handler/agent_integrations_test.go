package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"qisitv/backend/internal/agentconnect"
	"qisitv/backend/internal/agentops"
)

type integrationTestDirs struct{ dir string }

func (d integrationTestDirs) DataDir() string { return d.dir }

type fakeIntegrationRegistry struct {
	mu         sync.Mutex
	items      []agentops.ClientRegistration
	next       int
	failRevoke map[string]bool
	listErr    error
}

func (f *fakeIntegrationRegistry) List() []agentops.ClientRegistration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]agentops.ClientRegistration(nil), f.items...)
}

func (f *fakeIntegrationRegistry) ListLive() ([]agentops.ClientRegistration, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	return append([]agentops.ClientRegistration(nil), f.items...), nil
}

func (f *fakeIntegrationRegistry) RegisterClient(kind, label string, mode agentops.ClientMode, approval agentops.ClientApprovalMode) (agentops.ClientRegistration, string, error) {
	return f.RegisterClientOrigin(kind, label, "", mode, approval)
}

func (f *fakeIntegrationRegistry) RegisterClientOrigin(kind, label, origin string, mode agentops.ClientMode, approval agentops.ClientApprovalMode) (agentops.ClientRegistration, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for {
		f.next++
		id := fmt.Sprintf("client-%d", f.next)
		used := false
		for _, item := range f.items {
			if item.ID == id {
				used = true
				break
			}
		}
		if !used {
			registration := agentops.ClientRegistration{
				ID:           id,
				Label:        label,
				Kind:         agentops.NormalizeClientKind(kind),
				Origin:       origin,
				Mode:         mode,
				ApprovalMode: approval,
			}
			f.items = append(f.items, registration)
			return registration, "token-" + registration.ID, nil
		}
	}
}

func (f *fakeIntegrationRegistry) Revoke(clientID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failRevoke[clientID] {
		return errors.New("revoke failed")
	}
	live := f.items[:0]
	for _, item := range f.items {
		if item.ID != clientID {
			live = append(live, item)
		}
	}
	f.items = live
	return nil
}

type fakeIntegrationRunner struct {
	mu            sync.Mutex
	paths         map[string]string
	present       bool
	addErr        error
	removeErr     error
	getErr        error
	blockFirstAdd bool
	runs          int
	removeCalls   int
}

func (f *fakeIntegrationRunner) LookPath(file string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if path := f.paths[file]; path != "" {
		return path, nil
	}
	return "", exec.ErrNotFound
}

func (f *fakeIntegrationRunner) Run(ctx context.Context, _ string, args []string, _ []string) error {
	f.mu.Lock()
	f.runs++
	block := f.blockFirstAdd && len(args) > 1 && args[1] == "add"
	if block {
		f.blockFirstAdd = false
	}
	if len(args) > 1 && args[1] == "remove" {
		f.removeCalls++
	}
	f.mu.Unlock()
	if block {
		<-ctx.Done()
		return ctx.Err()
	}
	// Widen the window between register and revoke so an unlocked handler
	// would leave several live credentials.
	time.Sleep(2 * time.Millisecond)
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(args) < 2 {
		return nil
	}
	switch args[1] {
	case "add":
		if f.addErr != nil {
			return f.addErr
		}
		f.present = true
	case "remove":
		if f.removeErr != nil {
			return f.removeErr
		}
		f.present = false
	case "get":
		if f.getErr != nil {
			return f.getErr
		}
		if !f.present {
			return errors.New("not found")
		}
	}
	return nil
}

func (f *fakeIntegrationRunner) stats() (runs, removeCalls int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.runs, f.removeCalls
}

func integrationTestRouter(t *testing.T, registry agentClientRegistry, runner *fakeIntegrationRunner, dataDir string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	previousManager := newIntegrationManager
	previousCLI := integrationCLIPath
	home := t.TempDir()
	newIntegrationManager = func(_ string) *agentconnect.Manager {
		return &agentconnect.Manager{Home: home, DataDir: dataDir, Runner: runner, CLIDirs: []string{}, CommandTimeout: 2 * time.Second}
	}
	integrationCLIPath = func() (string, bool) { return "/fake/qisitv", true }
	t.Cleanup(func() {
		newIntegrationManager = previousManager
		integrationCLIPath = previousCLI
	})
	router := gin.New()
	trust := func(request *http.Request) bool {
		return request.Header.Get("X-Desktop-Token") == "launch" && request.Header.Get("X-Beeftv-UI-Bootstrap") == "ui"
	}
	RegisterAgentClientRoutes(router.Group("/api"), integrationTestDirs{dir: dataDir}, registry, trust)
	return router
}

func callIntegration(t *testing.T, router *gin.Engine, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var payload []byte
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		payload = encoded
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(payload))
	request.Host = "127.0.0.1:8080"
	request.RemoteAddr = "127.0.0.1:1234"
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Desktop-Token", "launch")
	request.Header.Set("X-Beeftv-UI-Bootstrap", "ui")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func decodeReason(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var envelope struct {
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode %s: %v", recorder.Body.String(), err)
	}
	return envelope.Reason
}

func decodeIntegration(t *testing.T, recorder *httptest.ResponseRecorder) (map[string]any, string) {
	t.Helper()
	var envelope struct {
		Data struct {
			Integration map[string]any `json:"integration"`
			Warning     string         `json:"warning"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode %s: %v", recorder.Body.String(), err)
	}
	return envelope.Data.Integration, envelope.Data.Warning
}

func getIntegration(t *testing.T, router *gin.Engine, kind string) map[string]any {
	t.Helper()
	response := callIntegration(t, router, http.MethodGet, "/api/agent-clients", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d %s", response.Code, response.Body.String())
	}
	var envelope struct {
		Data struct {
			Integrations []map[string]any `json:"integrations"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	for _, item := range envelope.Data.Integrations {
		if item["kind"] == kind {
			return item
		}
	}
	t.Fatalf("integration %s not found in %+v", kind, envelope.Data.Integrations)
	return nil
}

func TestConcurrentIntegrationConnectLeavesOneCredential(t *testing.T) {
	registry := &fakeIntegrationRegistry{failRevoke: map[string]bool{}}
	runner := &fakeIntegrationRunner{paths: map[string]string{"claude": "/fake/claude"}}
	dataDir := t.TempDir()
	router := integrationTestRouter(t, registry, runner, dataDir)

	var wait sync.WaitGroup
	for index := 0; index < 12; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			response := callIntegration(t, router, http.MethodPost, "/api/agent-clients/integrations", map[string]string{"kind": "claude"})
			if response.Code != http.StatusOK {
				t.Errorf("connect status = %d body = %s", response.Code, response.Body.String())
			}
		}()
	}
	wait.Wait()

	items := registry.List()
	if len(items) != 1 {
		t.Fatalf("live credentials = %d, want 1: %+v", len(items), items)
	}
	if items[0].Origin != "one-click:claude" {
		t.Fatalf("origin = %q", items[0].Origin)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "agent-clients", "claude.token")); err != nil {
		t.Fatalf("token file: %v", err)
	}
}

func TestConnectRevokeFailureIsReportedAndVisibleAsRetry(t *testing.T) {
	registry := &fakeIntegrationRegistry{
		failRevoke: map[string]bool{"client-1": true},
		items: []agentops.ClientRegistration{{
			ID: "client-1", Label: "Claude Code", Kind: agentops.ClientKindClaude,
			Origin: "one-click:claude", Mode: agentops.ClientReadWrite,
		}},
	}
	runner := &fakeIntegrationRunner{paths: map[string]string{"claude": "/fake/claude"}}
	router := integrationTestRouter(t, registry, runner, t.TempDir())

	response := callIntegration(t, router, http.MethodPost, "/api/agent-clients/integrations", map[string]string{"kind": "claude"})
	if response.Code != http.StatusPreconditionFailed || decodeReason(t, response) != "revoke_failed" {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	integration := getIntegration(t, router, "claude")
	if integration["connected"] != true || integration["needsRetry"] != true {
		t.Fatalf("integration = %+v", integration)
	}
}

func TestConnectCleanupRevokeFailureIsReported(t *testing.T) {
	registry := &fakeIntegrationRegistry{failRevoke: map[string]bool{"client-1": true}}
	runner := &fakeIntegrationRunner{paths: map[string]string{"claude": "/fake/claude"}, addErr: errors.New("add failed")}
	dataDir := t.TempDir()
	router := integrationTestRouter(t, registry, runner, dataDir)

	response := callIntegration(t, router, http.MethodPost, "/api/agent-clients/integrations", map[string]string{"kind": "claude"})
	if response.Code != http.StatusPreconditionFailed || decodeReason(t, response) != "connect_cleanup_failed" {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	integration := getIntegration(t, router, "claude")
	if integration["needsRetry"] != true {
		t.Fatalf("integration = %+v", integration)
	}
	// The orphan credential must stay visible through the registry so the
	// user can retry disconnect.
	registry.mu.Lock()
	registry.failRevoke = map[string]bool{}
	registry.mu.Unlock()
	response = callIntegration(t, router, http.MethodDelete, "/api/agent-clients/integrations/claude", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("disconnect status = %d %s", response.Code, response.Body.String())
	}
	if len(registry.List()) != 0 {
		t.Fatal("orphan credential was not revoked")
	}
	if integration := getIntegration(t, router, "claude"); integration["connected"] != false || integration["needsRetry"] != false {
		t.Fatalf("record was not cleared: %+v", integration)
	}
}

func TestWriteTokenFailureRevokeFailureKeepsCredentialVisible(t *testing.T) {
	registry := &fakeIntegrationRegistry{failRevoke: map[string]bool{"client-1": true}}
	runner := &fakeIntegrationRunner{paths: map[string]string{"claude": "/fake/claude"}}
	dataDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataDir, "agent-clients", "claude.token"), 0o755); err != nil {
		t.Fatal(err)
	}
	router := integrationTestRouter(t, registry, runner, dataDir)

	response := callIntegration(t, router, http.MethodPost, "/api/agent-clients/integrations", map[string]string{"kind": "claude"})
	if response.Code != http.StatusPreconditionFailed || decodeReason(t, response) != "connect_cleanup_failed" {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if integration := getIntegration(t, router, "claude"); integration["needsRetry"] != true {
		t.Fatalf("integration = %+v", integration)
	}

	registry.mu.Lock()
	registry.failRevoke = map[string]bool{}
	registry.mu.Unlock()
	response = callIntegration(t, router, http.MethodDelete, "/api/agent-clients/integrations/claude", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("disconnect status = %d %s", response.Code, response.Body.String())
	}
	if len(registry.List()) != 0 {
		t.Fatal("orphan credential was not revoked")
	}
	if integration := getIntegration(t, router, "claude"); integration["connected"] != false || integration["needsRetry"] != false {
		t.Fatalf("record was not cleared: %+v", integration)
	}
}

func TestDisconnectRevokeFailureCanBeRetried(t *testing.T) {
	registry := &fakeIntegrationRegistry{
		failRevoke: map[string]bool{"client-1": true},
		items: []agentops.ClientRegistration{{
			ID: "client-1", Label: "Claude Code", Kind: agentops.ClientKindClaude,
			Origin: "one-click:claude", Mode: agentops.ClientReadWrite,
		}},
	}
	runner := &fakeIntegrationRunner{paths: map[string]string{"claude": "/fake/claude"}, present: true}
	dataDir := t.TempDir()
	seedIntegrationRecord(t, dataDir, "claude", "client-1")
	router := integrationTestRouter(t, registry, runner, dataDir)

	response := callIntegration(t, router, http.MethodDelete, "/api/agent-clients/integrations/claude", nil)
	if response.Code != http.StatusPreconditionFailed || decodeReason(t, response) != "revoke_failed" {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	// The credential is still live and visible; the record matches it.
	integration := getIntegration(t, router, "claude")
	if integration["connected"] != true {
		t.Fatalf("integration = %+v", integration)
	}

	registry.mu.Lock()
	registry.failRevoke = map[string]bool{}
	registry.mu.Unlock()
	response = callIntegration(t, router, http.MethodDelete, "/api/agent-clients/integrations/claude", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("retry status = %d %s", response.Code, response.Body.String())
	}
	if len(registry.List()) != 0 {
		t.Fatal("credential was not revoked on retry")
	}
	if integration := getIntegration(t, router, "claude"); integration["connected"] != false {
		t.Fatalf("integration = %+v", integration)
	}
}

func TestStatusShowsRetryWhenRecordIsCorruptAndDisconnectRecovers(t *testing.T) {
	registry := &fakeIntegrationRegistry{
		items: []agentops.ClientRegistration{{
			ID: "client-1", Label: "Claude Code", Kind: agentops.ClientKindClaude,
			Origin: "one-click:claude", Mode: agentops.ClientReadWrite,
		}},
	}
	runner := &fakeIntegrationRunner{paths: map[string]string{"claude": "/fake/claude"}, present: true}
	dataDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataDir, "agent-clients"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "agent-clients", "integrations.json"), []byte("{bad-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	router := integrationTestRouter(t, registry, runner, dataDir)

	integration := getIntegration(t, router, "claude")
	if integration["connected"] != true || integration["needsRetry"] != true {
		t.Fatalf("integration = %+v", integration)
	}
	response := callIntegration(t, router, http.MethodDelete, "/api/agent-clients/integrations/claude", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("disconnect status = %d %s", response.Code, response.Body.String())
	}
	if len(registry.List()) != 0 {
		t.Fatal("credential was not revoked")
	}
	if integration := getIntegration(t, router, "claude"); integration["connected"] != false || integration["needsRetry"] != false {
		t.Fatalf("corrupt record was not reset: %+v", integration)
	}
}

func TestDisconnectRevokesEveryOneClickCredential(t *testing.T) {
	registry := &fakeIntegrationRegistry{
		items: []agentops.ClientRegistration{
			{ID: "client-1", Label: "Claude Code", Kind: agentops.ClientKindClaude, Origin: "one-click:claude", Mode: agentops.ClientReadWrite},
			{ID: "client-2", Label: "Claude Code", Kind: agentops.ClientKindClaude, Origin: "one-click:claude", Mode: agentops.ClientReadWrite},
		},
	}
	runner := &fakeIntegrationRunner{paths: map[string]string{"claude": "/fake/claude"}, present: true}
	dataDir := t.TempDir()
	seedIntegrationRecord(t, dataDir, "claude", "client-1")
	router := integrationTestRouter(t, registry, runner, dataDir)

	integration := getIntegration(t, router, "claude")
	if integration["connected"] != true || integration["needsRetry"] != true {
		t.Fatalf("two live credentials should need retry: %+v", integration)
	}
	response := callIntegration(t, router, http.MethodDelete, "/api/agent-clients/integrations/claude", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("disconnect status = %d %s", response.Code, response.Body.String())
	}
	if len(registry.List()) != 0 {
		t.Fatalf("not every credential was revoked: %+v", registry.List())
	}
}

func TestDisconnectRemoveFailureSucceedsWithWarning(t *testing.T) {
	registry := &fakeIntegrationRegistry{
		items: []agentops.ClientRegistration{{
			ID: "client-1", Label: "Claude Code", Kind: agentops.ClientKindClaude,
			Origin: "one-click:claude", Mode: agentops.ClientReadWrite,
		}},
	}
	runner := &fakeIntegrationRunner{paths: map[string]string{"claude": "/fake/claude"}, present: true, removeErr: errors.New("remove failed")}
	dataDir := t.TempDir()
	seedIntegrationRecord(t, dataDir, "claude", "client-1")
	router := integrationTestRouter(t, registry, runner, dataDir)

	response := callIntegration(t, router, http.MethodDelete, "/api/agent-clients/integrations/claude", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	integration, warning := decodeIntegration(t, response)
	if integration["connected"] != false || integration["needsRetry"] != false {
		t.Fatalf("integration = %+v", integration)
	}
	if warning != "qisiTV 已停止接受 Claude Code 的访问。Claude Code 里的 qisiTV 连接没能自动移除，可以在它的 MCP 设置里手动删除。" {
		t.Fatalf("warning = %q", warning)
	}
	if len(registry.List()) != 0 {
		t.Fatal("credential was not revoked")
	}
	if _, err := os.Stat(filepath.Join(dataDir, "agent-clients", "claude.token")); !os.IsNotExist(err) {
		t.Fatalf("token file was not deleted, err = %v", err)
	}
}

func TestPreflightFailureIssuesNoCredentialAndRemovesNoConfig(t *testing.T) {
	registry := &fakeIntegrationRegistry{failRevoke: map[string]bool{}}
	runner := &fakeIntegrationRunner{paths: map[string]string{"claude": `C:\Tools\claude.cmd`}}
	dataDir := filepath.Join(t.TempDir(), "a&b")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	router := integrationTestRouter(t, registry, runner, dataDir)

	response := callIntegration(t, router, http.MethodPost, "/api/agent-clients/integrations", map[string]string{"kind": "claude"})
	if response.Code != http.StatusPreconditionFailed || decodeReason(t, response) != "agent_command_unsafe" {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if len(registry.List()) != 0 {
		t.Fatal("preflight failure must not issue a credential")
	}
	if runs, _ := runner.stats(); runs != 0 {
		t.Fatalf("preflight failure ran the CLI %d times", runs)
	}
	if integration := getIntegration(t, router, "claude"); integration["detected"] != false {
		t.Fatalf("detected = %+v", integration)
	}
}

func TestConnectGetFailureRevokesNewCredentialAndToken(t *testing.T) {
	registry := &fakeIntegrationRegistry{failRevoke: map[string]bool{}}
	runner := &fakeIntegrationRunner{paths: map[string]string{"claude": "/fake/claude"}, getErr: errors.New("get failed")}
	dataDir := t.TempDir()
	router := integrationTestRouter(t, registry, runner, dataDir)

	response := callIntegration(t, router, http.MethodPost, "/api/agent-clients/integrations", map[string]string{"kind": "claude"})
	if response.Code != http.StatusPreconditionFailed || decodeReason(t, response) != "agent_cli_failed" {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if len(registry.List()) != 0 {
		t.Fatal("new credential was not revoked after get failure")
	}
	if _, err := os.Stat(filepath.Join(dataDir, "agent-clients", "claude.token")); !os.IsNotExist(err) {
		t.Fatalf("token file was not deleted, err = %v", err)
	}
	if integration := getIntegration(t, router, "claude"); integration["connected"] != false {
		t.Fatalf("integration = %+v", integration)
	}
}

func TestConnectTimeoutRevokesNewCredentialAndReleasesLock(t *testing.T) {
	registry := &fakeIntegrationRegistry{failRevoke: map[string]bool{}}
	runner := &fakeIntegrationRunner{paths: map[string]string{"claude": "/fake/claude"}, blockFirstAdd: true}
	dataDir := t.TempDir()
	router := integrationTestRouter(t, registry, runner, dataDir)
	// Tighten the manager timeout for this test.
	previous := newIntegrationManager
	newIntegrationManager = func(_ string) *agentconnect.Manager {
		return &agentconnect.Manager{Home: t.TempDir(), DataDir: dataDir, Runner: runner, CLIDirs: []string{}, CommandTimeout: 50 * time.Millisecond}
	}
	defer func() { newIntegrationManager = previous }()

	start := time.Now()
	response := callIntegration(t, router, http.MethodPost, "/api/agent-clients/integrations", map[string]string{"kind": "claude"})
	if response.Code != http.StatusPreconditionFailed || decodeReason(t, response) != "agent_cli_failed" {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("timed out too slowly: %s", elapsed)
	}
	if len(registry.List()) != 0 {
		t.Fatal("new credential was not revoked after timeout")
	}
	if _, err := os.Stat(filepath.Join(dataDir, "agent-clients", "claude.token")); !os.IsNotExist(err) {
		t.Fatalf("token file was not deleted after timeout, err = %v", err)
	}
	// The lock must have been released; the second attempt can succeed.
	response = callIntegration(t, router, http.MethodPost, "/api/agent-clients/integrations", map[string]string{"kind": "claude"})
	if response.Code != http.StatusOK {
		t.Fatalf("second connect status = %d %s", response.Code, response.Body.String())
	}
}

func TestStatusDoesNotProbeAfterConnect(t *testing.T) {
	registry := &fakeIntegrationRegistry{failRevoke: map[string]bool{}}
	runner := &fakeIntegrationRunner{paths: map[string]string{"claude": "/fake/claude"}}
	router := integrationTestRouter(t, registry, runner, t.TempDir())

	response := callIntegration(t, router, http.MethodPost, "/api/agent-clients/integrations", map[string]string{"kind": "claude"})
	if response.Code != http.StatusOK {
		t.Fatalf("connect status = %d %s", response.Code, response.Body.String())
	}
	before, _ := runner.stats()
	runner.mu.Lock()
	runner.present = false
	runner.mu.Unlock()

	integration := getIntegration(t, router, "claude")
	if integration["connected"] != true {
		t.Fatalf("record-based status lost the connection: %+v", integration)
	}
	after, _ := runner.stats()
	if after != before {
		t.Fatalf("status probe ran the CLI: before=%d after=%d", before, after)
	}
}

func TestManualConnectionNamedLikeIntegrationIsNotRevoked(t *testing.T) {
	registry := &fakeIntegrationRegistry{
		failRevoke: map[string]bool{},
		items: []agentops.ClientRegistration{{
			ID: "manual-1", Label: "Claude Code", Kind: agentops.ClientKindClaude,
			Mode: agentops.ClientReadWrite,
		}},
	}
	runner := &fakeIntegrationRunner{paths: map[string]string{"claude": "/fake/claude"}}
	router := integrationTestRouter(t, registry, runner, t.TempDir())

	response := callIntegration(t, router, http.MethodPost, "/api/agent-clients/integrations", map[string]string{"kind": "claude"})
	if response.Code != http.StatusOK {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	items := registry.List()
	if len(items) != 2 {
		t.Fatalf("manual registration was revoked: %+v", items)
	}
	foundManual := false
	for _, item := range items {
		if item.ID == "manual-1" && item.Origin == "" {
			foundManual = true
		}
	}
	if !foundManual {
		t.Fatalf("manual connection missing: %+v", items)
	}
}

func TestIntegrationRoutesAreAbsentWithoutDesktopTrust(t *testing.T) {
	gin.SetMode(gin.TestMode)
	registry := &fakeIntegrationRegistry{failRevoke: map[string]bool{}}
	router := gin.New()
	RegisterAgentClientRoutes(router.Group("/api"), integrationTestDirs{dir: t.TempDir()}, registry, nil)

	response := callIntegration(t, router, http.MethodPost, "/api/agent-clients/integrations", map[string]string{"kind": "claude"})
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
}

func seedIntegrationRecord(t *testing.T, dataDir, kind, clientID string) {
	t.Helper()
	manager := &agentconnect.Manager{Home: t.TempDir(), DataDir: dataDir, CLIDirs: []string{}}
	path, err := manager.WriteToken(agentops.ClientKind(kind), "seed-token")
	if err != nil {
		t.Fatal(err)
	}
	record := agentconnect.IntegrationRecord{Kind: kind, ClientID: clientID, TokenFile: path, ConnectedAt: time.Now().UTC()}
	if err := manager.SaveRecord(record); err != nil {
		t.Fatal(err)
	}
}

// 凭据登记读不出时，不能把「读不出」当成「没有凭据」：断开要失败并保留 token 与记录，
// 状态显示需要重试，接入也不签发新凭据。
func TestUnreadableRegistryNeverReportsDisconnectOrIssuesCredential(t *testing.T) {
	registry := &fakeIntegrationRegistry{
		items: []agentops.ClientRegistration{{
			ID: "client-1", Label: "Claude Code", Kind: agentops.ClientKindClaude,
			Origin: "one-click:claude", Mode: agentops.ClientReadWrite,
		}},
		listErr: errors.New("registry unreadable"),
	}
	runner := &fakeIntegrationRunner{paths: map[string]string{"claude": "/fake/claude"}, present: true}
	dataDir := t.TempDir()
	seedIntegrationRecord(t, dataDir, "claude", "client-1")
	router := integrationTestRouter(t, registry, runner, dataDir)

	if integration := getIntegration(t, router, "claude"); integration["needsRetry"] != true {
		t.Fatalf("integration = %+v", integration)
	}
	response := callIntegration(t, router, http.MethodDelete, "/api/agent-clients/integrations/claude", nil)
	if response.Code != http.StatusPreconditionFailed || decodeReason(t, response) != "registry_unreadable" {
		t.Fatalf("disconnect = %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(dataDir, "agent-clients", "claude.token")); err != nil {
		t.Fatalf("token file must be kept for retry: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "agent-clients", "integrations.json")); err != nil {
		t.Fatalf("record must be kept for retry: %v", err)
	}
	before := len(registry.List())
	response = callIntegration(t, router, http.MethodPost, "/api/agent-clients/integrations", map[string]string{"kind": "claude"})
	if response.Code != http.StatusPreconditionFailed || decodeReason(t, response) != "registry_unreadable" {
		t.Fatalf("connect = %d %s", response.Code, response.Body.String())
	}
	if after := len(registry.List()); after != before {
		t.Fatalf("connect issued a credential while the registry was unreadable: %d -> %d", before, after)
	}
}
