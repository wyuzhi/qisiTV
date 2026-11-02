package handler

import (
	"context"
	"net/http"

	"qisitv/backend/internal/app"

	"github.com/gin-gonic/gin"
)

// runningHubWorkflows reads RunningHub workflow metadata. The fetch itself
// stays in the composition root.
type runningHubWorkflows interface {
	workspaceOwners
	RequireWorkflowPluginForUser(userID string, interfaceType string) error
	FetchRunningHubAppInfo(ctx context.Context, req app.RunningHubWorkflowFetchRequest) (map[string]any, error)
	FetchRunningHubWorkflowInfo(ctx context.Context, req app.RunningHubWorkflowFetchRequest) (map[string]any, error)
}

// RegisterRunningHubRoutes 是独立工作流 Provider 的管理代理，不复用 ModelChannel。
func RegisterRunningHubRoutes(r *gin.RouterGroup, workflows runningHubWorkflows, hostedProfile ...bool) {
	if len(hostedProfile) > 0 && !hostedProfile[0] {
		return
	}
	fetch := func(c *gin.Context, isApp bool) {
		user, err := currentUser(c, workflows)
		if err != nil {
			failService(c, err)
			return
		}
		if err := workflows.RequireWorkflowPluginForUser(user.ID, "runninghub-workflow-image"); err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 128<<10)
		var req app.RunningHubWorkflowFetchRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		var result map[string]any
		if isApp {
			result, err = workflows.FetchRunningHubAppInfo(c.Request.Context(), req)
		} else {
			result, err = workflows.FetchRunningHubWorkflowInfo(c.Request.Context(), req)
		}
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	}
	r.POST("/runninghub/workflow-info", func(c *gin.Context) { fetch(c, false) })
	r.POST("/runninghub/app-info", func(c *gin.Context) { fetch(c, true) })
}
