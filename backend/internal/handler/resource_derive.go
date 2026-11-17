package handler

import (
	"context"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"qisitv/backend/internal/app"
	"qisitv/backend/internal/asset"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/mediatools"
)

const resourceDeriveBodyCapJSON = 8 << 10

func registerResourceDeriveRoutes(r *gin.RouterGroup, owners workspaceOwners, resources *asset.Service, usage userDataUsage) {
	r.POST("/resources/:id/frames", func(c *gin.Context) {
		if err := c.Request.Context().Err(); err != nil {
			writeDeriveFailure(c, err)
			return
		}
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, usage)
		if !available || !enforceRateLimit(c, "resources-upload:"+user.ID, policy.Request.ResourceUploadPerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, resourceDeriveBodyCapJSON)
		var req asset.ExtractVideoFramesRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, kernel.BadAuthRequest("请填写有效的截帧参数"))
			return
		}
		result, err := resources.ExtractVideoFrames(c.Request.Context(), user.ID, c.Param("id"), req, c.GetHeader("X-Idempotency-Key"))
		if err != nil {
			writeDeriveFailure(c, err)
			return
		}
		ok(c, result)
	})

	r.POST("/resources/:id/separate-audio", func(c *gin.Context) {
		if err := c.Request.Context().Err(); err != nil {
			writeDeriveFailure(c, err)
			return
		}
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, usage)
		if !available || !enforceRateLimit(c, "resources-upload:"+user.ID, policy.Request.ResourceUploadPerMinute, time.Minute) {
			return
		}
		result, err := resources.SeparateVideoAudio(c.Request.Context(), user.ID, c.Param("id"), c.GetHeader("X-Idempotency-Key"))
		if err != nil {
			writeDeriveFailure(c, err)
			return
		}
		ok(c, result)
	})
}

func writeDeriveFailure(c *gin.Context, err error) {
	if errors.Is(err, context.Canceled) {
		writeFailure(c, 499, 499, "request_cancelled", "媒体处理已取消")
		return
	}
	if errors.Is(err, context.DeadlineExceeded) {
		writeFailure(c, http.StatusRequestTimeout, http.StatusRequestTimeout, kernel.ReasonTimeout, "媒体处理超时，请稍后重试")
		return
	}
	var appErr *app.AppError
	if errors.As(err, &appErr) && appErr != nil && mediatools.IsPreRedactedDiagnostic(appErr.Cause) {
		method := ""
		route := ""
		if c != nil && c.Request != nil {
			method = c.Request.Method
			route = c.FullPath()
			if route == "" {
				route = "<unmatched>"
			}
		}
		log.Printf(
			"resource media derive failed: method=%s route=%s status=%d reason=%s detail=%s",
			method,
			route,
			appErr.Status,
			appErr.Reason,
			mediatools.RedactDiagnosticText(appErr.Cause.Error()),
		)
	}
	failService(c, err)
}
