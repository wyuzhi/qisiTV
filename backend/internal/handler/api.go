package handler

import (
	"net/http"
	"reflect"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/appearance"
	"infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/diagnostics"
	"infinite-canvas/backend/internal/eagle"
	"infinite-canvas/backend/internal/modelcatalog"
	localplayback "infinite-canvas/backend/internal/playback"
	localproject "infinite-canvas/backend/internal/project"
	"infinite-canvas/backend/internal/prompts"
	"infinite-canvas/backend/internal/skills"

	"github.com/gin-gonic/gin"
)

// CanvasAPIService defines the composition-root port required to wire HTTP routes.
type CanvasAPIService interface {
	serviceRuntimeSource
	supportTraces
	workspaceBootstrap
	appearanceAssets
	featureGates
	creationRouteService
	channelModelCatalogs
	customRelays
	taskRouteService
	agentOpsService
	agentUISessionService
	agentProxyService
	chunkedUploadService
	pluginCenter
	canvasProductionService
	projectReads
	userDataUsage
	canvasLibraryWrites
	userDataWorkflows
	DiagnosticsDomain() *diagnostics.Service
	AppearanceDomain() *appearance.Service
	PromptService() *prompts.Service
	AssetLibraryService() *asset.Library
	ResourceService() *asset.Service
	PlaybackService() *localplayback.Service
	ProjectService() *localproject.Service
}

func isNilService(value any) bool {
	if value == nil {
		return true
	}
	v := reflect.ValueOf(value)
	return v.Kind() == reflect.Pointer && v.IsNil()
}

// RegisterCanvasAPI is kept as the standalone-development entrypoint. BeefTV
// has one local-only HTTP surface, so development and Wails use the same route
// graph instead of selecting between desktop and SaaS profiles at runtime.
func RegisterCanvasAPI(api *gin.RouterGroup, svc CanvasAPIService) {
	registerDesktopCanvasAPI(api, svc, defaultRuntimeDependencies(svc))
}

// RegisterDesktopCanvasAPI keeps the desktop profile local-first. The server
// profile still exposes hosted routes for backward compatibility.
func RegisterDesktopCanvasAPI(api *gin.RouterGroup, svc CanvasAPIService) {
	RegisterDesktopCanvasAPIWithDependencies(api, svc, defaultRuntimeDependencies(svc))
}

func defaultRuntimeDependencies(svc CanvasAPIService) RuntimeDependencies {
	if isNilService(svc) {
		return RuntimeDependencies{Eagle: eagle.New()}
	}
	adapter := newServiceRuntimeAdapter(svc)
	dependencies := RuntimeDependencies{
		RequestCoordinator: adapter, ProviderConfig: adapter, Assets: adapter, Projects: adapter, Tasks: adapter, Generation: adapter,
		Eagle:       eagle.New(),
		Diagnostics: svc.DiagnosticsDomain(),
		Appearance:  svc.AppearanceDomain(),
	}
	if pluginsDomain := svc.PluginDomain(); pluginsDomain != nil {
		dependencies.ModelCapability = modelcatalog.NewCapabilityNormalizer(pluginsDomain.LookupWorkflow)
	}
	return dependencies
}

func RegisterDesktopCanvasAPIWithDependencies(api *gin.RouterGroup, svc CanvasAPIService, dependencies RuntimeDependencies) {
	registerDesktopCanvasAPI(api, svc, dependencies)
}

// registerDesktopCanvasAPI is deliberately a separate call graph. Keeping the
// local composition root free of runtime profile branches lets the Go linker
// discard hosted handlers and their SaaS-only service methods from BeefTV.
func registerDesktopCanvasAPI(api *gin.RouterGroup, svc CanvasAPIService, dependencies RuntimeDependencies) {
	if isNilService(svc) {
		svc = nil
	}
	// A process supervisor needs an explicit Close owner. Only the composition
	// root supplies it; standalone route registration must not create a child
	// whose lifetime has no owner.
	api.Use(RuntimeDependenciesMiddleware(dependencies))
	api.Use(SupportTracingMiddleware(svc))
	RegisterOpenAPIRoutes(api)
	RegisterWorkspaceRoutes(api, svc)
	RegisterBeefTVConnectionRoutes(api, svc)
	RegisterDesktopAppearanceRoutes(api, svc)
	RegisterDesktopFeatureAvailabilityRoutes(api, svc)
	// 旧内置 Agent 已从产品运行面退场：这里不再注册 /agent/*，运行、审批和记忆入口
	// 都不能由浏览器或直接 API 触发。历史执行、偏好和记忆数据保留在本地数据库，
	// 不做破坏性迁移；替换内核落地时再设计新的入口契约。
	RegisterCreationRoutes(api, svc)
	RegisterCreationConversationRoutes(api, svc, dependencies.Conversations)
	RegisterChannelModelRoutes(api, svc)
	RegisterCustomRelayRoutes(api, svc)
	RegisterTaskRoutes(api, svc, false)
	var (
		skillsDomain   *skills.Service
		canvasDomain   *canvas.Service
		promptDomain   *prompts.Service
		assetLibrary   *asset.Library
		resourceDomain *asset.Service
		playbackDomain *localplayback.Service
		dataDir        string
	)
	if svc != nil {
		skillsDomain = svc.SkillsDomain()
		canvasDomain = svc.CanvasService()
		promptDomain = svc.PromptService()
		assetLibrary = svc.AssetLibraryService()
		resourceDomain = svc.ResourceService()
		playbackDomain = svc.PlaybackService()
		dataDir = svc.DataDir()
	}
	RegisterDesktopSkillRoutes(api, svc, skillsDomain)
	RegisterDesktopUserDataRoutes(api, svc, canvasDomain, promptDomain, assetLibrary, resourceDomain, playbackDomain, svc, svc, svc)
	// 登记表在进程内单实例（避免每请求新建导致并发丢记录）。
	// 凭据管理属于组合根职责：路由注册不产生文件副作用。
	clients := agentops.NewClientRegistry(dataDir)
	// 统一操作层：CLI、MCP 与内置 pi 共用同一组操作与校验，连同一个运行中的工作区。
	if svc != nil {
		if db := svc.Database(); db != nil {
			RegisterAgentOpsRoutes(api, svc, agentops.NewStore(db), clients)
		}
	}
	// 内置创作助手：短期限 UI 会话凭据 + 可信代理；浏览器不接触 owner/宿主/模型凭据。
	uiSessions := newUISessionStore()
	RegisterAgentUISessionRoutes(api, svc, uiSessions, dependencies.DesktopTrust)
	// 外部 Agent 凭据的签发与吊销：只有受信任的桌面界面能进，外部客户端拿不到桌面启动令牌。
	RegisterAgentClientRoutes(api, svc, clients, dependencies.DesktopTrust)
	RegisterAgentProxyRoutes(api, svc, clients, uiSessions, dependencies.AssistantHost)
	// 宿主生命周期：配置当前文本模型与启动命令，显式启停；未配置时返回明确未就绪。
	RegisterAgentHostLifecycleRoutes(api, svc, dependencies.AssistantHost)
	RegisterChunkedUploadRoutes(api, svc, false)
	RegisterDiagnosticsRoutes(api, svc)
	RegisterPluginRoutes(api, svc, false)
	projectAPI := api.Group("")
	projectAPI.Use(RequireFeature(svc, app.FeatureShortDrama))
	registerShortDramaRoutes(projectAPI, svc)
}

// registerShortDramaRoutes groups the routes gated by the short-drama feature.
func registerShortDramaRoutes(r *gin.RouterGroup, svc CanvasAPIService) {
	var (
		promptDomain  *prompts.Service
		projectDomain *localproject.Service
	)
	if isNilService(svc) {
		svc = nil
	} else {
		promptDomain = svc.PromptService()
		projectDomain = svc.ProjectService()
	}
	RegisterStyleProfileRoutes(r, svc, promptDomain)
	registerCanvasProductionRoutes(r, svc)
	RegisterProjectRoutes(r, svc, projectDomain, svc)
}

func RegisterOpenAPIRoutes(api *gin.RouterGroup) {
	api.GET("/openapi.yaml", func(c *gin.Context) {
		c.Data(http.StatusOK, "application/yaml; charset=utf-8", openAPISpec)
	})
}
