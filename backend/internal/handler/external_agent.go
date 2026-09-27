package handler

import (
	"encoding/json"
	"errors"
	"github.com/gin-gonic/gin"
	"io"
	"net/http"
	"qisitv/backend/internal/app"
	"time"
)

func registerExternalAgentRoutes(r *gin.RouterGroup, svc *app.Service) {
	r.GET("/agent/models", func(c *gin.Context) {
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		models, err := svc.ExternalAgentModels()
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"models": models})
	})
	r.POST("/agent/tasks", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, svc)
		if !available || !enforceRateLimit(c, "external-agent-generation:"+user.ID, policy.Request.CanvasWritePerMinute, time.Minute) {
			return
		}
		var req app.ExternalAgentTaskRequest
		if !decodeExternalAgentBody(c, &req) {
			return
		}
		task, nodeID, err := svc.SubmitExternalAgentTask(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"task": task, "canvasId": req.CanvasID, "nodeId": nodeID})
	})
	r.POST("/agent/tasks/:taskId/apply", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var req app.ExternalAgentApplyRequest
		if !decodeExternalAgentBody(c, &req) {
			return
		}
		result, err := svc.ApplyExternalAgentTask(user.ID, c.Param("taskId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
}

func decodeExternalAgentBody(c *gin.Context, value any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		fail(c, http.StatusBadRequest, err)
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		fail(c, http.StatusBadRequest, errors.New("请求必须是单个 JSON 对象"))
		return false
	}
	return true
}
