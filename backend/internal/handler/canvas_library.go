package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"

	"github.com/gin-gonic/gin"
)

// canvasDrawingJSONEnvelopeSlackBytes is the HTTP slack for {"drawing":...}
// around a snapshot already bounded by StructuredDataMB. It is not a new cap.
const canvasDrawingJSONEnvelopeSlackBytes = 64 << 10

// canvasLibraryWrites are the folder and drawing mutations that open their
// transaction at the composition root. Reads go straight to the canvas service.
type canvasLibraryWrites interface {
	runtimePolicies
	UpsertUserCanvasFolder(userID, id string, raw json.RawMessage) (model.CanvasLibraryFolder, error)
	DeleteUserCanvasFolder(userID, id string) error
	UpsertUserCanvasDrawing(userID, canvasID, drawingID string, raw json.RawMessage) (canvas.CanvasDrawingDocument, error)
	DeleteUserCanvasDrawing(userID, canvasID, drawingID string) error
}

func registerCanvasLibraryRoutes(r *gin.RouterGroup, owners workspaceOwners, canvasData *canvas.Service, writes canvasLibraryWrites) {
	r.GET("/canvas-folders", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		folders, err := canvasData.UserCanvasFolders(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"folders": folders})
	})
	r.PUT("/canvas-folders/:id", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, writes)
		if !available || !enforceRateLimit(c, "canvas-write:"+user.ID, policy.Request.CanvasWritePerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8<<10)
		var req struct {
			Folder json.RawMessage `json:"folder"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		var identity struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(req.Folder, &identity) != nil {
			fail(c, http.StatusBadRequest, kernel.BadAuthRequest("文件夹数据格式错误"))
			return
		}
		if identity.ID != "" && identity.ID != c.Param("id") {
			fail(c, http.StatusBadRequest, kernel.BadAuthRequest("文件夹 ID 与请求路径不一致"))
			return
		}
		folder, err := writes.UpsertUserCanvasFolder(user.ID, c.Param("id"), req.Folder)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"folder": folder})
	})
	r.DELETE("/canvas-folders/:id", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		if err := writes.DeleteUserCanvasFolder(user.ID, c.Param("id")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("id")})
	})
	r.GET("/canvas-projects/:id/drawings", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		drawings, err := canvasData.UserCanvasDrawings(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"drawings": drawings})
	})
	r.GET("/canvas-projects/:id/drawings/:drawingId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		drawing, err := canvasData.UserCanvasDrawing(user.ID, c.Param("id"), c.Param("drawingId"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"drawing": drawing})
	})
	r.PUT("/canvas-projects/:id/drawings/:drawingId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, writes)
		if !available || !enforceRateLimit(c, "canvas-write:"+user.ID, policy.Request.CanvasWritePerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, (policy.Resource.StructuredDataMB<<20)+canvasDrawingJSONEnvelopeSlackBytes)
		var req struct {
			Drawing json.RawMessage `json:"drawing"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				failService(c, kernel.QuotaExceeded(fmt.Sprintf("账号画布和素材数据已达到 %dMB 上限，请先删除不需要的内容", policy.Resource.StructuredDataMB)))
				return
			}
			fail(c, http.StatusBadRequest, kernel.BadAuthRequest("画板数据格式错误"))
			return
		}
		drawing, err := writes.UpsertUserCanvasDrawing(user.ID, c.Param("id"), c.Param("drawingId"), req.Drawing)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"drawing": drawing})
	})
	r.DELETE("/canvas-projects/:id/drawings/:drawingId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		if err := writes.DeleteUserCanvasDrawing(user.ID, c.Param("id"), c.Param("drawingId")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("drawingId")})
	})
}
