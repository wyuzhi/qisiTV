package handler

import (
	"errors"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentconnect"
	"infinite-canvas/backend/internal/agentops"
)

// One-click integration: the desktop UI asks the local backend to run the
// official agent CLI. Credentials are issued here and never returned to the
// page; the token is stored in a 0600 file under BeefTV's data directory.
//
// BeefTV's own record is the source of truth for UI state. Agent CLIs are only
// queried once immediately after connecting to confirm the write.

// Test seams: production uses the real home and bundled CLI path.
var (
	newIntegrationManager = func(dataDir string) *agentconnect.Manager {
		return agentconnect.NewDefault(dataDir)
	}
	integrationCLIPath = bundledCLIPath
)

type integrationLocks struct {
	mu     sync.Mutex
	byKind map[agentops.ClientKind]*sync.Mutex
}

func (l *integrationLocks) forKind(kind agentops.ClientKind) *sync.Mutex {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.byKind == nil {
		l.byKind = make(map[agentops.ClientKind]*sync.Mutex)
	}
	if l.byKind[kind] == nil {
		l.byKind[kind] = &sync.Mutex{}
	}
	return l.byKind[kind]
}

func integrationKinds() []agentops.ClientKind {
	return []agentops.ClientKind{agentops.ClientKindClaude, agentops.ClientKindCodex}
}

func integrationKind(raw string) agentops.ClientKind {
	kind := agentops.NormalizeClientKind(raw)
	switch kind {
	case agentops.ClientKindClaude, agentops.ClientKindCodex:
		return kind
	default:
		return ""
	}
}

func integrationName(kind agentops.ClientKind) string {
	switch kind {
	case agentops.ClientKindClaude:
		return "Claude Code"
	case agentops.ClientKindCodex:
		return "Codex"
	default:
		return ""
	}
}

// integrationClients lists live one-click credentials for kind. A registry that
// cannot be read is an error, never "no credentials": callers decide revocation
// and connection state from this list.
func integrationClients(clients agentClientRegistry, kind agentops.ClientKind) ([]agentops.ClientRegistration, error) {
	items, err := clients.ListLive()
	if err != nil {
		return nil, err
	}
	var matches []agentops.ClientRegistration
	for _, item := range items {
		if item.Kind == kind && agentconnect.IsIntegrationOrigin(kind, item.Origin) {
			matches = append(matches, item)
		}
	}
	return matches, nil
}

func registryUnreadable(kind agentops.ClientKind) error {
	return agentops.PreconditionFailed("registry_unreadable", "没能读取 BeefTV 的连接记录，暂时无法确认 "+integrationName(kind)+" 的连接状态。请稍后重试。", nil)
}

func integrationDetected(manager *agentconnect.Manager, kind agentops.ClientKind, cliPath, dataDir string) bool {
	if !manager.Detected(kind) {
		return false
	}
	preflight := agentconnect.Launch(cliPath, dataDir, manager.TokenPath(kind), agentops.ClientReadWrite, "preflight")
	return manager.Validate(kind, preflight) == nil
}

func integrationView(manager *agentconnect.Manager, clients agentClientRegistry, kind agentops.ClientKind, cliPath, dataDir string) gin.H {
	active, listErr := integrationClients(clients, kind)
	connected := len(active) > 0
	needsRetry := len(active) > 1 || listErr != nil
	record, present, recordErr := manager.Record(kind)
	if recordErr != nil {
		needsRetry = true
	}
	if len(active) > 0 {
		tokenPath := manager.TokenPath(kind)
		if present && record.TokenFile != "" {
			tokenPath = record.TokenFile
		}
		if !manager.TokenFilePresent(tokenPath) {
			needsRetry = true
		}
		if !present || record.ClientID == "" {
			needsRetry = true
		} else {
			found := false
			for _, item := range active {
				if item.ID == record.ClientID {
					found = true
					break
				}
			}
			if !found {
				needsRetry = true
			}
		}
	} else if present {
		// Stale auxiliary record without a live credential; disconnect clears it.
		needsRetry = true
	}
	return gin.H{
		"kind":           string(kind),
		"name":           integrationName(kind),
		"detected":       integrationDetected(manager, kind, cliPath, dataDir),
		"connected":      connected,
		"skillInstalled": manager.SkillInstalled(kind),
		"needsRetry":     needsRetry,
	}
}

func integrationViews(manager *agentconnect.Manager, clients agentClientRegistry, cliPath, dataDir string) []gin.H {
	views := make([]gin.H, 0, 2)
	for _, kind := range integrationKinds() {
		views = append(views, integrationView(manager, clients, kind, cliPath, dataDir))
	}
	return views
}

func integrationFailure(kind agentops.ClientKind, err error) error {
	name := integrationName(kind)
	switch {
	case errors.Is(err, agentconnect.ErrAgentNotFound):
		return agentops.PreconditionFailed("agent_not_found", "没有检测到 "+name+" 的命令行。安装后打开一次，再回到这里接入。", nil)
	case errors.Is(err, agentconnect.ErrUnsafeCommand):
		return agentops.PreconditionFailed("agent_command_unsafe", "这台电脑上的 "+name+" 命令行无法安全调用，不能自动接入。请使用手动连接。", nil)
	case errors.Is(err, agentconnect.ErrUnsupported):
		return agentops.PreconditionFailed("unsupported_agent", "这里只能接入 Claude Code 或 Codex。", nil)
	default:
		return agentops.PreconditionFailed("agent_cli_failed", "没能通过 "+name+" 的命令行完成配置。请确认它已正确安装后重试。", nil)
	}
}

// revokeOtherIntegrationClients revokes origin credentials other than skipID
// and returns the IDs whose revocation was not confirmed.
func revokeOtherIntegrationClients(clients agentClientRegistry, kind agentops.ClientKind, skipID string) []string {
	items, err := integrationClients(clients, kind)
	if err != nil {
		// Unreadable registry: old credentials cannot be confirmed revoked.
		return []string{"registry_unreadable"}
	}
	var failed []string
	for _, item := range items {
		if item.ID == skipID {
			continue
		}
		if err := clients.Revoke(item.ID); err != nil && !agentconnect.RevokeConfirmed(err) {
			failed = append(failed, item.ID)
		}
	}
	return failed
}

// cleanupAfterTokenWriteFailure runs when the token file could not be written.
// The previous token file is still intact, so it must not be deleted.
func cleanupAfterTokenWriteFailure(clients agentClientRegistry, clientID string) error {
	revokeErr := clients.Revoke(clientID)
	if agentconnect.RevokeConfirmed(revokeErr) {
		return nil
	}
	// The credential stays in the registry, so the UI still sees it and can
	// offer disconnect.
	return revokeErr
}

// cleanupFailedConnect removes the newly written token. If the new credential
// could not be revoked it stays in the registry; status derives "needs retry"
// from the registry, not from a separate pending list.
func cleanupFailedConnect(manager *agentconnect.Manager, clients agentClientRegistry, kind agentops.ClientKind, clientID string) error {
	revokeErr := clients.Revoke(clientID)
	tokenErr := manager.DeleteToken(kind)
	if !agentconnect.RevokeConfirmed(revokeErr) {
		return errors.Join(revokeErr, tokenErr)
	}
	return tokenErr
}

func registerAgentIntegrationRoutes(r gin.IRouter, svc ownerCredentialDirs, clients agentClientRegistry, desktopTrust func(*http.Request) bool) {
	locks := &integrationLocks{}
	r.POST("/agent-clients/integrations", func(c *gin.Context) {
		if !requireDesktopUITrust(c, svc, desktopTrust) {
			return
		}
		var req struct {
			Kind string `json:"kind"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			failAgentOps(c, agentops.InvalidArg("invalid_request", "请求体无效"))
			return
		}
		kind := integrationKind(req.Kind)
		if kind == "" {
			failAgentOps(c, agentops.InvalidArg("unsupported_agent", "这里只能接入 Claude Code 或 Codex。"))
			return
		}
		lock := locks.forKind(kind)
		lock.Lock()
		defer lock.Unlock()

		cliPath, available := integrationCLIPath()
		if !available {
			failAgentOps(c, agentops.PreconditionFailed("cli_unavailable", "安装文件不完整，无法连接外部工具。请重新下载并完整解压 BeefTV。", nil))
			return
		}
		dataDir, err := filepath.Abs(svc.DataDir())
		if err != nil {
			failInternal(c, http.StatusInternalServerError, err)
			return
		}
		manager := newIntegrationManager(dataDir)
		if !manager.Available() {
			failAgentOps(c, agentops.PreconditionFailed("home_unavailable", "找不到当前用户目录，无法写入配置。", nil))
			return
		}
		// Validate the complete call before issuing a credential or removing
		// anything on the agent side.
		preflight := agentconnect.Launch(cliPath, dataDir, manager.TokenPath(kind), agentops.ClientReadWrite, "preflight")
		if err := manager.Validate(kind, preflight); err != nil {
			failAgentOps(c, integrationFailure(kind, err))
			return
		}

		// Refuse to issue a credential while the registry cannot be read: a later
		// failure could not reliably find and revoke it.
		if _, err := integrationClients(clients, kind); err != nil {
			failAgentOps(c, registryUnreadable(kind))
			return
		}
		reg, token, err := clients.RegisterClientOrigin(string(kind), integrationName(kind), agentconnect.IntegrationOrigin(kind), agentops.ClientReadWrite, agentops.ClientApprovalCaller)
		if err != nil {
			failAgentOps(c, err)
			return
		}
		tokenFile, err := manager.WriteToken(kind, token)
		if err != nil {
			if cleanupErr := cleanupAfterTokenWriteFailure(clients, reg.ID); cleanupErr != nil {
				failAgentOps(c, agentops.PreconditionFailed("connect_cleanup_failed", "没能保存连接凭据，也没能撤销刚生成的连接。请重启 BeefTV 后重试。", nil))
				return
			}
			failAgentOps(c, integrationFailure(kind, err))
			return
		}
		spec := agentconnect.Launch(cliPath, dataDir, tokenFile, reg.Mode, reg.ID)
		if err := manager.Connect(kind, spec); err != nil {
			if cleanupErr := cleanupFailedConnect(manager, clients, kind, reg.ID); cleanupErr != nil {
				failAgentOps(c, agentops.PreconditionFailed("connect_cleanup_failed", "没能写入 "+integrationName(kind)+" 配置，也没能撤销刚生成的连接。请重启 BeefTV 后重试。", nil))
				return
			}
			failAgentOps(c, integrationFailure(kind, err))
			return
		}
		record := agentconnect.IntegrationRecord{
			Kind:        string(kind),
			ClientID:    reg.ID,
			TokenFile:   tokenFile,
			ConnectedAt: time.Now().UTC(),
		}
		if err := manager.SaveRecord(record); err != nil {
			_ = cleanupFailedConnect(manager, clients, kind, reg.ID)
			_ = manager.RemoveConfig(kind)
			_ = manager.RemoveSkill(kind)
			failAgentOps(c, agentops.PreconditionFailed("state_write_failed", "没能保存连接状态。请重试。", nil))
			return
		}
		if failed := revokeOtherIntegrationClients(clients, kind, reg.ID); len(failed) > 0 {
			failAgentOps(c, agentops.PreconditionFailed("revoke_failed", "已接入 "+integrationName(kind)+"，但没能清理旧连接。再点一次接入即可重试。", nil))
			return
		}
		ok(c, gin.H{"integration": integrationView(manager, clients, kind, cliPath, dataDir)})
	})

	r.DELETE("/agent-clients/integrations/:kind", func(c *gin.Context) {
		if !requireDesktopUITrust(c, svc, desktopTrust) {
			return
		}
		kind := integrationKind(c.Param("kind"))
		if kind == "" {
			failAgentOps(c, agentops.InvalidArg("unsupported_agent", "这里只能接入 Claude Code 或 Codex。"))
			return
		}
		lock := locks.forKind(kind)
		lock.Lock()
		defer lock.Unlock()

		dataDir, err := filepath.Abs(svc.DataDir())
		if err != nil {
			failInternal(c, http.StatusInternalServerError, err)
			return
		}
		manager := newIntegrationManager(dataDir)

		// The registry is the source of truth. Revoke every live one-click
		// credential for this kind before touching auxiliary files.
		items, err := integrationClients(clients, kind)
		if err != nil {
			failAgentOps(c, registryUnreadable(kind))
			return
		}
		var failed []string
		for _, item := range items {
			if err := clients.Revoke(item.ID); err != nil && !agentconnect.RevokeConfirmed(err) {
				failed = append(failed, item.ID)
			}
		}
		if len(failed) > 0 {
			failAgentOps(c, agentops.PreconditionFailed("revoke_failed", "没能断开 "+integrationName(kind)+"。请再试一次。", nil))
			return
		}
		if err := manager.DeleteToken(kind); err != nil {
			failAgentOps(c, agentops.PreconditionFailed("token_delete_failed", "没能删除连接凭据。请再试一次。", nil))
			return
		}
		if err := manager.DeleteRecord(kind); err != nil {
			failAgentOps(c, agentops.PreconditionFailed("state_write_failed", "没能保存断开状态。请再试一次。", nil))
			return
		}

		// Access is already cut. A failed CLI removal must not turn the
		// disconnect into a failure; report it as one complete explanation.
		warning := ""
		if err := manager.RemoveConfig(kind); err != nil {
			name := integrationName(kind)
			warning = "BeefTV 已停止接受 " + name + " 的访问。" + name + " 里的 BeefTV 连接没能自动移除，可以在它的 MCP 设置里手动删除。"
		}
		_ = manager.RemoveSkill(kind)
		cliPath, _ := integrationCLIPath()
		payload := gin.H{"integration": integrationView(manager, clients, kind, cliPath, dataDir)}
		if warning != "" {
			payload["warning"] = warning
		}
		ok(c, payload)
	})
}
