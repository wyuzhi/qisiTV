package browserbridge

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"strings"
	"time"
)

const EngineSessionHeader = "X-QisiTV-Session"

// EngineConfig contains only process-owned capabilities. They never appear in
// status, pairing replies, browser storage, or URLs. Shell is invoked only after
// the same origin-bound pairing check as the workspace API.
type EngineConfig struct {
	BaseURL             string
	LaunchToken         string
	UIBootstrapToken    string
	Version             string
	Shell               http.Handler
	Ready               func() bool
	WorkspaceConfigured func() bool
	ProjectDirectory    func() string
	CheckWritable       func(context.Context) error
}

type EngineGateway struct {
	config EngineConfig
	proxy  *httputil.ReverseProxy
}

func NewEngineGateway(config EngineConfig) (*EngineGateway, error) {
	target, err := url.Parse(config.BaseURL)
	if err != nil || target.Scheme != "http" || target.Hostname() != "127.0.0.1" || target.Port() == "" || target.User != nil || target.Path != "/api" || target.RawQuery != "" || target.Fragment != "" || len(config.LaunchToken) < 32 || len(config.UIBootstrapToken) < 32 {
		return nil, errors.New("engine requires a verified loopback API and private runtime credentials")
	}
	gateway := &EngineGateway{config: config}
	gateway.proxy = &httputil.ReverseProxy{
		Rewrite: func(proxy *httputil.ProxyRequest) {
			// The outer gateway validates the public Origin and pairing token.
			// Do not let forwarded identity headers impersonate a local Agent.
			proxy.Out.URL.Scheme, proxy.Out.URL.Host = target.Scheme, target.Host
			proxy.Out.URL.Path = strings.TrimPrefix(proxy.In.URL.Path, "/engine")
			proxy.Out.URL.RawPath = ""
			proxy.Out.Host = target.Host
			for name := range proxy.Out.Header {
				lower := strings.ToLower(name)
				if strings.HasPrefix(lower, "x-beeftv-") && lower != "x-beeftv-ui-session" || strings.HasPrefix(lower, "x-forwarded-") || lower == "forwarded" || lower == "authorization" || lower == "cookie" || lower == "origin" || lower == "referer" || lower == "x-desktop-token" || lower == "x-qisitv-session" {
					proxy.Out.Header.Del(name)
				}
			}
			proxy.Out.Header.Set("X-Desktop-Token", config.LaunchToken)
			proxy.Out.Header.Set("X-Beeftv-UI-Bootstrap", config.UIBootstrapToken)
		},
		Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext, ResponseHeaderTimeout: 10 * time.Minute},
		// Flush each streamed frame; neither uploads nor responses are buffered.
		FlushInterval: -1,
		ModifyResponse: func(response *http.Response) error {
			// CORS belongs to the public gateway, not the inner desktop runtime.
			for name := range response.Header {
				lower := strings.ToLower(name)
				if strings.HasPrefix(lower, "access-control-") || lower == "set-cookie" || lower == "x-desktop-token" || lower == "x-beeftv-ui-bootstrap" || lower == "x-beeftv-owner" || lower == "x-beeftv-agent-token" {
					response.Header.Del(name)
				}
			}
			response.Header.Set("Cache-Control", "no-store")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if r.Context().Err() != nil {
				return
			}
			engineError(w, http.StatusBadGateway, "engine_unavailable", "本机引擎连接中断；请先检查原任务状态，不要重复提交生成")
		},
	}
	return gateway, nil
}

// SetEngine must be called before serving. Existing MCP-only connectors keep
// their original behavior and do not import the Go workspace or SQLite.
func (s *Server) SetEngine(engine *EngineGateway) { s.engine = engine }

func engineError(w http.ResponseWriter, status int, reason, message string) {
	writeJSON(w, status, map[string]any{"code": status, "reason": reason, "msg": message, "data": nil})
}

func (s *Server) serveEngine(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		engineError(w, 405, "method_not_allowed", "引擎不支持该请求方式")
		return
	}
	if s.engine == nil {
		engineError(w, 503, "engine_not_installed", "请安装或更新 qisiTV 本机引擎")
		return
	}
	if r.Header.Get("Origin") == "" {
		engineError(w, 403, "origin_required", "请从已配对的 qisiTV 网页使用引擎")
		return
	}
	token := r.Header.Get(EngineSessionHeader)
	s.mu.Lock()
	entry := s.sessions[token]
	if entry == nil || entry.Origin != r.Header.Get("Origin") || !time.Now().Before(entry.Expires) {
		s.mu.Unlock()
		engineError(w, 401, "engine_session_expired", "本机引擎授权已失效，请重新配对")
		return
	}
	// Unpairing cancels in-flight observation/uploads. It does not replay or
	// silently resubmit work already accepted by the durable task service.
	ctx, cancel := context.WithDeadline(r.Context(), entry.Expires)
	id := randomToken(16)
	if entry.EngineRequests == nil {
		entry.EngineRequests = make(map[string]context.CancelFunc)
	}
	entry.EngineRequests[id] = cancel
	s.mu.Unlock()
	defer func() { cancel(); s.mu.Lock(); delete(entry.EngineRequests, id); s.mu.Unlock() }()
	r = r.WithContext(ctx)
	if r.URL.Path == "/engine/status" {
		if r.Method != http.MethodGet {
			engineError(w, 405, "method_not_allowed", "GET required")
			return
		}
		ready := s.engine.config.Ready == nil || s.engine.config.Ready()
		configured := s.engine.config.WorkspaceConfigured == nil || s.engine.config.WorkspaceConfigured()
		directory := ""
		if s.engine.config.ProjectDirectory != nil {
			directory = s.engine.config.ProjectDirectory()
		}
		writeJSON(w, 200, map[string]any{"code": 0, "data": map[string]any{"ready": ready, "version": s.engine.config.Version, "apiPath": "/engine/api", "shellPath": "/engine/shell", "storage": "local", "sessionId": entry.ID, "expiresAt": entry.Expires, "workspaceConfigured": configured, "projectDirectory": directory}, "msg": ""})
		return
	}
	if strings.HasPrefix(r.URL.Path, "/engine/shell/") {
		if s.engine.config.Shell == nil {
			engineError(w, 404, "shell_unavailable", "本机操作不可用")
			return
		}
		s.engine.config.Shell.ServeHTTP(w, r)
		return
	}
	if r.URL.Path != "/engine/api" && !strings.HasPrefix(r.URL.Path, "/engine/api/") {
		engineError(w, 404, "not_found", "引擎接口不存在")
		return
	}
	// Runtime callbacks and process-command configuration are not UI APIs.
	apiPath := strings.TrimPrefix(r.URL.Path, "/engine/api")
	if apiPath != "" && (path.Clean(apiPath) != apiPath || strings.Contains(apiPath, "\\")) {
		engineError(w, 400, "invalid_path", "引擎接口路径无效")
		return
	}
	if strings.HasPrefix(apiPath, "/assistant/runtime/") || apiPath == "/assistant/host/config" || apiPath == "/assistant/host/start" || apiPath == "/assistant/host/stop" {
		engineError(w, 403, "runtime_private", "该接口仅供本机运行宿主使用")
		return
	}
	if s.engine.config.WorkspaceConfigured != nil && !s.engine.config.WorkspaceConfigured() && r.Method != http.MethodGet && r.Method != http.MethodHead && apiPath != "/workspace/model-config" && apiPath != "/assistant/ui-session" {
		engineError(w, 409, "folder_required", "请先选择并确认本机项目文件夹")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead && s.engine.config.CheckWritable != nil && apiPath != "/workspace/model-config" && apiPath != "/assistant/ui-session" {
		if err := s.engine.config.CheckWritable(r.Context()); err != nil {
			engineError(w, 409, "project_folder_conflict", "项目文件夹已改变或不可写；请检查项目存储状态后继续")
			return
		}
	}
	s.engine.proxy.ServeHTTP(w, r)
}
