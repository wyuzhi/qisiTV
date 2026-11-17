package handler

import (
	"net/http"

	localproject "infinite-canvas/backend/internal/project"

	"github.com/gin-gonic/gin"
)

func registerProjectShotAndWorkflowRoutes(r *gin.RouterGroup, owners workspaceOwners, projects *localproject.Service) {
	r.POST("/projects/:id/workflows", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req struct {
			UnitID string `json:"unitId"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		workflow, err := projects.CreateUnitWorkflow(user.ID, c.Param("id"), req.UnitID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"workflow": workflow})
	})
	r.PATCH("/projects/:id/workflow-steps/:stepId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req localproject.UpdateWorkflowStepRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		step, err := projects.UpdateWorkflowStep(user.ID, c.Param("id"), c.Param("stepId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"step": step})
	})
	r.POST("/projects/:id/workflow-steps/:stepId/task-output", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req localproject.RegisterTaskOutputRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		step, err := projects.RegisterTaskOutput(user.ID, c.Param("id"), c.Param("stepId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"step": step})
	})
	r.POST("/projects/:id/shots", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req localproject.CreateProjectShotRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		shot, err := projects.CreateProjectShot(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"shot": shot})
	})
	r.PUT("/projects/:id/units/:unitId/shots", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
		var req localproject.ReplaceProjectUnitShotsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		shots, err := projects.ReplaceProjectUnitShots(user.ID, c.Param("id"), c.Param("unitId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"shots": shots})
	})
	r.POST("/projects/:id/shots/:shotId/revisions", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req localproject.ShotRevisionInput
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		shot, revision, err := projects.CreateShotRevision(user.ID, c.Param("id"), c.Param("shotId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"shot": shot, "revision": revision})
	})
	r.DELETE("/projects/:id/shots/:shotId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		if err := projects.DeleteProjectShot(user.ID, c.Param("id"), c.Param("shotId")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"deleted": true})
	})
	r.POST("/projects/:id/shots/:shotId/assets", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req localproject.LinkShotAssetRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		reference, err := projects.LinkShotAsset(user.ID, c.Param("id"), c.Param("shotId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"reference": reference})
	})
	r.DELETE("/projects/:id/shots/:shotId/assets/:referenceId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		if err := projects.UnlinkShotAsset(user.ID, c.Param("id"), c.Param("shotId"), c.Param("referenceId")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"unlinked": true})
	})
}
