package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistantruntime"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/skills"
	httptransport "infinite-canvas/backend/internal/transport/http"
)

type agentProxyService interface {
	workspaceOwners
	ownerCredentialDirs
	assistantSettingsService
	assistantOutputsService
	assistantRuntimeRouteService
	assistantContinuationService
	assistantContinuationIntentService
	assistantSkillScriptService
	assistantReferenceService
	ConfirmAssistantProduction(userID, turnID string, input app.AssistantProductionConfirmation) (any, error)
	ListGenerationOrders(userID, canvasID string) ([]operations.GenerationOrder, error)
	ApproveGenerationOrder(userID, proposalID, approvedBy string) (any, error)
	ValidateAssistantAttachments(userID, canvasID string, items []app.AssistantAttachment) error
	ValidateAgentSkills(userID string, pins []skills.Pin) ([]skills.Pin, error)
}

// agentProxyMaxBody 限制转发体积；解析失败或超限都按真实失败返回。
const agentProxyMaxBody = 64 << 10

// hostStartGrace 是宿主从拉起到健康的宽限期：这段时间里状态是「正在启动」而不是「不可达」。
const hostStartGrace = 20 * time.Second

// agentHostClient 不跟随重定向：避免宿主凭据被转发到其他地址。
func agentHostClient(host *assistantruntime.Host, timeout time.Duration) *http.Client {
	return host.HTTPClient(timeout)
}

// assistantChatHeaderTimeout 只限制等宿主开始回应的时间：此前宿主要读取附件并确认回合归属。
const assistantChatHeaderTimeout = 10 * time.Minute

// assistantChatClient 不设整体超时：http.Client.Timeout 也会截断响应体，而 NDJSON 流要持续到
// 官方回合结束（含模型自动重试与退避）。浏览器离开不取消上游，宿主进程结束时连接随之关闭。
func assistantChatClient(host *assistantruntime.Host, headerTimeout time.Duration) *http.Client {
	return host.StreamHTTPClient(headerTimeout)
}

// newTurnID 是一轮对话的稳定标识：按轮撤销与历史都以此为准。
func newTurnID() string {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return hex.EncodeToString([]byte(time.Now().UTC().Format("20060102150405.000000000")))
	}
	return hex.EncodeToString(buf)
}

// assistantSessionIDPattern 覆盖 durable:<uuid> 与旧会话标识；归属由宿主按画布目录核对。
var assistantSessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_:-]{1,128}$`)

// readAssistantBody 读取并解析小型 JSON 请求体，返回原文与解析结果（原文用于原样转给宿主）。
func readAssistantBody[T any](c *gin.Context, shape T) ([]byte, T, bool) {
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, agentProxyMaxBody+1))
	if err != nil {
		fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体读取失败"))
		return nil, shape, false
	}
	if int64(len(body)) > agentProxyMaxBody {
		fail(c, http.StatusRequestEntityTooLarge, app.BadAuthRequest("请求体超过限制"))
		return nil, shape, false
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		body = []byte("{}")
	}
	if err := json.Unmarshal(body, &shape); err != nil {
		fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体不是合法 JSON"))
		return nil, shape, false
	}
	return body, shape, true
}

// RegisterAgentProxyRoutes 让浏览器通过同源后端使用内置创作助手：
// 页面只发业务消息，宿主凭据由后端注入；宿主不可用时返回明确状态而不是空回复。
func RegisterAgentProxyRoutes(r gin.IRouter, svc agentProxyService, clients *agentops.ClientRegistry, ui *uiSessionStore, host *assistantruntime.Host) {
	client := assistantChatClient(host, assistantChatHeaderTimeout)
	registerAssistantRuntimeRoutes(r, svc)

	guard := func(c *gin.Context, requireWrite bool) bool {
		// 与 /agent-ops 完全相同的来源校验：Host/RemoteAddr/Origin 都必须是本机且同源。
		if !isLoopbackRequest(c.Request) {
			c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "reason": "forbidden", "msg": "内置助手入口只接受本机同源请求"})
			return false
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return false
		}
		c.Set("agentUserId", user.ID)
		// 身份校验：必须是内置 UI 会话或已登记客户端；CSRF 只是附加约束。
		readOnly, identity, authed, reason := resolveAgentCapability(c, svc, clients, ui, user.ID)
		if !authed {
			c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "reason": "unauthenticated", "msg": reason})
			return false
		}
		c.Set("agentIdentity", identity)
		if requireWrite && readOnly {
			// 已登记的只读客户端（或声明只读的调用）不能借代理拿到宿主写权限。
			c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "reason": "read_only_client", "msg": "只读客户端不能通过内置助手发起写操作"})
			return false
		}
		return true
	}

	// 助手行为设置改变脚本确认方式，写入必须与助手入口共用同一套身份与只读校验。
	RegisterAssistantSettingsRoutes(r, svc, guard)

	// hostOpsURL 用请求自身的 Host 推导操作层基址：桌面形态监听随机端口，猜端口会指向别处。
	hostOpsURL := func(c *gin.Context) string { return "http://" + c.Request.Host + "/api" }
	launchToken := func(c *gin.Context) string { return strings.TrimSpace(c.GetHeader(httptransport.LaunchTokenHeader)) }

	unavailable := func(c *gin.Context, reason string) {
		ok(c, gin.H{"available": false, "reason": reason})
	}

	status := func(c *gin.Context) {
		if host == nil {
			unavailable(c, "host_unreachable")
			return
		}
		provider, reason := host.ResolveProvider()
		if reason != "" {
			unavailable(c, reason)
			return
		}
		modelInfo := gin.H{"id": provider.Model, "channelId": provider.ChannelID, "channelName": provider.ChannelName}
		health := host.Probe(c.Request.Context())
		state := host.State()
		if health.OK {
			if state.Fingerprint != "" && state.Fingerprint != provider.Fingerprint() {
				if health.Busy {
					ok(c, gin.H{"available": false, "reason": "host_busy", "model": gin.H{"id": health.Model}})
					return
				}
				if err := host.Restart(provider, hostOpsURL(c), launchToken(c)); err != nil {
					unavailable(c, "host_start_failed")
					return
				}
				ok(c, gin.H{"available": false, "reason": "host_starting", "model": modelInfo})
				return
			}
			ok(c, gin.H{"available": true, "model": modelInfo})
			return
		}
		if state.Running {
			// 探测超时或失败不是空闲证据，不能授权杀掉仍在跑的子进程。
			// 用户显式 POST /assistant/host/restart 才是重试。
			if time.Since(state.LaunchedAt) < hostStartGrace {
				ok(c, gin.H{"available": false, "reason": "host_starting", "model": modelInfo})
				return
			}
			ok(c, gin.H{"available": false, "reason": "host_unreachable", "model": modelInfo})
			return
		}
		launched, err := host.Ensure(provider, hostOpsURL(c), launchToken(c), true)
		if err != nil {
			ok(c, gin.H{"available": false, "reason": "host_start_failed", "model": modelInfo})
			return
		}
		if launched || (state.Running && time.Since(state.LaunchedAt) < hostStartGrace) {
			ok(c, gin.H{"available": false, "reason": "host_starting", "model": modelInfo})
			return
		}
		ok(c, gin.H{"available": false, "reason": "host_unreachable", "model": modelInfo})
	}
	guardedStatus := func(c *gin.Context) {
		// 状态查询不含任何凭据，只做本机同源校验：面板需要它在未签发会话时也能显示"未就绪"。
		if !isLoopbackRequest(c.Request) {
			c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "reason": "forbidden"})
			return
		}
		status(c)
	}
	r.GET("/assistant/status", guardedStatus)
	r.GET("/assistant/health", guardedStatus)

	r.POST("/assistant/host/restart", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		if missingAssistantHost(c, host) {
			return
		}
		provider, reason := host.ResolveProvider()
		if reason != "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": reason,
				"msg": "助手模型或凭据还没准备好"})
			return
		}
		if err := host.Restart(provider, hostOpsURL(c), launchToken(c)); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_start_failed", "msg": err.Error()})
			return
		}
		ok(c, gin.H{"restarted": true})
	})

	// hostJSON 把一次 JSON 请求转给宿主并原样回传业务结果；宿主凭据只在这里注入。
	hostJSON := func(c *gin.Context, method, path string, body []byte) {
		if host == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable",
				"msg": "内置创作助手宿主未运行"})
			return
		}
		var reader io.Reader
		if body != nil {
			reader = strings.NewReader(string(body))
		}
		upstream, err := host.NewChildRequest(c.Request.Context(), method, path, reader)
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable",
				"msg": "内置创作助手宿主未运行"})
			return
		}
		upstream.Header.Set("Content-Type", "application/json")
		resp, err := agentHostClient(host, 30*time.Second).Do(upstream)
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_unreachable",
				"msg": "内置创作助手宿主未运行"})
			return
		}
		defer resp.Body.Close()
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		var decoded any
		if err := json.Unmarshal(payload, &decoded); err != nil {
			fail(c, http.StatusBadGateway, app.BadAuthRequest("宿主返回的不是合法 JSON"))
			return
		}
		if resp.StatusCode/100 != 2 {
			reason := "host_unreachable"
			if body, isObject := decoded.(map[string]any); isObject {
				if value, found := body["reason"].(string); found && value != "" {
					reason = value
				}
			}
			c.JSON(resp.StatusCode, gin.H{"code": resp.StatusCode, "reason": reason, "msg": "内置创作助手宿主拒绝了该请求"})
			return
		}
		if strings.HasPrefix(path, "/history?") {
			if history, ok := decoded.(map[string]any); ok {
				installed := installedSkillLabels(svc, c.GetString("agentUserId"))
				turns, _ := history["turns"].([]any)
				for _, value := range turns {
					if turn, ok := value.(map[string]any); ok {
						delete(turn, "proposalsInvalidated")
						turnID, _ := turn["turnId"].(string)
						outputs, err := svc.AssistantTurnOutputs(c.GetString("agentUserId"), strings.TrimSpace(c.Query("canvasId")), turnID)
						if err != nil {
							failService(c, err)
							return
						}
						turn["outputs"] = outputs
						state, err := svc.ReadAssistantTurnHistoryState(c.GetString("agentUserId"), strings.TrimSpace(c.Query("canvasId")), turnID)
						if err != nil {
							failService(c, err)
							return
						}
						var pins []skills.Pin
						if state != nil {
							turn["proposalsInvalidated"] = state.ContinuationInvalidated
							turn["undone"] = state.Undone
							turn["change"] = state.Change
							turn["permissionMode"] = state.PermissionMode
							pins = state.SkillPins
						}
						if scriptProposals, spErr := operations.ListTurnSkillScriptProposals(svc.Database(), c.GetString("agentUserId"), strings.TrimSpace(c.Query("canvasId")), turnID); spErr == nil && len(scriptProposals) > 0 {
							turn["scriptProposals"] = scriptProposals
						}
						labelAssistantSkills(turn, pins, installed)
					}
				}
				if active, ok := history["active"].(map[string]any); ok {
					turnID, _ := active["turnId"].(string)
					state, err := svc.ReadAssistantTurnHistoryState(c.GetString("agentUserId"), strings.TrimSpace(c.Query("canvasId")), turnID)
					if err != nil {
						failService(c, err)
						return
					}
					var pins []skills.Pin
					if state != nil {
						pins = state.SkillPins
					}
					labelAssistantSkills(active, pins, installed)
				}
			}
		}
		ok(c, decoded)
	}

	// requireOwnedCanvas 先验证范围：只能操作当前用户确实拥有的画布，再转发给宿主。
	requireOwnedCanvas := func(c *gin.Context, canvasID string) (json.RawMessage, bool) {
		if strings.TrimSpace(canvasID) == "" {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("canvasId 必填"))
			return nil, false
		}
		raw, err := svc.CanvasService().UserCanvasProject(c.GetString("agentUserId"), canvasID)
		if err != nil {
			fail(c, http.StatusNotFound, app.BadAuthRequest("画布不存在或不属于当前工作区"))
			return nil, false
		}
		return raw, true
	}

	registerAssistantSkillContextRoutes(r, svc, guard, hostJSON)
	registerAssistantContinuationRoutes(r, svc, guard)
	registerAssistantSkillScriptRoutes(r, svc, host, guard, requireOwnedCanvas)
	r.GET("/assistant/sessions", func(c *gin.Context) {
		if !guard(c, false) {
			return
		}
		canvasID := strings.TrimSpace(c.Query("canvasId"))
		if _, allowed := requireOwnedCanvas(c, canvasID); !allowed {
			return
		}
		hostJSON(c, http.MethodGet, "/sessions?canvasId="+url.QueryEscape(canvasID), nil)
	})

	r.POST("/assistant/sessions", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		body, payload, valid := readAssistantBody(c, struct {
			CanvasID string `json:"canvasId"`
		}{})
		if !valid {
			return
		}
		if _, allowed := requireOwnedCanvas(c, payload.CanvasID); !allowed {
			return
		}
		if !stopAssistantContinuationsForIntent(c, svc, host, payload.CanvasID, "") {
			return
		}
		hostJSON(c, http.MethodPost, "/sessions", body)
	})

	r.POST("/assistant/sessions/activate", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		body, payload, valid := readAssistantBody(c, struct {
			CanvasID  string `json:"canvasId"`
			SessionID string `json:"sessionId"`
		}{})
		if !valid {
			return
		}
		if _, allowed := requireOwnedCanvas(c, payload.CanvasID); !allowed {
			return
		}
		if !stopAssistantContinuationsForIntent(c, svc, host, payload.CanvasID, "") {
			return
		}
		hostJSON(c, http.MethodPost, "/sessions/activate", body)
	})

	r.DELETE("/assistant/sessions/:sessionId", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		canvasID := strings.TrimSpace(c.Query("canvasId"))
		sessionID := strings.TrimSpace(c.Param("sessionId"))
		if canvasID == "" {
			_, payload, valid := readAssistantBody(c, struct {
				CanvasID string `json:"canvasId"`
			}{})
			if !valid {
				return
			}
			canvasID = strings.TrimSpace(payload.CanvasID)
		}
		if !assistantSessionIDPattern.MatchString(sessionID) {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("sessionId 无效"))
			return
		}
		if _, allowed := requireOwnedCanvas(c, canvasID); !allowed {
			return
		}
		if !stopAssistantContinuationsForIntent(c, svc, host, canvasID, sessionID) {
			return
		}
		_ = operations.RevokeSessionScriptAllows(svc.Database(), c.GetString("agentUserId"), canvasID, sessionID)
		svc.SkillsDomain().CancelScriptRuns(canvasID, sessionID, "")
		body, _ := json.Marshal(map[string]string{"canvasId": canvasID, "sessionId": sessionID})
		hostJSON(c, http.MethodDelete, "/sessions", body)
	})

	r.GET("/assistant/history", func(c *gin.Context) {
		if !guard(c, false) {
			return
		}
		canvasID := strings.TrimSpace(c.Query("canvasId"))
		if _, allowed := requireOwnedCanvas(c, canvasID); !allowed {
			return
		}
		query := "/history?canvasId=" + url.QueryEscape(canvasID)
		if sessionID := strings.TrimSpace(c.Query("sessionId")); sessionID != "" {
			query += "&sessionId=" + url.QueryEscape(sessionID)
		}
		hostJSON(c, http.MethodGet, query, nil)
	})

	registerAgentProxyTurnRoutes(r, svc, host, client, guard, hostJSON, requireOwnedCanvas)
}
