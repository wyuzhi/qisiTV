package handler

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

type videoSubtitleEraseService interface {
	workspaceOwners
	runtimePolicies
	RecoverVideoSubtitleErase(ctx context.Context, user, id string) (*model.Task, error)
	VideoSubtitleEraseCapabilities(ctx context.Context) map[string]any
	EstimateVideoSubtitleErase(ctx context.Context, user string, request generation.SubtitleEraseRequest) (map[string]any, error)
	CreateVideoSubtitleErase(ctx context.Context, user string, request generation.SubtitleEraseRequest) (*model.Task, error)
}

func registerVideoSubtitleEraseRoutes(r *gin.RouterGroup, svc videoSubtitleEraseService) {
	r.POST("/video-subtitle-erase/tasks/:id/recover", func(c *gin.Context) {
		if !requireTrustedDesktopWritePrincipal(c, "原任务恢复只能由当前桌面界面发起") {
			return
		}
		user, e := currentUser(c, svc)
		if e != nil {
			failService(c, e)
			return
		}
		task, e := svc.RecoverVideoSubtitleErase(c.Request.Context(), user.ID, c.Param("id"))
		if e != nil {
			failService(c, e)
			return
		}
		ok(c, task)
	})
	r.GET("/video-subtitle-erase/capabilities", func(c *gin.Context) {
		if _, e := currentUser(c, svc); e != nil {
			failService(c, e)
			return
		}
		ok(c, svc.VideoSubtitleEraseCapabilities(c.Request.Context()))
	})
	for _, path := range []string{"estimate", "tasks"} {
		action := path
		r.POST("/video-subtitle-erase/"+action, func(c *gin.Context) {
			if !requireTrustedDesktopWritePrincipal(c, "视频智能擦除只能由当前桌面界面发起") {
				return
			}
			user, e := currentUser(c, svc)
			if e != nil {
				failService(c, e)
				return
			}
			policy, available := loadRuntimePolicy(c, svc)
			if !available || !enforceRateLimit(c, "video-subtitle-erase:"+user.ID, policy.Request.TaskCreatePerMinute, time.Minute) {
				return
			}
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
			var req generation.SubtitleEraseRequest
			if e = c.ShouldBindJSON(&req); e != nil {
				fail(c, http.StatusBadRequest, e)
				return
			}
			if e = generation.ValidateSmartEraseRequestCapabilities(&req, svc.VideoSubtitleEraseCapabilities(c.Request.Context())); e != nil {
				failService(c, e)
				return
			}
			if action == "estimate" {
				value, e := svc.EstimateVideoSubtitleErase(c.Request.Context(), user.ID, req)
				if e != nil {
					failService(c, e)
					return
				}
				ok(c, value)
				return
			}
			task, e := svc.CreateVideoSubtitleErase(c.Request.Context(), user.ID, req)
			if e != nil {
				failService(c, e)
				return
			}
			ok(c, task)
		})
	}
}
