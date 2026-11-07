package handler

import (
	"errors"
	"net/http"
	"time"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/kernel"

	"github.com/gin-gonic/gin"
)

// beefTVConnections resolves the local workspace and the managed connection.
// A nil connection is still reported as not initialized.
type beefTVConnections interface {
	IsLocalMode() bool
	BeefTV() *beeftv.Service
}

func RegisterBeefTVConnectionRoutes(r *gin.RouterGroup, connections beefTVConnections) {
	r.POST("/beeftv/connection/models", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, connections); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		if !enforceRateLimit(c, "beeftv-models", 30, time.Minute) {
			return
		}
		connection, err := requestBeefTV(c, connections)
		if err != nil {
			failService(c, err)
			return
		}
		models, err := connection.RefreshCatalog(c.Request.Context())
		if err != nil {
			failService(c, kernel.BadAuthRequest(err.Error()))
			return
		}
		ok(c, gin.H{"models": models})
	})
	r.GET("/beeftv/connection", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, connections); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		connection, err := requestBeefTV(c, connections)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, connection.Status())
	})
	r.POST("/beeftv/connection/start", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, connections); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		if !enforceRateLimit(c, "beeftv-start", 10, time.Minute) {
			return
		}
		connection, err := requestBeefTV(c, connections)
		if err != nil {
			failService(c, err)
			return
		}
		summary, err := connection.Start(c.Request.Context())
		if err != nil && summary.State == "" {
			failService(c, kernel.BadAuthRequest(err.Error()))
			return
		}
		ok(c, summary)
	})
	r.POST("/beeftv/connection/cancel", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, connections); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		connection, err := requestBeefTV(c, connections)
		if err != nil {
			failService(c, err)
			return
		}
		summary, err := connection.Cancel(c.Request.Context())
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, summary)
	})
	r.POST("/beeftv/connection/disconnect", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, connections); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		connection, err := requestBeefTV(c, connections)
		if err != nil {
			failService(c, err)
			return
		}
		summary, err := connection.Disconnect(c.Request.Context())
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, summary)
	})
	r.POST("/beeftv/connection/open-wallet", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, connections); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		connection, err := requestBeefTV(c, connections)
		if err != nil {
			failService(c, err)
			return
		}
		if err := connection.OpenWallet(); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"opened": true})
	})
}

func requestBeefTV(c *gin.Context, connections beefTVConnections) (*beeftv.Service, error) {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.BeefTV != nil {
		return dependencies.BeefTV, nil
	}
	if connections != nil {
		if connection := connections.BeefTV(); connection != nil {
			return connection, nil
		}
	}
	return nil, errors.New("企业连接服务尚未初始化")
}
