package handler

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentconnect"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
)

// 外部 Agent 接入的签发面：只有桌面自己的界面能开客户端凭据，外部客户端拿到的
// 只是自己的能力凭据，永远接触不到桌面启动令牌。
//
// 桌面启动令牌只存在于桌面进程内存里。要让安装版用户能接入 Codex / Claude Code /
// Cursor，签发必须发生在受信任的桌面界面内，并把随包 CLI 的绝对路径连同客户端
// 自己的凭据一起拼成可直接粘贴的接入命令。

// agentClientRegistry is the narrow surface these routes need. The concrete
// registry lives in agentops; tests inject a fake to exercise failure paths.
type agentClientRegistry interface {
	List() []agentops.ClientRegistration
	ListLive() ([]agentops.ClientRegistration, error)
	RegisterClient(kind, label string, mode agentops.ClientMode, approvalMode agentops.ClientApprovalMode) (agentops.ClientRegistration, string, error)
	RegisterClientOrigin(kind, label, origin string, mode agentops.ClientMode, approvalMode agentops.ClientApprovalMode) (agentops.ClientRegistration, string, error)
	Revoke(clientID string) error
}

// RegisterAgentClientRoutes 暴露 /agent-clients：列出、签发、吊销外部客户端凭据。
// 信任判据与签发内置 UI 会话完全一致（本机同源 + owner 凭据 / 桌面壳 / 显式本地引导），
// 外部客户端凭据一律不能进入这组路由。
func RegisterAgentClientRoutes(r gin.IRouter, svc ownerCredentialDirs, clients agentClientRegistry, desktopTrust func(*http.Request) bool) {
	r.GET("/agent-clients", func(c *gin.Context) {
		if !requireDesktopUITrust(c, svc, desktopTrust) {
			return
		}
		cliPath, cliAvailable := bundledCLIPath()
		installCommand := ""
		if cliAvailable {
			installCommand = cliInstallCommand(cliPath)
		}
		payload := gin.H{
			"clients": clientViews(clients.List()),
			"cli":     gin.H{"path": cliPath, "available": cliAvailable, "installCommand": installCommand},
		}
		// One-click integration only exists on the desktop profile. The server
		// profile has no desktop trust and never touches the user's home.
		if desktopTrust != nil {
			payload["integrations"] = integrationViews(newIntegrationManager(svc.DataDir()), clients, cliPath, svc.DataDir())
		}
		ok(c, payload)
	})

	r.POST("/agent-clients", func(c *gin.Context) {
		if !requireDesktopUITrust(c, svc, desktopTrust) {
			return
		}
		var req struct {
			Kind         string `json:"kind"`
			Mode         string `json:"mode"`
			Label        string `json:"label"`
			ApprovalMode string `json:"approvalMode"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体无效"))
			return
		}
		kind := agentops.NormalizeClientKind(req.Kind)
		cliPath, available := bundledCLIPath()
		if !available {
			failAgentOps(c, agentops.PreconditionFailed("cli_unavailable", "安装文件不完整，无法连接外部工具。请重新下载并完整解压 BeefTV。", nil))
			return
		}
		dataDir, err := filepath.Abs(svc.DataDir())
		if err != nil {
			failInternal(c, http.StatusInternalServerError, err)
			return
		}
		reg, token, err := clients.RegisterClient(string(kind), req.Label, agentops.ClientMode(strings.TrimSpace(req.Mode)), agentops.ClientApprovalMode(req.ApprovalMode))
		if err != nil {
			failAgentOps(c, err)
			return
		}
		// token 只在这一次响应里出现；服务端只保存哈希，之后任何接口都取不回来。
		ok(c, gin.H{"client": clientView(reg), "token": token,
			"setup": clientSetup(kind, cliPath, dataDir, reg, token)})
	})

	r.DELETE("/agent-clients/:id", func(c *gin.Context) {
		if !requireDesktopUITrust(c, svc, desktopTrust) {
			return
		}
		if err := clients.Revoke(c.Param("id")); err != nil {
			failAgentOps(c, err)
			return
		}
		ok(c, gin.H{"revoked": true})
	})

	// One-click connect/disconnect is desktop-only. Server deployments do not
	// expose these routes at all, so web clients cannot edit a host home.
	if desktopTrust != nil {
		registerAgentIntegrationRoutes(r, svc, clients, desktopTrust)
	}
}

// failAgentOps 把操作层错误按统一失败信封返回（reason 机器可读）。
func failAgentOps(c *gin.Context, err error) {
	opErr := agentops.AsError(err)
	status := agentops.HTTPStatus(opErr.Code)
	c.JSON(status, gin.H{"code": status, "reason": opErr.Reason, "msg": opErr.Message})
}

// requireDesktopUITrust 复用签发内置 UI 会话的同一条信任链。
// 外部客户端凭据在这里没有任何作用：它只能操作工作区，不能签发或吊销凭据。
func requireDesktopUITrust(c *gin.Context, svc ownerCredentialDirs, desktopTrust func(*http.Request) bool) bool {
	if strings.TrimSpace(c.GetHeader("X-Beeftv-Client")) != "" {
		fail(c, http.StatusForbidden, app.BadAuthRequest("外部客户端不能管理客户端凭据"))
		return false
	}
	if !isLoopbackRequest(c.Request) {
		fail(c, http.StatusForbidden, app.BadAuthRequest("只接受本机同源请求"))
		return false
	}
	ownerOK := agentops.OwnerTokenMatches(svc.DataDir(), strings.TrimSpace(c.GetHeader("X-Beeftv-Owner")))
	devBootstrap := strings.TrimSpace(os.Getenv("BEEFTV_UI_BOOTSTRAP")) == "1"
	desktopShell := desktopTrust != nil && desktopTrust(c.Request)
	if !ownerOK && !devBootstrap && !desktopShell {
		fail(c, http.StatusForbidden, app.BadAuthRequest("管理客户端凭据需要 owner 凭据或桌面界面"))
		return false
	}
	return true
}

func clientViews(items []agentops.ClientRegistration) []gin.H {
	out := make([]gin.H, 0, len(items))
	for _, item := range items {
		out = append(out, clientView(item))
	}
	return out
}

func clientView(item agentops.ClientRegistration) gin.H {
	approvalMode, err := agentops.NormalizeClientApprovalMode(string(item.ApprovalMode))
	if err != nil {
		approvalMode = agentops.ClientApprovalCaller
	}
	view := gin.H{
		"id":           item.ID,
		"label":        item.Label,
		"kind":         string(agentops.NormalizeClientKind(string(item.Kind))),
		"mode":         string(item.Mode),
		"approvalMode": string(approvalMode),
		"createdAt":    item.CreatedAt.UTC().Format(time.RFC3339),
		"lastUsedAt":   nil,
	}
	if agentconnect.IsIntegrationOrigin(item.Kind, item.Origin) {
		view["desktopIntegration"] = true
	}
	if item.LastUsedAt != nil {
		view["lastUsedAt"] = item.LastUsedAt.UTC().Format(time.RFC3339)
	}
	return view
}

// bundledCLIPath 给出随包 CLI 的绝对路径。
//
// 安装版里 CLI 在主程序旁边的 cli 目录里：macOS 是
// BeefTV.app/Contents/MacOS/cli/beeftv，Windows 是 BeefTV.exe 旁边的 cli\beeftv.exe。
// 它不能直接放在主程序同一层：macOS 与 Windows 的文件名都不分大小写，beeftv 会和
// BeefTV / BeefTV.exe 变成同一个文件，把主程序覆盖掉。
//
// 缺失时不回退 PATH：Windows 会把 beeftv.exe 解析成桌面主程序 BeefTV.exe。
func bundledCLIPath() (string, bool) {
	name := "beeftv"
	if runtime.GOOS == "windows" {
		name = "beeftv.exe"
	}
	executable, err := os.Executable()
	if err != nil {
		return "", false
	}
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	candidate := filepath.Join(filepath.Dir(executable), "cli", name)
	info, err := os.Stat(candidate)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || (runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0) {
		return candidate, false
	}
	return candidate, true
}

// cliInstallCommand 把随包 CLI 接到用户的 PATH 上，方便在终端直接敲 beeftv。
func cliInstallCommand(cliPath string) string {
	if runtime.GOOS == "windows" {
		dir := filepath.Dir(cliPath)
		return `[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ` + shellQuote(";"+dir) + `, "User")`
	}
	return "ln -sf " + shellQuote(cliPath) + " /usr/local/bin/beeftv"
}

// clientSetup 生成可直接粘贴的接入配置。命令里带的是客户端自己的凭据，
// 不含桌面启动令牌；CLI 按工作区路径通过共享运行实例发现逻辑读取地址。
func clientSetup(kind agentops.ClientKind, cliPath, dataDir string, reg agentops.ClientRegistration, token string) gin.H {
	launch := agentconnect.ManualLaunch(cliPath, dataDir, reg.Mode, reg.ID, token)
	serveArgs := strings.Join(launch.Args, " ")
	switch kind {
	case agentops.ClientKindCodex:
		command := "codex mcp add beeftv" +
			" --env BEEFTV_DATA_DIR=" + shellQuote(dataDir) +
			" --env BEEFTV_CLIENT_ID=" + shellQuote(reg.ID) +
			" --env BEEFTV_CLIENT_TOKEN=" + shellQuote(token) +
			" -- " + shellQuote(launch.Command) + " " + serveArgs
		return gin.H{"kind": string(kind), "title": "在 Codex 里加上 BeefTV", "command": command}
	case agentops.ClientKindClaude:
		command := "claude mcp add beeftv --scope user" +
			" -e BEEFTV_DATA_DIR=" + shellQuote(dataDir) +
			" -e BEEFTV_CLIENT_ID=" + shellQuote(reg.ID) +
			" -e BEEFTV_CLIENT_TOKEN=" + shellQuote(token) +
			" -- " + shellQuote(launch.Command) + " " + serveArgs
		return gin.H{"kind": string(kind), "title": "在 Claude Code 里加上 BeefTV", "command": command}
	case agentops.ClientKindClaudeDesktop:
		return gin.H{"kind": string(kind), "title": "在 Claude Desktop 的开发者设置中编辑配置",
			"json": mcpServersJSON(launch)}
	case agentops.ClientKindCursor:
		return gin.H{"kind": string(kind), "title": "把这段写进 ~/.cursor/mcp.json",
			"json": mcpServersJSON(launch)}
	default:
		return gin.H{"kind": string(kind), "title": "把这段写进该客户端的 MCP 配置",
			"json": mcpServersJSON(launch)}
	}
}

func mcpServersJSON(launch agentconnect.LaunchSpec) string {
	payload := map[string]any{"mcpServers": map[string]any{"beeftv": map[string]any{
		"command": launch.Command,
		"args":    launch.Args,
		"env":     launch.EnvMap(),
	}}}
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

// shellQuote 用单引号包裹，路径或凭据里的空格与元字符都不会被 shell 再解释一遍。
func shellQuote(value string) string {
	if runtime.GOOS == "windows" {
		return "'" + strings.ReplaceAll(value, "'", "''") + "'"
	}
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}
