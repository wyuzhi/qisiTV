package handler

import (
	"errors"
	"net/http"
	"time"

	"qisitv/backend/internal/beeftv"
	"qisitv/backend/internal/kernel"

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
		if c.Query("refresh") == "1" {
			if !enforceRateLimit(c, "beeftv-balance", 30, time.Minute) {
				return
			}
			summary, refreshErr := connection.RefreshBalance(c.Request.Context())
			if refreshErr != nil {
				failService(c, refreshErr)
				return
			}
			ok(c, summary)
			return
		}
		ok(c, connection.Status())
	})
	r.GET("/beeftv/connection/topup/info", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, connections); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		if !enforceRateLimit(c, "beeftv-topup-info", 60, time.Minute) {
			return
		}
		connection, err := requestBeefTV(c, connections)
		if err != nil {
			failService(c, err)
			return
		}
		info, err := connection.TopUpInfo(c.Request.Context())
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, info)
	})
	r.POST("/beeftv/connection/topup/checkout", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, connections); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		if !enforceRateLimit(c, "beeftv-topup-checkout", 20, time.Minute) {
			return
		}
		connection, err := requestBeefTV(c, connections)
		if err != nil {
			failService(c, err)
			return
		}
		var req beeftv.TopUpCheckoutInput
		if err := c.ShouldBindJSON(&req); err != nil {
			failService(c, kernel.BadAuthRequest("充值参数格式无效"))
			return
		}
		result, err := connection.StartTopUpCheckout(c.Request.Context(), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.POST("/beeftv/connection/topup/reconcile", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, connections); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		if !enforceRateLimit(c, "beeftv-topup-reconcile", 60, time.Minute) {
			return
		}
		connection, err := requestBeefTV(c, connections)
		if err != nil {
			failService(c, err)
			return
		}
		var req struct {
			TradeNo string `json:"tradeNo"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			failService(c, kernel.BadAuthRequest("充值订单号格式无效"))
			return
		}
		result, err := connection.ReconcileTopUp(c.Request.Context(), req.TradeNo)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
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
