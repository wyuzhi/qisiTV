package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"qisitv/backend/internal/app"

	"github.com/gin-gonic/gin"
)

func registerCanvasControlRoutes(r *gin.RouterGroup, svc *app.Service) {
	r.POST("/canvas-projects/:id/operations", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, svc)
		if !available || !enforceRateLimit(c, "canvas-write:"+user.ID, policy.Request.CanvasWritePerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 5<<20)
		var req app.CanvasOperationsRequest
		decoder := json.NewDecoder(c.Request.Body)
		decoder.DisallowUnknownFields()
		if err = decoder.Decode(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if err = decoder.Decode(new(any)); err != io.EOF {
			fail(c, http.StatusBadRequest, errors.New("请求必须是单个 JSON 对象"))
			return
		}
		project, err := svc.ApplyCanvasOperations(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"project": project})
	})
	r.PUT("/canvas-projects/:id/interaction", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req app.CanvasInteraction
		if err = c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		interaction, err := svc.PutCanvasInteraction(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"interaction": interaction})
	})
	read := func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		interaction, err := svc.GetCanvasInteraction(user.ID, c.Param("id"), c.Query("tabId"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"interaction": interaction})
	}
	r.GET("/canvas-interaction", read)
	r.GET("/canvas-projects/:id/interaction", read)
}
