package handler

import (
	"errors"
	"net/http"
	"time"

	"qisitv/backend/internal/beefapi"
	"qisitv/backend/internal/kernel"

	"github.com/gin-gonic/gin"
)

// beefAPIConnections resolves the local workspace and the managed connection.
// A nil connection is still reported as not initialized.
type beefAPIConnections interface {
	IsLocalMode() bool
	BeefAPI() *beefapi.Service
}

func RegisterBeefAPIConnectionRoutes(r *gin.RouterGroup, connections beefAPIConnections) {
	r.POST("/beefapi/connection/models", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, connections); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		if !enforceRateLimit(c, "beefapi-models", 30, time.Minute) {
			return
		}
		connection, err := requestBeefAPI(c, connections)
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
	r.GET("/beefapi/connection", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, connections); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		connection, err := requestBeefAPI(c, connections)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, connection.Status())
	})
	r.POST("/beefapi/connection/start", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, connections); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		if !enforceRateLimit(c, "beefapi-start", 10, time.Minute) {
			return
		}
		connection, err := requestBeefAPI(c, connections)
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
	r.POST("/beefapi/connection/cancel", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, connections); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		connection, err := requestBeefAPI(c, connections)
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
	r.POST("/beefapi/connection/disconnect", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, connections); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		connection, err := requestBeefAPI(c, connections)
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
	r.POST("/beefapi/connection/open-wallet", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, connections); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		connection, err := requestBeefAPI(c, connections)
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

func requestBeefAPI(c *gin.Context, connections beefAPIConnections) (*beefapi.Service, error) {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.BeefAPI != nil {
		return dependencies.BeefAPI, nil
	}
	if connections != nil {
		if connection := connections.BeefAPI(); connection != nil {
			return connection, nil
		}
	}
	return nil, errors.New("企业连接服务尚未初始化")
}
