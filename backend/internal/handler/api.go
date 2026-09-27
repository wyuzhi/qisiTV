package handler

import (
	"net/http"

	"qisitv/backend/internal/app"

	"github.com/gin-gonic/gin"
)

// RegisterCanvasAPI is kept as the standalone-development entrypoint. qisiTV
// has one local-only HTTP surface, so development and Wails use the same route
// graph instead of selecting between desktop and SaaS profiles at runtime.
func RegisterCanvasAPI(api *gin.RouterGroup, svc *app.Service) {
	registerDesktopCanvasAPI(api, svc, defaultRuntimeDependencies(svc))
}

// RegisterDesktopCanvasAPI keeps the desktop profile local-first. The server
// profile still exposes hosted routes for backward compatibility.
func RegisterDesktopCanvasAPI(api *gin.RouterGroup, svc *app.Service) {
	RegisterDesktopCanvasAPIWithDependencies(api, svc, defaultRuntimeDependencies(svc))
}

func defaultRuntimeDependencies(svc *app.Service) RuntimeDependencies {
	adapter := newServiceRuntimeAdapter(svc)
	return RuntimeDependencies{RequestCoordinator: adapter, ProviderConfig: adapter, Assets: adapter, Projects: adapter, Tasks: adapter, Generation: adapter}
}

func RegisterDesktopCanvasAPIWithDependencies(api *gin.RouterGroup, svc *app.Service, dependencies RuntimeDependencies) {
	registerDesktopCanvasAPI(api, svc, dependencies)
}

// registerDesktopCanvasAPI is deliberately a separate call graph. Keeping the
// local composition root free of runtime profile branches lets the Go linker
// discard hosted handlers and their SaaS-only service methods from qisiTV.
func registerDesktopCanvasAPI(api *gin.RouterGroup, svc *app.Service, dependencies RuntimeDependencies) {
	api.Use(RuntimeDependenciesMiddleware(dependencies))
	RegisterOpenAPIRoutes(api)
	RegisterWorkspaceRoutes(api, svc)
	RegisterBeefAPIConnectionRoutes(api, svc)
	RegisterDesktopAppearanceRoutes(api, svc)
	RegisterDesktopFeatureAvailabilityRoutes(api, svc)
	RegisterAgentRoutes(api, svc)
	RegisterAgentMemoryRoutes(api, svc)
	RegisterCreationRoutes(api, svc)
	RegisterChannelModelRoutes(api, svc)
	RegisterCustomRelayRoutes(api, svc)
	RegisterTaskRoutes(api, svc, false)
	RegisterRunningHubRoutes(api, svc, false)
	RegisterDesktopSkillRoutes(api, svc)
	RegisterDesktopUserDataRoutes(api, svc)
	RegisterChunkedUploadRoutes(api, svc, false)
	RegisterDiagnosticsRoutes(api, svc)
	RegisterPluginRoutes(api, svc, false)
	projectAPI := api.Group("")
	projectAPI.Use(RequireFeature(svc, app.FeatureShortDrama))
	RegisterProjectRoutes(projectAPI, svc)
}

func RegisterOpenAPIRoutes(api *gin.RouterGroup) {
	api.GET("/openapi.yaml", func(c *gin.Context) {
		c.Data(http.StatusOK, "application/yaml; charset=utf-8", openAPISpec)
	})
}
