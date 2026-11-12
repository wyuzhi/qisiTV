package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/creation"
)

type creationRouteService interface {
	workspaceOwners
	Creation() *creation.Service
}

func RegisterCreationRoutes(r *gin.RouterGroup, svc creationRouteService) {
	read := func(action string) gin.HandlerFunc {
		return func(c *gin.Context) {
			user, err := currentUser(c, svc)
			if err != nil {
				failService(c, err)
				return
			}
			var value any
			switch action {
			case "list":
				value, err = svc.Creation().List(user.ID)
			case "get":
				value, err = svc.Creation().Get(user.ID, c.Param("id"))
			case "snapshot":
				value, err = svc.Creation().CanvasSnapshot(user.ID, c.Param("id"))
			}
			if err != nil {
				failService(c, err)
				return
			}
			ok(c, value)
		}
	}
	write := func(action string) gin.HandlerFunc {
		return func(c *gin.Context) {
			if !requireCreationWritePrincipal(c) {
				return
			}
			user, err := currentUser(c, svc)
			if err != nil {
				failService(c, err)
				return
			}
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, max(int64(agentOpsMaxBody), canvas.EffectiveRequestMaxBodyBytes()))
			var req creation.Command
			if err = c.ShouldBindJSON(&req); err != nil {
				fail(c, http.StatusBadRequest, err)
				return
			}
			value, err := svc.Creation().Dispatch(user.ID, c.Param("id"), action, req)
			if err != nil {
				failService(c, err)
				return
			}
			ok(c, value)
		}
	}
	r.GET("/creation-runs", read("list"))
	r.POST("/creation-runs", write("create"))
	r.GET("/creation-runs/:id", read("get"))
	r.PATCH("/creation-runs/:id", write("save"))
	for _, action := range []string{"claim", "heartbeat", "release", "proposal-approve", "proposal-invalidate"} {
		r.POST("/creation-runs/:id/"+action, write(action))
	}
	r.POST("/creation-runs/:id/submissions/prepare", write("prepare"))
	r.POST("/creation-runs/:id/submissions/approve", write("approve"))
	r.POST("/creation-runs/:id/execute", write("execute"))
	r.POST("/creation-runs/:id/canvas", write("canvas"))
	r.GET("/creation-runs/:id/canvas-snapshot", read("snapshot"))
	r.POST("/creation-runs/:id/canvas-commit", write("commit"))
}

// requireCreationWritePrincipal binds the existing desktop UI capability.
// JSON owner is a lease identity after this trusted call, not a caller role.
func requireCreationWritePrincipal(c *gin.Context) bool {
	return requireTrustedDesktopWritePrincipal(c, "创作操作只能由当前桌面界面完成")
}
